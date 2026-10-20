import { emptyCheckpoint, MemorySaver } from '@langchain/langgraph'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeAdmin, type FakeAdmin } from '@/lib/agents/testing/fake-admin'
import type { WireEvent } from '@/lib/agents/sse'
import { chatAgent } from './agent'
import { MAX_SLICES, resumeChatTurn, runStoredTurn } from './run'
import { MovedError, finishWorker, openWorker } from './workers'

const order = vi.hoisted(() => [] as string[])
const lease = vi.hoisted(() => ({ claim: vi.fn() }))
const fire = vi.hoisted(() => vi.fn())
const seam = vi.hoisted(() => ({ open: (() => { throw new Error('no checkpointer') }) as () => unknown }))

vi.mock('./agent', () => ({ chatAgent: vi.fn() }))
vi.mock('@/lib/agents/persistence', () => ({ openAgentPersistence: () => seam.open() }))
vi.mock('./route', () => ({ routedAgent: (_deps: unknown, loop: unknown) => loop }))
vi.mock('./objects', () => ({ getObject: vi.fn() }))
vi.mock('./shown', () => ({ recallInWordsOn: async () => false }))
vi.mock('./settings', () => ({
  readSettings: async () => ({ ran: { rung: 'R3', model: 'x:free', effort: 'low' }, roles: {}, mode: { chat: null, settings: 'ask', facts: { sendForMe: false, paused: false, isDemo: false } } }),
}))
vi.mock('@/lib/harness/keys', () => ({ loadApiKeys: async () => ({ userId: 'u1', isDemo: false }) }))
vi.mock('@/lib/memory/mem0-store', () => ({ getMemoryStore: () => null }))
vi.mock('@/lib/agents/profile-card', () => ({ profileCard: async () => 'the card' }))
vi.mock('@/lib/agents/scheduler', () => ({
  claimLease: (...a: unknown[]) => lease.claim(...a),
  renewLease: async () => true,
  releaseLease: async () => void order.push('release'),
  fireContinue: (...a: unknown[]) => {
    order.push('fire')
    return fire(...a)
  },
}))

const ran = { rung: 'R3' as const, model: 'x:free', effort: 'low' as const }
const SLICE_CAP_LINE = 'This took longer than Cello allows for one message, so it stopped. What was done is kept. Ask for the rest in a new message.'
const held = { threadId: 'c1', holder: 'h1' }

const seed = (): FakeAdmin =>
  makeFakeAdmin({
    chats: [{ id: 'c1', user_id: 'u1', title: 'Roles' }],
    chat_turns: [{ id: 't1', user_id: 'u1', chat_id: 'c1', kind: 'person', typed: 'Draft three notes', quoted: null, origin: 'person', created_at: '2026-10-20T10:00:00.000Z' }],
    chat_attachments: [],
    agent_tasks: [],
    llm_spend: [],
    companies: [],
    applications: [],
    person_jobs: [],
  })

/** The root row of a turn that was handed over: still working, with its person turn stored. */
const handedOver = (db: FakeAdmin) => {
  db.tables.agent_tasks.push({ id: 'root1', user_id: 'u1', thread_id: 'c1', chat_id: 'c1', turn_id: 't1', command: 'chat.turn', title: 'Cello is working', status: 'working', finished_at: null, parent_id: null, created_at: '2026-10-20T10:00:01.000Z' })
}

const persistence = () => {
  const saver = new MemorySaver()
  const close = vi.fn(async () => void order.push('close'))
  const open = () => ({ saver, close })
  seam.open = open
  return { saver, close, open }
}

const answers = (text = 'Done') => async () => ({ answer: { parts: [{ about: [], text }] }, results: [{ object: null, text }], ran })
const agentThat = (run: (input: unknown) => Promise<unknown>) => vi.mocked(chatAgent).mockImplementation((() => run) as never)

const rowsOf = (db: FakeAdmin, command: string) => db.tables.agent_tasks.filter((r) => r.command === command)
const cello = (db: FakeAdmin) => db.tables.chat_turns.filter((t) => t.kind === 'cello')

beforeEach(() => {
  order.length = 0
  fire.mockReset()
  vi.mocked(chatAgent).mockReset()
  lease.claim.mockReset().mockResolvedValue(held)
})

describe('a turn that goes to the background', () => {
  it('hands a sliced turn over and keeps its row working', async () => {
    const db = seed()
    const p = persistence()
    const events: WireEvent[] = []
    agentThat(async () => Promise.reject(new MovedError()))
    const ok = await runStoredTurn(db, 'u1', 'c1', { id: 't1', typed: 'Draft three notes' }, { emit: (e) => events.push(e), openPersistence: p.open })
    expect(ok).toBe(true)
    expect(fire).toHaveBeenCalledWith({ reason: 'slice', thread_id: 'c1', turn_id: 't1', slice: { n: 1 } })
    const [root] = rowsOf(db, 'chat.turn')
    expect(root).toMatchObject({ status: 'working', turn_id: 't1' })
    expect(root.finished_at ?? null).toBeNull()
    expect(events.map((e) => (e.data as { type: string }).type)).toEqual(['moved'])
    expect(events[0].data).toEqual({ type: 'moved', text: 'Cello carries on in the background. You can leave this page.' })
    expect(cello(db)).toHaveLength(0)
    // The lease and the pool are given back before the next request is asked to take them.
    expect(order.slice(-3)).toEqual(['release', 'close', 'fire'])
  })
})

