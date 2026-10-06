import { describe, expect, it, vi } from 'vitest'
import { makeFakeAdmin, type FakeAdmin } from '@/lib/agents/testing/fake-admin'
import type { ModelAnswer } from './answer'
import { inMemoryStore } from './memory.fake'
import { runChatTurn, type AgentInput, type AgentOutput, type TurnDeps } from './turn'
import { refId, type ObjectReader } from './types'

// The default reader loads the scoring module; every test here passes its own.
vi.mock('./objects', () => ({ getObject: vi.fn() }))

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ROLES = [
  { id: uuid(1), title: 'Payments role', company: 'Vantage Loom', pay: '$190,000' },
  { id: uuid(2), title: 'Query role', company: 'Northwind Atlas', pay: '$215,000' },
  { id: uuid(3), title: 'Platform role', company: 'Larkspur Robotics', pay: '$165,000' },
]
const get: ObjectReader = async (_db, userId, kind, ref) => {
  const role = ROLES.find((r) => r.id === refId(kind, ref))
  return userId === 'u1' && role ? { kind, id: role.id, title: role.title, company: role.company, facts: [`Pay as stated: ${role.pay}`], body: null } : null
}

const seed = (): FakeAdmin =>
  makeFakeAdmin({
    chats: [
      { id: 'c1', user_id: 'u1', title: '' },
      { id: 'c2', user_id: 'u2', title: 'Theirs' },
    ],
    chat_turns: [],
    chat_attachments: ROLES.map((r, i) => ({ id: `a${i}`, user_id: 'u1', chat_id: 'c1', kind: 'role', ref: { id: r.id }, position: i + 1, removed_at: null })),
    agent_tasks: [],
    llm_spend: [],
  })

/** The fixture model: one part per tile, each stating that tile's pay, from what its tool returned. */
const resultsOf = () => ROLES.map((r) => ({ object: { kind: 'role' as const, ref: r.id }, text: `${r.title} at ${r.company}. Pay as stated: ${r.pay}.` }))
const answerFor = (pays: string[]): ModelAnswer => ({ parts: ROLES.map((r, i) => ({ about: [{ kind: 'role' as const, id: r.id }], text: `${r.title} states ${pays[i]}.` })) })
const ran = { rung: 'R3' as const, model: 'x:free', effort: 'low' as const }

const deps = (db: FakeAdmin, agent: TurnDeps['agent'], extra: Partial<TurnDeps> = {}): TurnDeps => ({ db, agent, get, ...extra })
const send = (d: TurnDeps, typed = 'Which of these pays most?', extra: Record<string, unknown> = {}) => runChatTurn(d, { userId: 'u1', chatId: 'c1', typed, ...extra })

