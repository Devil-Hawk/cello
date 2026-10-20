import { emptyCheckpoint, MemorySaver } from '@langchain/langgraph'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeAdmin, type FakeAdmin } from '@/lib/agents/testing/fake-admin'
import type { WireEvent } from '@/lib/agents/sse'
import { chatAgent } from './agent'
import { CANCEL_LINE, MAX_SLICES, findWaitingPlan, resumeChatTurn, resumePlanTurn, runStoredTurn } from './run'
import { MovedError, PlanWaitingError, finishWorker, openWorker } from './workers'

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
    pipeline_events: [],
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
    await p.saver.put({ configurable: { thread_id: 't1', checkpoint_ns: '' } }, emptyCheckpoint(), { source: 'input', step: 0, parents: {} } as never)
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
    const p = persistence()
    const gone = vi.spyOn(p.saver, 'deleteThread')
    expect(await resumeChatTurn(db, 'c1', 't1')).toBe(true)
    expect(gone).toHaveBeenCalledWith('t1')
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

  it('leaves the working rows of a live turn alone when it stands down', async () => {
    const db = seed()
    handedOver(db)
    lease.claim.mockResolvedValue(null)
    db.tables.agent_tasks.push({ id: 'w1', user_id: 'u1', thread_id: 'c1', chat_id: 'c1', turn_id: 't1', command: 'applications.start', title: 'Start', status: 'working', finished_at: null, parent_id: 'root1' })
    agentThat(answers())
    expect(await resumeChatTurn(db, 'c1', 't1')).toBe(false)
    expect(db.tables.agent_tasks.find((r) => r.id === 'w1')).toMatchObject({ status: 'working', finished_at: null })
    expect(db.tables.agent_tasks.find((r) => r.id === 'w1')?.summary ?? null).toBeNull()
    expect(rowsOf(db, 'chat.turn')[0]).toMatchObject({ status: 'working' })
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

describe('the line a turn without an answer leaves', () => {
  const started = (db: FakeAdmin) =>
    agentThat(async () => {
      await finishWorker(db, await openWorker({ db, userId: 'u1', threadId: 'c1', chatId: 'c1', turnId: 't1' }, { command: 'applications.start', title: 'Start' }), { status: 'done' })
      throw new Error('the model fell over')
    })

  it('says what was kept after a stop when a worker had finished', async () => {
    const db = seed()
    agentThat(async () => {
      await finishWorker(db, await openWorker({ db, userId: 'u1', threadId: 'c1', chatId: 'c1', turnId: 't1' }, { command: 'applications.start', title: 'Start' }), { status: 'done' })
      db.tables.agent_tasks.find((r) => r.command === 'chat.turn')!.stop_requested_at = '2026-10-20T10:00:09.000Z'
      throw new Error('aborted')
    })
    await runStoredTurn(db, 'u1', 'c1', { id: 't1', typed: 'Apply to these' }, { openPersistence: persistence().open })
    expect(cello(db).map((t) => t.answer)).toContain('Stopped. What was already done is kept.')
  })

  const madeAnApplication = (db: FakeAdmin, status: 'failed' | 'stopped' | 'working') =>
    agentThat(async () => {
      db.tables.applications.push({ id: 'app1', user_id: 'u1', job_id: 'j1', state: 'preparing' })
      db.tables.person_jobs.push({ id: 'j1', viewer_id: 'u1', title: 'Forward Deployed Engineer', viewer_company_name: 'Ramp' })
      db.tables.pipeline_events.push({ id: 'e1', user_id: 'u1', application_id: 'app1', kind: 'application.created', payload: { turn_id: 't1' } })
      const id = await openWorker({ db, userId: 'u1', threadId: 'c1', chatId: 'c1', turnId: 't1' }, { command: 'applications.start', title: 'Start', object: { kind: 'role', ref: 'j1' } })
      if (status !== 'working') await finishWorker(db, id, { status })
      for (const r of db.tables.agent_tasks) if (!r.finished_at) r.stop_requested_at = '2026-10-20T10:00:09.000Z'
      throw new Error('aborted')
    })

  it.each(['failed', 'stopped', 'working'] as const)('names the application a stop left behind when its row is %s, and does not say nothing was changed', async (status) => {
    const db = seed()
    db.tables.pipeline_events = []
    madeAnApplication(db, status)
    await runStoredTurn(db, 'u1', 'c1', { id: 't1', typed: 'Apply to this' }, { openPersistence: persistence().open })
    const line = String(cello(db).find((t) => t.prov && (t.prov as { rule?: string }).rule === 'refusal')?.answer)
    expect(line).toBe('Stopped. What was already done is kept. Already started: [Forward Deployed Engineer at Ramp](cello:application/app1).')
  })

  it('ends a row the person stopped as stopped, not failed, even when its work was still running', async () => {
    const db = seed()
    db.tables.pipeline_events = []
    madeAnApplication(db, 'working')
    await runStoredTurn(db, 'u1', 'c1', { id: 't1', typed: 'Apply to this' }, { openPersistence: persistence().open })
    const row = rowsOf(db, 'applications.start')[0]
    expect(row).toMatchObject({ status: 'stopped' })
  })

  it('says nothing was changed after a stop when nothing finished', async () => {
    const db = seed()
    agentThat(async () => {
      db.tables.agent_tasks.find((r) => r.command === 'chat.turn')!.stop_requested_at = '2026-10-20T10:00:09.000Z'
      throw new Error('aborted')
    })
    await runStoredTurn(db, 'u1', 'c1', { id: 't1', typed: 'Apply to these' }, { openPersistence: persistence().open })
    expect(cello(db).map((t) => t.answer)).toContain('Stopped. Nothing was changed.')
  })

  it('does not claim nothing changed when a worker finished before the failure', async () => {
    const db = seed()
    started(db)
    await runStoredTurn(db, 'u1', 'c1', { id: 't1', typed: 'Apply to these' }, { openPersistence: persistence().open })
    const lines = cello(db).map((t) => String(t.answer))
    expect(lines).toContain('Cello could not finish this. What was already done is kept. Try again.')
    expect(lines.some((l) => l.includes('Nothing was changed'))).toBe(false)
  })

  it('keeps the plain line when no worker finished', async () => {
    const db = seed()
    agentThat(async () => Promise.reject(new Error('the model fell over')))
    await runStoredTurn(db, 'u1', 'c1', { id: 't1', typed: 'Apply to these' }, { openPersistence: persistence().open })
    expect(cello(db).map((t) => t.answer)).toContain('Cello could not finish this. Nothing was changed. Try again.')
  })
})

describe('a plan that waits for the person', () => {
  const row = (id: string, extra: Record<string, unknown>) => ({ user_id: 'u1', thread_id: 'c1', chat_id: 'c1', turn_id: 't1', parent_id: null, finished_at: null, stop_requested_at: null, ...extra, id })
  /** What the gate leaves when it interrupts: a waiting plan with two planned steps, and the turn's root row waiting. */
  const planned = (db: FakeAdmin, turnId = 't1', suffix = '', withRoot = true) => {
    if (withRoot) db.tables.agent_tasks.push(row(`root${suffix}`, { turn_id: turnId, command: 'chat.turn', title: 'Cello is working', status: 'waiting', created_at: '2026-10-20T10:00:01.000Z' }))
    db.tables.agent_tasks.push(
      row(`p${suffix}`, { turn_id: turnId, command: 'chat.plan', title: 'Plan: 2 things', status: 'waiting', object: { ai_message_id: 'm1' } }),
      row(`s1${suffix}`, { turn_id: turnId, command: 'chat.plan.step', title: 'Start an application: A at X', status: 'queued', parent_id: `p${suffix}`, branch_index: 0 }),
      row(`s2${suffix}`, { turn_id: turnId, command: 'chat.plan.step', title: 'Start an application: B at Y', status: 'queued', parent_id: `p${suffix}`, branch_index: 1 })
    )
  }
  const find = (db: FakeAdmin, id: string) => db.tables.agent_tasks.find((r) => r.id === id)!
  const withThread = async (p: ReturnType<typeof persistence>, thread = 't1') =>
    p.saver.put({ configurable: { thread_id: thread, checkpoint_ns: '' } }, emptyCheckpoint(), { source: 'input', step: 0, parents: {} } as never)

  it('waits on a plan with no answer, no clean-up and the row waiting', async () => {
    const db = seed()
    const p = persistence()
    await withThread(p)
    const gone = vi.spyOn(p.saver, 'deleteThread')
    const events: WireEvent[] = []
    agentThat(async () => {
      planned(db, 't1', '', false)
      throw new PlanWaitingError('p')
    })
    const ok = await runStoredTurn(db, 'u1', 'c1', { id: 't1', typed: 'Apply to all of these' }, { emit: (e) => events.push(e), openPersistence: p.open })
    expect(ok).toBe(true)
    expect(rowsOf(db, 'chat.turn')).toHaveLength(1)
    expect(rowsOf(db, 'chat.turn')[0]).toMatchObject({ status: 'waiting', turn_id: 't1' })
    expect(rowsOf(db, 'chat.turn')[0].finished_at ?? null).toBeNull()
    expect(cello(db)).toHaveLength(0)
    expect(gone).not.toHaveBeenCalled()
    expect(Object.keys(p.saver.storage)).toContain('t1')
    expect(fire).not.toHaveBeenCalled()
    expect(find(db, 'p')).toMatchObject({ status: 'waiting', finished_at: null })
    expect(find(db, 's1')).toMatchObject({ status: 'queued', finished_at: null })
    expect(events.map((e) => e.data)).toEqual([{ type: 'plan', plan_id: 'p', turn_id: 't1' }])
    expect(order.slice(-2)).toEqual(['release', 'close'])
  })

  it('carries on an approved plan with the decision as the resume value', async () => {
    const db = seed()
    planned(db)
    const p = persistence()
    const decision = { plan_id: 'p', keep: ['s2', 's1'] }
    const seen: Record<string, unknown>[] = []
    agentThat(async () => {
      // Resumed: the turn's row works again, and the planned steps were not marked as interrupted.
      seen.push({ root: find(db, 'root').status, s1: find(db, 's1').status, s1summary: find(db, 's1').summary ?? null })
      for (const id of ['s1', 's2']) Object.assign(find(db, id), { status: 'done', finished_at: '2026-10-20T10:00:05.000Z' })
      return answers()()
    })
    const waiting = await findWaitingPlan(db, 'u1', 'c1', 'p')
    expect(waiting).toEqual({ planId: 'p', turnId: 't1', rootId: 'root', stepIds: ['s1', 's2'] })
    const events: WireEvent[] = []
    expect(await resumePlanTurn(db, 'u1', 'c1', waiting!, decision, { emit: (e) => events.push(e), openPersistence: p.open })).toBe(true)
    expect(vi.mocked(chatAgent).mock.calls[0][0]).toMatchObject({ resume: true, resumeValue: decision, saver: p.saver })
    expect(seen).toEqual([{ root: 'working', s1: 'queued', s1summary: null }])
    expect(find(db, 'root')).toMatchObject({ status: 'done' })
    expect(rowsOf(db, 'chat.turn')).toHaveLength(1)
    expect(cello(db).filter((t) => t.origin === 'model')).toHaveLength(1)
    expect(events.map((e) => (e.data as { type: string }).type)).toEqual(['answer'])
  })

  it('cancels a plan with nothing changed and the checkpoint gone', async () => {
    const db = seed()
    planned(db)
    const p = persistence()
    await withThread(p)
    agentThat(answers())
    const events: WireEvent[] = []
    const waiting = (await findWaitingPlan(db, 'u1', 'c1', 'p'))!
    expect(await resumePlanTurn(db, 'u1', 'c1', waiting, { plan_id: 'p', keep: null }, { emit: (e) => events.push(e), openPersistence: p.open })).toBe(true)
    expect(vi.mocked(chatAgent)).not.toHaveBeenCalled()
    for (const id of ['s1', 's2']) expect(find(db, id)).toMatchObject({ status: 'stopped', summary: 'Cancelled by you' })
    expect(find(db, 's1').finished_at).toBeTruthy()
    expect(find(db, 'p')).toMatchObject({ status: 'stopped', summary: 'Cancelled by you' })
    expect(find(db, 'root')).toMatchObject({ status: 'stopped' })
    expect(find(db, 'root').finished_at).toBeTruthy()
    expect(cello(db).map((t) => t.answer)).toEqual([CANCEL_LINE])
    expect(CANCEL_LINE).toBe('Cancelled. Nothing was changed.')
    expect(Object.keys(p.saver.storage)).not.toContain('t1')
    expect(events.map((e) => e.data)).toEqual([{ type: 'answer', turn_id: 't1' }])
    // A second Cancel finds nothing waiting and says nothing more.
    expect(await resumePlanTurn(db, 'u1', 'c1', waiting, { plan_id: 'p', keep: null }, { openPersistence: p.open })).toBe(true)
    expect(cello(db)).toHaveLength(1)
    expect(await findWaitingPlan(db, 'u1', 'c1', 'p')).toBeNull()
  })

  it('keeps what was already done when work finished before the plan', async () => {
    const db = seed()
    planned(db)
    db.tables.agent_tasks.push(row('w1', { command: 'documents.draft', title: 'Draft', status: 'done', finished_at: '2026-10-20T10:00:02.000Z' }))
    const waiting = (await findWaitingPlan(db, 'u1', 'c1', 'p'))!
    await resumePlanTurn(db, 'u1', 'c1', waiting, { plan_id: 'p', keep: null }, { openPersistence: persistence().open })
    expect(cello(db).map((t) => t.answer)).toEqual(['Cancelled. What was already done is kept.'])
  })

  it('finds a plan only for its own person and chat while it waits', async () => {
    const db = seed()
    planned(db)
    expect(await findWaitingPlan(db, 'u2', 'c1', 'p')).toBeNull()
    expect(await findWaitingPlan(db, 'u1', 'c2', 'p')).toBeNull()
    expect(await findWaitingPlan(db, 'u1', 'c1', 'nope')).toBeNull()
    find(db, 'p').status = 'done'
    expect(await findWaitingPlan(db, 'u1', 'c1', 'p')).toBeNull()
  })

  it('a new message cancels a plan still waiting', async () => {
    const db = seed()
    planned(db)
    planned(db, 't9', 'x')
    for (const r of db.tables.agent_tasks.filter((r) => String(r.id).endsWith('x'))) r.chat_id = 'c9'
    const p = persistence()
    await withThread(p)
    agentThat(answers())
    await runStoredTurn(db, 'u1', 'c1', { id: 't2', typed: 'Something else' }, { openPersistence: p.open })
    for (const id of ['s1', 's2', 'p']) expect(find(db, id)).toMatchObject({ status: 'stopped', summary: 'Cancelled when you asked something else' })
    expect(find(db, 's1').finished_at).toBeTruthy()
    expect(find(db, 'root')).toMatchObject({ status: 'stopped' })
    expect(find(db, 'root').finished_at).toBeTruthy()
    expect(Object.keys(p.saver.storage)).not.toContain('t1')
    // No line for the old plan; only the new turn answers. Another chat's plan is left alone.
    expect(cello(db).map((t) => t.origin)).toEqual(['model'])
    expect(find(db, 'px')).toMatchObject({ status: 'waiting', finished_at: null })
    expect(rowsOf(db, 'chat.turn').find((r) => r.turn_id === 't2')).toMatchObject({ status: 'done' })
  })

  it('never resumes a waiting turn from a background post', async () => {
    const db = seed()
    planned(db)
    agentThat(answers())
    expect(await resumeChatTurn(db, 'c1', 't1')).toBe(false)
    expect(await resumeChatTurn(db, 'c1')).toBe(false)
    expect(vi.mocked(chatAgent)).not.toHaveBeenCalled()
    expect(find(db, 'root')).toMatchObject({ status: 'waiting', finished_at: null })
    expect(cello(db)).toHaveLength(0)
  })
})
