import { describe, expect, it } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import type { AdminClient, LlmResult, LlmRunOptions } from '@/lib/harness/types'
import { NO_CONSTRAINTS } from '@/lib/scoring/constraints'
import { buildShortlist } from '@/lib/scoring/pipeline'
import { MemoryStore } from '@/lib/scoring/store'
import type { RoleFacts } from '@/lib/scoring/types'
import { NO_STATED } from '@/lib/scoring/want-judge'
import { picksLive, runScout } from './scout'

const role = (id: string, topic: string, extra: Partial<RoleFacts> = {}): RoleFacts => ({
  id,
  title: `Backend Engineer, ${topic}`,
  company: `Co${id}`,
  location: 'Seattle, WA',
  description: `We build ${topic} products for our customers every day.`,
  ...extra,
})

/** A judge that likes payments. The chance check has nothing to read (no requirements stored), so it says cannot assess. */
const llm = async (opts: LlmRunOptions): Promise<LlmResult> => {
  const blocks = [...(opts.prompt ?? '').matchAll(/\[\[ROLE (a\d+) [^\]]*\]\]\n([^\[]*)/g)]
  const content =
    opts.name === 'judge-role-want'
      ? JSON.stringify({ roles: blocks.map((m) => ({ id: m[1], p: /payments/i.test(m[2]) ? 0.85 : 0.2, reason: 'Matches what you liked.' })) })
      : '{}'
  return { content, tokensUsed: 1, promptTokens: 1, completionTokens: 1, model: 'fake' }
}

const candidates = [...['a', 'b', 'c', 'd'].map((id) => role(id, 'payments')), ...['e', 'f', 'g', 'h'].map((id) => role(id, 'advertising')), role('x', 'payments', { company: 'Coinbase' })]
const request = {
  userId: 'u',
  resumeText: 'Jane Doe\nBackend engineer: built payment services in Go',
  stated: { ...NO_STATED, titles: ['Backend Engineer'] },
  constraints: { ...NO_CONSTRAINTS, excludedCompanies: ['coinbase'] },
  candidates,
  forDate: '2026-10-06',
}

describe('the Scout graph', () => {
  it('sets aside what breaks a stated fact, ranks the rest, and saves the day\'s picks', async () => {
    const store = new MemoryStore()
    const out = await runScout({ llm, embed: null, store, rng: () => 0.5 }, request)
    expect(out.blocked).toEqual([{ jobId: 'x', reasons: [{ kind: 'company', text: 'You ruled out Coinbase.' }] }])
    expect(out.picks.map((p) => p.jobId)).not.toContain('x')
    expect(out.picks.length).toBeGreaterThan(0)
    expect(store.shortlists.get('2026-10-06')).toEqual(out.picks)
  })

  it('makes the same picks as the pipeline it is built over', async () => {
    const viaGraph = await runScout({ llm, embed: null, store: new MemoryStore(), rng: () => 0.5 }, request)
    const direct = await buildShortlist({ llm, embed: null, store: new MemoryStore(), rng: () => 0.5 }, request)
    expect(viaGraph.picks).toEqual(direct.picks)
  })
})

describe('picks_live', () => {
  const admin = (rows: Record<string, unknown>[] | null) => (rows === null ? makeFakeAdmin() : makeFakeAdmin({ instance_flags: rows })) as unknown as AdminClient

  it('is off with no flag table or no row', async () => {
    expect(await picksLive(admin(null))).toBe(false)
    expect(await picksLive(admin([]))).toBe(false)
  })

  it('is on only when the row says on', async () => {
    expect(await picksLive(admin([{ key: 'picks_live', on: true }]))).toBe(true)
    expect(await picksLive(admin([{ key: 'picks_live', on: false }]))).toBe(false)
    expect(await picksLive(admin([{ key: 'other_flag', on: true }]))).toBe(false)
  })

  it('is off when reading the flag fails', async () => {
    const broken = { from: () => { throw new Error('no table') } } as unknown as AdminClient
    expect(await picksLive(broken)).toBe(false)
  })
})