describe('runChatTurn', () => {
  it('answers a chat of three tiles with each part about the right tile', async () => {
    const db = seed()
    const agent = vi.fn(async (): Promise<AgentOutput> => ({ answer: answerFor(['$190,000', '$215,000', '$165,000']), results: resultsOf(), ran }))
    const out = await send(deps(db, agent))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.settled.dropped).toBe(0)
    expect(out.settled.parts.map((p) => ('about' in p ? p.about[0].ref : null))).toEqual(ROLES.map((r) => r.id))
    const cello = db.tables.chat_turns.find((t) => t.kind === 'cello')
    expect(cello).toMatchObject({ origin: 'model', prov: { step: 'chat' }, ran })
    expect((cello?.parts as unknown[]).length).toBe(3)
    expect(cello?.answer).toContain('Query role states $215,000.')
  })

  it('stores the typed words before the agent runs, and the quoted selection apart from them', async () => {
    const db = seed()
    let seen = 0
    const agent = vi.fn(async (): Promise<AgentOutput> => {
      seen = db.tables.chat_turns.filter((t) => t.kind === 'person').length
      return { answer: { parts: [] }, results: [] }
    })
    await send(deps(db, agent), 'do that', { quoted: { text: 'stop showing crypto roles', turn_id: 't0' } })
    expect(seen).toBe(1)
    expect(db.tables.chat_turns[0]).toMatchObject({ kind: 'person', typed: 'do that', origin: 'person', quoted: { text: 'stop showing crypto roles', turn_id: 't0' } })
  })

  it('gives the agent a screen message of the tiles, quoted as data', async () => {
    const db = seed()
    const agent = vi.fn(async (_i: AgentInput): Promise<AgentOutput> => ({ answer: { parts: [] }, results: [] }))
    await send(deps(db, agent))
    const input = agent.mock.calls[0][0]
    expect(input.typed).toBe('Which of these pays most?')
    expect(input.screen).toContain('<untrusted_data source="screen">')
    for (const r of ROLES) expect(input.screen).toContain(`role ${r.id}: ${r.title} (${r.company})`)
    expect(input.feedback).toBeNull()
  })

  it('sends a part with a wrong number back once, and takes the fixed answer', async () => {
    const db = seed()
    const agent = vi
      .fn<[AgentInput], Promise<AgentOutput>>()
      .mockResolvedValueOnce({ answer: answerFor(['$190,000', '$999,999', '$165,000']), results: resultsOf() })
      .mockResolvedValueOnce({ answer: answerFor(['$190,000', '$215,000', '$165,000']), results: [] })
    const out = await send(deps(db, agent))
    expect(agent).toHaveBeenCalledTimes(2)
    expect(agent.mock.calls[1][0].feedback).toContain('Part 2')
    expect(out.ok && out.settled.dropped).toBe(0)
  })

  it('drops a part that fails twice and says so, keeping the rest', async () => {
    const db = seed()
    const agent = vi.fn(async (): Promise<AgentOutput> => ({ answer: answerFor(['$190,000', '$999,999', '$165,000']), results: resultsOf() }))
    const out = await send(deps(db, agent))
    expect(out.ok && out.settled.dropped).toBe(1)
    const cello = db.tables.chat_turns.find((t) => t.kind === 'cello')
    expect((cello?.parts as unknown[]).length).toBe(2)
    expect(String(cello?.answer)).toContain('Cello left out one statement it could not tie to the right role.')
    expect(String(cello?.answer)).not.toContain('999,999')
  })

  it('leaves the person\'s turn and no answer when the model fails, and says nothing was changed', async () => {
    const db = seed()
    const out = await send(deps(db, async () => Promise.reject(new Error('provider down'))))
    expect(out).toMatchObject({ ok: false, error: 'Cello could not finish this. Nothing was changed.' })
    expect(db.tables.chat_turns.map((t) => t.kind)).toEqual(['person'])
  })

  it('refuses another person\'s chat and empty words without storing anything', async () => {
    const db = seed()
    const agent = vi.fn(async (): Promise<AgentOutput> => ({ answer: { parts: [] }, results: [] }))
    expect(await runChatTurn(deps(db, agent), { userId: 'u1', chatId: 'c2', typed: 'hi' })).toMatchObject({ ok: false })
    expect(await send(deps(db, agent), '   ')).toMatchObject({ ok: false })
    expect(db.tables.chat_turns).toHaveLength(0)
    expect(agent).not.toHaveBeenCalled()
  })

  it('titles a new chat from the typed words, cut at 80 characters, and leaves a chosen title alone', async () => {
    const db = seed()
    const agent = async (): Promise<AgentOutput> => ({ answer: { parts: [] }, results: [] })
    await send(deps(db, agent), `  ${'Compare these roles '.repeat(10)}`)
    expect(String(db.tables.chats[0].title)).toHaveLength(80)
    db.tables.chats[0].title = 'My title'
    await send(deps(db, agent), 'second question')
    expect(db.tables.chats[0].title).toBe('My title')
    expect(db.tables.chats[0].last_turn_at).toBeTruthy()
  })

  it('writes the turn\'s memories from its rows, and its disclosure from its own ledger', async () => {
    const db = seed()
    db.tables.llm_spend.push({ user_id: 'u1', chat_turn_id: undefined, estimate_usd: 0, actual_usd: 0 })
    const store = inMemoryStore()
    const agent = async (i: AgentInput): Promise<AgentOutput> => {
      db.tables.llm_spend.push({ user_id: 'u1', chat_turn_id: i.turnId, estimate_usd: '0.02', actual_usd: '0.02' })
      return { answer: { parts: [] }, results: [], ran, tools: [{ label: 'Open role', object: 'Payments role' }], made: [{ id: 'a9', type: 'comparison', title: 'Comparison of 3 roles', created_at: '2026-10-05T10:00:00Z' }] }
    }
    const out = await send(deps(db, agent, { store }))
    expect(out.ok).toBe(true)
    expect(store.items.map((m) => m.metadata?.scope).sort()).toEqual(['chat.made', 'chat.said'])
    expect(store.items.find((m) => m.metadata?.scope === 'chat.said')?.metadata?.attached).toEqual(ROLES.map((r) => r.title))
    const cello = db.tables.chat_turns.find((t) => t.kind === 'cello')
    expect(cello?.disclosure).toMatchObject({ costUsd: 0.02, tools: [{ label: 'Open role', object: 'Payments role' }], ran })
  })

  it('writes no memory for a demo session, and none when no store is given', async () => {
    const db = seed()
    const store = inMemoryStore()
    const agent = async (): Promise<AgentOutput> => ({ answer: { parts: [] }, results: [] })
    await send(deps(db, agent, { store, isDemo: true }))
    await send(deps(db, agent))
    expect(store.items).toHaveLength(0)
  })
})
