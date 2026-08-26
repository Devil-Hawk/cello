// POST /api/harness/cron's resume pass replaces the pre-port
// continueIncompleteRuns() + reapStuckRuns(): every 'paused' run (a clean
// deadline interrupt) and every 'running' run whose thread has gone stale (a
// killed invocation) gets re-entered through invokeGraphForUser via THE
// RESUME RULE, bounded by CRON_MAX_CONTINUATIONS and backstopped by a
// checkpoint-count ceiling instead of the old continuation counter.
//
// invokeGraphForUser, markRunPausedOnInterrupt, countThreadCheckpoints and
// composeAndStoreDigest are mocked — this file proves the ROUTE's own
// selection/ordering/capping/close-out logic, not invoke.ts's resume
// semantics (invoke.test.ts/invoke.langgraph.test.ts) or harnessRunGraph's
// own wave scheduler (runs.test.ts).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

interface AgentRunRow {
  id: string
  user_id: string
  status: string
  thread_id: string | null
  created_at: string
  goal?: string
  error?: string
}

interface GraphThreadRow {
  thread_id: string
  last_invoked_at: string | null
}

interface ProfileRow {
  id: string
  resume_text: string | null
  preferences: Record<string, unknown> | null
}

let agentRuns: Map<string, AgentRunRow>
let graphThreads: Map<string, GraphThreadRow>
let profiles: ProfileRow[]
let insertedCount: number

const invokeGraphForUserMock = vi.fn()
const markRunPausedOnInterruptMock = vi.fn()
const countThreadCheckpointsMock = vi.fn()
const composeAndStoreDigestMock = vi.fn()
const distillInsightsMock = vi.fn()

/** A chainable, thenable PostgREST-shaped stub over the three tables this
 *  route touches (agent_runs, graph_threads, profiles), backed by the maps
 *  above. Filters are recorded, not query-planned, so `.order()` is a no-op
 *  (the route sorts client-side and never relies on DB ordering). */
class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private eqFilters: Array<[string, unknown]> = []
  private notNullCols: string[] = []
  private inFilter: [string, unknown[]] | null = null
  private opMode: 'select' | 'insert' | 'update' = 'select'
  private patch: Record<string, unknown> | null = null
  private insertRow: Record<string, unknown> | null = null

  constructor(private table: string) {}

  select(_cols?: string) {
    return this
  }
  eq(col: string, val: unknown) {
    this.eqFilters.push([col, val])
    return this
  }
  not(col: string, _op: string, _val: unknown) {
    this.notNullCols.push(col)
    return this
  }
  in(col: string, vals: unknown[]) {
    this.inFilter = [col, vals]
    return this
  }
  order() {
    return this
  }
  insert(row: Record<string, unknown>) {
    this.opMode = 'insert'
    this.insertRow = row
    return this
  }
  update(patch: Record<string, unknown>) {
    this.opMode = 'update'
    this.patch = patch
    return this
  }
  single() {
    return this
  }

  then<T1 = { data: unknown; error: unknown }, T2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.resolve()).then(
      onfulfilled as (value: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>,
      onrejected as (reason: unknown) => T2 | PromiseLike<T2>
    )
  }

  private matchesAgentRun(r: AgentRunRow): boolean {
    for (const [col, val] of this.eqFilters) {
      if ((r as unknown as Record<string, unknown>)[col] !== val) return false
    }
    for (const col of this.notNullCols) {
      if ((r as unknown as Record<string, unknown>)[col] == null) return false
    }
    return true
  }

  private resolve(): { data: unknown; error: unknown } {
    if (this.table === 'agent_runs') {
      if (this.opMode === 'insert') {
        insertedCount += 1
        const row: AgentRunRow = {
          id: `digest-run-${insertedCount}`,
          user_id: this.insertRow!.user_id as string,
          status: (this.insertRow!.status as string) ?? 'queued',
          thread_id: null,
          created_at: new Date().toISOString(),
          goal: this.insertRow!.goal as string,
        }
        agentRuns.set(row.id, row)
        return { data: { id: row.id }, error: null }
      }
      if (this.opMode === 'update') {
        const idFilter = this.eqFilters.find(([c]) => c === 'id')
        if (!idFilter) throw new Error('route.test.ts: agent_runs update without an id filter')
        const row = agentRuns.get(idFilter[1] as string)
        if (row) Object.assign(row, this.patch)
        return { data: null, error: null }
      }
      return { data: [...agentRuns.values()].filter((r) => this.matchesAgentRun(r)), error: null }
    }
    if (this.table === 'graph_threads') {
      let rows = [...graphThreads.values()]
      if (this.inFilter && this.inFilter[0] === 'thread_id') {
        const ids = new Set(this.inFilter[1])
        rows = rows.filter((t) => ids.has(t.thread_id))
      }
      return { data: rows, error: null }
    }
    if (this.table === 'profiles') {
      return { data: profiles, error: null }
    }
    throw new Error(`route.test.ts: unexpected table "${this.table}"`)
  }
}

