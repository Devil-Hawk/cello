import { describe, expect, it } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import { buildDisclosure, disclosureLine, ranFromRows, turnCost } from './disclosure'

const ran = { rung: 'R3' as const, model: 'x:free', effort: 'low' as const }

describe('turnCost', () => {
  it('is the sum of the turn\'s own ledger rows: settled amount, else the held estimate', async () => {
    const db = makeFakeAdmin({
      llm_spend: [
        { user_id: 'u1', chat_turn_id: 't1', estimate_usd: '0.02', actual_usd: '0.015' },
        { user_id: 'u1', chat_turn_id: 't1', estimate_usd: '0.03', actual_usd: null },
        { user_id: 'u1', chat_turn_id: 't2', estimate_usd: '9', actual_usd: '9' },
        { user_id: 'u2', chat_turn_id: 't1', estimate_usd: '9', actual_usd: '9' },
      ],
    })
    expect(await turnCost(db, 'u1', 't1')).toBe(0.045)
  })

  it('is zero for a free turn, whose rows are $0', async () => {
    const db = makeFakeAdmin({ llm_spend: [0, 0, 0].map(() => ({ user_id: 'u1', chat_turn_id: 't1', estimate_usd: 0, actual_usd: 0 })) })
    expect(await turnCost(db, 'u1', 't1')).toBe(0)
  })
})

describe('buildDisclosure', () => {
  it('lists the turn\'s workers with their read counts and the time between start and end', async () => {
    const db = makeFakeAdmin({
      agent_tasks: [
        { user_id: 'u1', turn_id: 't1', title: 'Research Ramp', status: 'done', reads: [{}, {}, {}], created_at: '2026-10-06T10:00:00Z' },
        { user_id: 'u1', turn_id: 't1', title: 'Research Linear', status: 'stopped', reads: [], created_at: '2026-10-06T10:00:01Z' },
        { user_id: 'u1', turn_id: 't2', title: 'Other turn', status: 'done', reads: [{}], created_at: '2026-10-06T10:00:02Z' },
      ],
      llm_spend: [],
    })
    const d = await buildDisclosure(db, 'u1', 't1', {
      ran,
      tools: [{ label: 'Open company', object: 'Ramp' }],
      sources: [{ title: 'Careers', host: 'ramp.com' }],
      startedAt: new Date('2026-10-06T10:00:00Z'),
      endedAt: new Date('2026-10-06T10:00:41Z'),
    })
    expect(d.workers).toEqual([
      { title: 'Research Ramp', status: 'done', reads: 3 },
      { title: 'Research Linear', status: 'stopped', reads: 0 },
    ])
    expect(d).toMatchObject({ seconds: 41, costUsd: 0, ran })
    expect(disclosureLine(d)).toBe('1 source, 1 tool, 2 tasks. 0:41. Free.')
  })
})

describe('disclosureLine', () => {
  it('says what a paid turn cost', () => {
    const base = { sources: [], tools: [], workers: [], seconds: 125 }
    expect(disclosureLine({ ...base, costUsd: 0.0449 })).toBe('0 sources, 0 tools, 0 tasks. 2:05. $0.04.')
    expect(disclosureLine({ ...base, costUsd: 0.004 })).toContain('Under $0.01')
  })
})

describe('ranFromRows', () => {
  const chosen = { rung: 'R3' as const, model: 'google/gemma-4-31b-it:free', effort: 'medium' as const }
  it('names the model that answered from the ledger, and none for a code-only turn', async () => {
    const db = makeFakeAdmin({
      llm_spend: [
        { user_id: 'u1', chat_turn_id: 't1', model: 'google/gemma-4-31b-it:free', rung: 'R3', status: 'settled', failed_status: 404, created_at: '2026-10-12T10:00:00Z' },
        { user_id: 'u1', chat_turn_id: 't1', model: 'laguna/laguna-s-2.1:free', rung: 'R3', status: 'settled', failed_status: null, created_at: '2026-10-12T10:00:01Z' },
        { user_id: 'u1', chat_turn_id: 't1', model: 'x/dropped:free', rung: 'R3', status: 'reserved', failed_status: null, created_at: '2026-10-12T10:00:02Z' },
        { user_id: 'u1', chat_turn_id: 't2', model: 'other/turn:free', rung: 'R3', status: 'settled', failed_status: null, created_at: '2026-10-12T10:00:03Z' },
      ],
    })
    expect(await ranFromRows(db, 'u1', 't1', chosen)).toEqual({ ...chosen, model: 'laguna/laguna-s-2.1:free', steppedDown: { wanted: chosen, why: 'model' } })
    expect(await ranFromRows(db, 'u1', 't3', chosen)).toBeNull()
  })

  it('keeps the choice as it is when the chosen model answered', async () => {
    const db = makeFakeAdmin({ llm_spend: [{ user_id: 'u1', chat_turn_id: 't1', model: chosen.model, rung: 'R3', status: 'settled', failed_status: null, created_at: '2026-10-12T10:00:00Z' }] })
    expect(await ranFromRows(db, 'u1', 't1', chosen)).toBe(chosen)
  })
})