describe('carrying a turn on', () => {
  it('resumes from the checkpoint and stores one answer', async () => {
    const db = seed()
    handedOver(db)
    const p = persistence()
    await p.saver.put({ configurable: { thread_id: 't1', checkpoint_ns: '' } }, emptyCheckpoint(), { source: 'input', step: 0, parents: {} } as never, {})
    expect(Object.keys(p.saver.storage)).toContain('t1')
    agentThat(answers())
    const ok = await resumeChatTurn(db, 'c1', 't1', 1)
    expect(ok).toBe(true)
    expect(rowsOf(db, 'chat.turn')).toHaveLength(1)
    expect(rowsOf(db, 'chat.turn')[0]).toMatchObject({ id: 'root1', status: 'done' })
    expect(vi.mocked(chatAgent).mock.calls[0][0]).toMatchObject({ resume: true, saver: p.saver, profileCard: 'the card' })
    expect(cello(db).filter((t) => t.origin === 'model')).toHaveLength(1)
    expect(Object.keys(p.saver.storage)).not.toContain('t1')
    expect(p.close).toHaveBeenCalled()
    expect(fire).not.toHaveBeenCalled()
  })

  it('finishes what was in flight when the request died, and writes the rollup', async () => {
    const db = seed()
    handedOver(db)
    persistence()
    db.tables.agent_tasks.push({ id: 'w1', user_id: 'u1', thread_id: 'c1', chat_id: 'c1', turn_id: 't1', command: 'documents.draft', title: 'Draft', status: 'working', finished_at: null, parent_id: null })
    agentThat(answers())
    await resumeChatTurn(db, 'c1', 't1', 0)
    expect(db.tables.agent_tasks.find((r) => r.id === 'w1')).toMatchObject({ status: 'failed', summary: 'Interrupted. Cello picked this up again.' })
    expect(cello(db).find((t) => t.origin === 'code')).toMatchObject({ prov: { rule: 'rollup', turn_id: 't1' } })
  })

  it('does nothing for a turn that is not waiting, and stores no second answer for one already answered', async () => {
    const db = seed()
    expect(await resumeChatTurn(db, 'c1', 't1')).toBe(false)
    handedOver(db)
    db.tables.chat_turns.push({ id: 'a1', user_id: 'u1', chat_id: 'c1', kind: 'cello', origin: 'model', prov: { step: 'chat', turn_id: 't1' }, created_at: '2026-10-20T10:00:05.000Z' })
    expect(await resumeChatTurn(db, 'c1', 't1')).toBe(true)
    expect(rowsOf(db, 'chat.turn')[0]).toMatchObject({ status: 'done' })
    expect(vi.mocked(chatAgent)).not.toHaveBeenCalled()
    expect(cello(db)).toHaveLength(1)
  })

  it('holds the lease so a live turn is never resumed twice', async () => {
    const db = seed()
    handedOver(db)
    lease.claim.mockResolvedValue(null)
    agentThat(answers())
    expect(await resumeChatTurn(db, 'c1', 't1')).toBe(false)
    expect(vi.mocked(chatAgent)).not.toHaveBeenCalled()
    expect(rowsOf(db, 'chat.turn')[0]).toMatchObject({ status: 'working' })
    expect(cello(db)).toHaveLength(0)
  })

  it('stops handing over after the last slice', async () => {
    const db = seed()
    handedOver(db)
    const p = persistence()
    agentThat(async () => Promise.reject(new MovedError()))
    await resumeChatTurn(db, 'c1', 't1', MAX_SLICES - 1)
    expect(fire).not.toHaveBeenCalled()
    expect(rowsOf(db, 'chat.turn')[0]).toMatchObject({ status: 'failed' })
    expect(cello(db).map((t) => t.answer)).toContain(SLICE_CAP_LINE)
  })
})

describe('the rollup', () => {
  it('writes the rollup after two or more workers', async () => {
    const db = seed()
    const p = persistence()
    const scope = { db, userId: 'u1', threadId: 'c1', chatId: 'c1', turnId: 't1' }
    agentThat(async () => {
      for (const title of ['Draft one', 'Draft two']) await finishWorker(db, await openWorker(scope, { command: 'documents.draft', title }), { status: 'done' })
      await openWorker(scope, { command: 'research', title: 'Research: left open' })
      return answers()()
    })
    await runStoredTurn(db, 'u1', 'c1', { id: 't1', typed: 'Draft three notes' }, { openPersistence: p.open })
    const rollup = cello(db).find((t) => t.origin === 'code')
    expect((rollup?.parts as { text: string }[])[0].text).toBe('Done: 2 drafted. 1 could not finish.')
    expect(rowsOf(db, 'research')[0]).toMatchObject({ status: 'failed', summary: 'Did not finish.' })
  })

  it('writes none for a turn with one worker', async () => {
    const db = seed()
    const scope = { db, userId: 'u1', threadId: 'c1', chatId: 'c1', turnId: 't1' }
    agentThat(async () => {
      await finishWorker(db, await openWorker(scope, { command: 'documents.draft', title: 'Draft one' }), { status: 'done' })
      return answers()()
    })
    await runStoredTurn(db, 'u1', 'c1', { id: 't1', typed: 'Draft a note' }, { openPersistence: persistence().open })
    expect(cello(db).filter((t) => t.origin === 'code')).toHaveLength(0)
  })
})