vi.mock('@/lib/harness/supabase-admin', () => ({
  createAdminClient: () => ({ from: (table: string) => new FakeQuery(table) }),
}))
vi.mock('@/lib/graph/invoke', () => ({
  invokeGraphForUser: (...args: unknown[]) => invokeGraphForUserMock(...args),
}))
vi.mock('@/lib/graph/runs', () => ({
  harnessRunGraph: { __fake: 'harnessRunGraph' },
  markRunPausedOnInterrupt: (...args: unknown[]) => markRunPausedOnInterruptMock(...args),
}))
vi.mock('@/lib/graph/pg', () => ({
  countThreadCheckpoints: (...args: unknown[]) => countThreadCheckpointsMock(...args),
}))
vi.mock('@/lib/harness/agents/digest', () => ({
  composeAndStoreDigest: (...args: unknown[]) => composeAndStoreDigestMock(...args),
}))
vi.mock('@/lib/graph/distill', () => ({
  distillInsights: (...args: unknown[]) => distillInsightsMock(...args),
}))

import { POST } from './route'

const SECRET = 'test-cron-secret'

function cronRequest() {
  return new NextRequest('http://localhost/api/harness/cron', {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}` },
  })
}

function terminalOutcome(status: string) {
  return { status, spentTokens: 100, budgetTokens: 200_000, steps: [], outputs: {}, summary: { completed: 1, failed: 0, skipped: 0 }, replanEvents: [] }
}

function iso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60 * 1000).toISOString()
}

beforeEach(() => {
  process.env.CRON_SECRET = SECRET
  agentRuns = new Map()
  graphThreads = new Map()
  profiles = [] // no digest-pass activity unless a test opts in
  insertedCount = 0
  invokeGraphForUserMock.mockReset()
  markRunPausedOnInterruptMock.mockReset()
  countThreadCheckpointsMock.mockReset()
  composeAndStoreDigestMock.mockReset()
  distillInsightsMock.mockReset().mockResolvedValue({ ran: false, reason: 'weekly gate not yet elapsed' })
  countThreadCheckpointsMock.mockResolvedValue(1) // well under the ceiling unless a test overrides it
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('POST /api/harness/cron — auth', () => {
  it('rejects a request without the correct CRON_SECRET', async () => {
    const response = await POST(new NextRequest('http://localhost/api/harness/cron', { method: 'POST' }))
    expect(response.status).toBe(401)
    expect(invokeGraphForUserMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/harness/cron — resume pass', () => {
  it('resumes a paused thread to completion', async () => {
    agentRuns.set('run-p', { id: 'run-p', user_id: 'u1', status: 'paused', thread_id: 'thread-p', created_at: iso(30) })
    invokeGraphForUserMock.mockResolvedValue({ threadId: 'thread-p', result: terminalOutcome('completed') })
    markRunPausedOnInterruptMock.mockResolvedValue(false)

    const response = await POST(cronRequest())
    expect(response.status).toBe(200)
    const body = await response.json()

    expect(body.resumed.count).toBe(1)
    expect(body.resumed.deferredToNextTick).toBe(0)
    expect(body.resumed.runs).toEqual([{ runId: 'run-p', outcome: 'completed' }])

    expect(invokeGraphForUserMock).toHaveBeenCalledTimes(1)
    const call = invokeGraphForUserMock.mock.calls[0][0]
    expect(call.userId).toBe('u1')
    expect(call.threadId).toBe('thread-p')
    expect(call.input).toBeUndefined() // THE RESUME RULE: no input on a continue
  })

  it('resumes a "running" row whose thread has gone stale (a killed invocation), and leaves a fresh one alone', async () => {
    agentRuns.set('run-stale', { id: 'run-stale', user_id: 'u1', status: 'running', thread_id: 'thread-stale', created_at: iso(40) })
    agentRuns.set('run-fresh', { id: 'run-fresh', user_id: 'u2', status: 'running', thread_id: 'thread-fresh', created_at: iso(40) })
    graphThreads.set('thread-stale', { thread_id: 'thread-stale', last_invoked_at: iso(20) }) // > 10 min stale
    graphThreads.set('thread-fresh', { thread_id: 'thread-fresh', last_invoked_at: iso(1) }) // genuinely in flight

    invokeGraphForUserMock.mockResolvedValue({ threadId: 'thread-stale', result: terminalOutcome('completed_with_errors') })
    markRunPausedOnInterruptMock.mockResolvedValue(false)

    const response = await POST(cronRequest())
    const body = await response.json()

    expect(body.resumed.runs).toEqual([{ runId: 'run-stale', outcome: 'completed_with_errors' }])
    expect(invokeGraphForUserMock).toHaveBeenCalledTimes(1)
    expect(invokeGraphForUserMock.mock.calls[0][0].threadId).toBe('thread-stale')
  })

  it('a still-interrupted resume stays paused, not terminal', async () => {
    agentRuns.set('run-p', { id: 'run-p', user_id: 'u1', status: 'paused', thread_id: 'thread-p', created_at: iso(30) })
    invokeGraphForUserMock.mockResolvedValue({ threadId: 'thread-p', result: { __interrupt__: [{ value: { kind: 'deadline' } }] } })
    markRunPausedOnInterruptMock.mockResolvedValue(true)

    const response = await POST(cronRequest())
    const body = await response.json()
    expect(body.resumed.runs).toEqual([{ runId: 'run-p', outcome: 'paused' }])
  })

  it('closes a run out past the checkpoint ceiling WITHOUT ever calling invokeGraphForUser', async () => {
    agentRuns.set('run-ceiling', { id: 'run-ceiling', user_id: 'u1', status: 'paused', thread_id: 'thread-ceiling', created_at: iso(30) })
    countThreadCheckpointsMock.mockResolvedValue(201)

    const response = await POST(cronRequest())
    const body = await response.json()

    expect(invokeGraphForUserMock).not.toHaveBeenCalled()
    expect(body.resumed.runs).toHaveLength(1)
    expect(body.resumed.runs[0].runId).toBe('run-ceiling')
    expect(body.resumed.runs[0].outcome).toBe('completed_with_errors')
    expect(body.resumed.runs[0].error).toMatch(/200 checkpoints/)

    const row = agentRuns.get('run-ceiling')!
    expect(row.status).toBe('completed_with_errors')
    expect(row.error).toMatch(/200 checkpoints/)
  })

  it('honors CRON_MAX_CONTINUATIONS=2: 3 eligible runs, oldest 2 resumed, 1 deferred', async () => {
    agentRuns.set('run-a', { id: 'run-a', user_id: 'u1', status: 'paused', thread_id: 'thread-a', created_at: iso(60) })
    agentRuns.set('run-b', { id: 'run-b', user_id: 'u1', status: 'paused', thread_id: 'thread-b', created_at: iso(40) })
    agentRuns.set('run-c', { id: 'run-c', user_id: 'u1', status: 'paused', thread_id: 'thread-c', created_at: iso(20) })
    invokeGraphForUserMock.mockResolvedValue({ threadId: 'irrelevant', result: terminalOutcome('completed') })
    markRunPausedOnInterruptMock.mockResolvedValue(false)

    const response = await POST(cronRequest())
    const body = await response.json()

    expect(body.resumed.count).toBe(2)
    expect(body.resumed.deferredToNextTick).toBe(1)
    expect(invokeGraphForUserMock).toHaveBeenCalledTimes(2)
    expect(invokeGraphForUserMock.mock.calls[0][0].threadId).toBe('thread-a')
    expect(invokeGraphForUserMock.mock.calls[1][0].threadId).toBe('thread-b')
  })

  it('records an errored attempt without crashing the tick, bumps the failure streak, but does not fail the run on a single miss', async () => {
    agentRuns.set('run-p', { id: 'run-p', user_id: 'u1', status: 'paused', thread_id: 'thread-p', created_at: iso(30) })
    invokeGraphForUserMock.mockRejectedValue(new Error('thread ownership refused'))

    const response = await POST(cronRequest())
    const body = await response.json()

    expect(body.resumed.runs).toEqual([{ runId: 'run-p', outcome: 'error', error: 'thread ownership refused' }])
    // Left 'paused' after just one miss (still under RESUME_ATTEMPT_CEILING),
    // so it's picked up again next tick — but the failure streak IS bumped
    // durably (continuation_count), unlike a no-op write: see the next test
    // for what happens once that streak reaches the ceiling.
    const row = agentRuns.get('run-p')! as unknown as { status: string; continuation_count?: number }
    expect(row.status).toBe('paused')
    expect(row.continuation_count).toBe(1)
  })

  it('closes a run out after RESUME_ATTEMPT_CEILING consecutive failed resume attempts across ticks, without ever producing a checkpoint', async () => {
    agentRuns.set('run-broken', { id: 'run-broken', user_id: 'u1', status: 'paused', thread_id: 'thread-broken', created_at: iso(30) })
    invokeGraphForUserMock.mockRejectedValue(new Error('thread ownership refused'))

    // Ticks 1-5: each one fails the same way and bumps the streak; the run
    // stays 'paused' and is still picked up next tick (mirrors the previous
    // test, just repeated).
    for (let tick = 1; tick <= 5; tick++) {
      const response = await POST(cronRequest())
      const body = await response.json()
      expect(body.resumed.runs).toEqual([{ runId: 'run-broken', outcome: 'error', error: 'thread ownership refused' }])
      const row = agentRuns.get('run-broken')! as unknown as { status: string; continuation_count?: number }
      expect(row.status).toBe('paused')
      expect(row.continuation_count).toBe(tick)
    }

    // Tick 6: the streak has reached the ceiling — closed out WITHOUT ever
    // calling invokeGraphForUser again, exactly like the checkpoint-ceiling
    // backstop above. This is the case the checkpoint-count ceiling
    // structurally cannot see (no checkpoint was ever produced), so this run
    // would otherwise retry forever and starve every other paused run's
    // CRON_MAX_CONTINUATIONS slot.
    invokeGraphForUserMock.mockClear()
    const finalResponse = await POST(cronRequest())
    const finalBody = await finalResponse.json()

    expect(invokeGraphForUserMock).not.toHaveBeenCalled()
    expect(finalBody.resumed.runs).toHaveLength(1)
    expect(finalBody.resumed.runs[0].runId).toBe('run-broken')
    expect(finalBody.resumed.runs[0].outcome).toBe('completed_with_errors')
    expect(finalBody.resumed.runs[0].error).toMatch(/5 consecutive failed attempt/)

    const finalRow = agentRuns.get('run-broken')!
    expect(finalRow.status).toBe('completed_with_errors')
    expect(finalRow.error).toMatch(/5 consecutive failed attempt/)
  })

  it('resets the failure streak on a clean attempt, so a thread that legitimately keeps re-pausing is never penalized by RESUME_ATTEMPT_CEILING', async () => {
    agentRuns.set('run-flaky', { id: 'run-flaky', user_id: 'u1', status: 'paused', thread_id: 'thread-flaky', created_at: iso(30) })

    // One failed attempt bumps the streak to 1.
    invokeGraphForUserMock.mockRejectedValueOnce(new Error('transient connectivity blip'))
    await POST(cronRequest())
    expect((agentRuns.get('run-flaky') as unknown as { continuation_count?: number }).continuation_count).toBe(1)

    // A clean attempt that pauses again resets the streak to 0, even though
    // the run itself did not terminate.
    invokeGraphForUserMock.mockResolvedValueOnce({ threadId: 'thread-flaky', result: { __interrupt__: [{ value: { kind: 'deadline' } }] } })
    markRunPausedOnInterruptMock.mockResolvedValueOnce(true)
    await POST(cronRequest())

    const row = agentRuns.get('run-flaky')! as unknown as { status: string; continuation_count?: number }
    expect(row.status).toBe('paused')
    expect(row.continuation_count).toBe(0)
  })
})

describe('POST /api/harness/cron — digest pass creates a fresh thread per run', () => {
  it('drives a digest run through invokeGraphForUser with a fresh thread and reports its outcome', async () => {
    profiles = [{ id: 'user-active', resume_text: 'Staff engineer, 8 years.', preferences: null }]
    invokeGraphForUserMock.mockResolvedValue({ threadId: 'thread-fresh-digest', result: terminalOutcome('completed') })
    markRunPausedOnInterruptMock.mockResolvedValue(false)
    composeAndStoreDigestMock.mockResolvedValue({ userId: 'user-active', outcome: 'skipped_disabled' })

    const response = await POST(cronRequest())
    const body = await response.json()

    expect(body.results).toHaveLength(1)
    expect(body.results[0]).toMatchObject({ userId: 'user-active', status: 'completed' })

    const call = invokeGraphForUserMock.mock.calls.find((c) => c[0].userId === 'user-active')
    expect(call).toBeTruthy()
    expect(call![0].threadId).toBeUndefined() // fresh thread, not a resume
    expect(call![0].input).toEqual({ runId: call![0].input.runId })
  })

  it('a digest run that pauses is reported paused, not invented as a finished outcome', async () => {
    profiles = [{ id: 'user-active', resume_text: 'Staff engineer, 8 years.', preferences: null }]
    invokeGraphForUserMock.mockResolvedValue({ threadId: 'thread-fresh-digest', result: { __interrupt__: [{ value: { kind: 'deadline' } }] } })
    markRunPausedOnInterruptMock.mockResolvedValue(true)
    composeAndStoreDigestMock.mockResolvedValue({ userId: 'user-active', outcome: 'skipped_disabled' })

    const response = await POST(cronRequest())
    const body = await response.json()

    expect(body.results).toEqual([{ userId: 'user-active', runId: expect.any(String), status: 'paused' }])
  })
})
