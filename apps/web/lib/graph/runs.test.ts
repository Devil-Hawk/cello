// Tests for lib/graph/runs.ts's harnessRunGraph — the LangGraph Functional
// API port of lib/harness/executor.ts#runAgentRun. Ports the run-semantics
// scenarios executor.test.ts documents (RESUMPTION/adoption, deadline-pause-
// is-resumable, budget-is-never-resumable, loop bounds) PLUS the scenarios
// the graph-port build brief names that executor.test.ts's own file doesn't
// separately exercise (happy DAG, dependency skip cascade, fan-out, replan
// bounded) — informed by executor.ts's own documented behavior for those.
// executor.test.ts itself is untouched and stays green (both implementations
// covered until stage 1C deletes one).
//
// Same mocking boundary as executor.test.ts: './registry' (UNIT_REGISTRY),
// './keys' (loadApiKeys), './llm' (callLlm — must never be reached; every
// fake unit impl returns its output directly) and the agentSchemas half of
// './schemas' are mocked (permissive — this file tests orchestration, not
// per-agent output shape validation); PlanStepSchema/PlanSchema/detectCycle/
// stripUntrustedSubmit and lib/harness/dynamic.ts's pure helpers stay real.
// ZERO network, ZERO real LLM calls, ZERO real Postgres — checkpointing runs
// against a REAL @langchain/langgraph MemorySaver (not a fake), so these
// tests exercise the real Functional API memoization/interrupt/resume
// machinery, only swapping Postgres for memory.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemorySaver } from '@langchain/langgraph'
import type { AgentFn, AgentResult, AgentRunRow, Plan } from '../harness/types'
import { isJournaledStepRow } from './journal'

// --- test-controlled agent registry (keyed by agent_type, unlike
// executor.test.ts's label-keyed registry — lib/graph/unit.ts#runAgentUnit
// dispatches UNIT_REGISTRY purely by unitType, never by label) -------------

const impls: Partial<Record<string, AgentFn>> = {}
vi.mock('../harness/registry', () => ({
  UNIT_REGISTRY: new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        const fn = impls[prop]
        if (!fn) throw new Error(`runs.test.ts: no impl registered for unit type "${prop}"`)
        return fn
      },
    }
  ),
}))

vi.mock('../harness/keys', () => ({
  loadApiKeys: vi.fn().mockResolvedValue({ openrouter: 'fake-key', userId: 'user-1' }),
}))

// callLlm must never be reached — every fake unit impl returns its output
// directly without touching ctx.llm.
vi.mock('../harness/llm', () => ({
  callLlm: vi.fn().mockRejectedValue(new Error('callLlm must not be called — runs.test.ts uses fake unit impls only')),
}))

vi.mock('../harness/schemas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../harness/schemas')>()
  const permissive = { safeParse: (v: unknown) => ({ success: true, data: v }), parse: (v: unknown) => v }
  return {
    ...actual,
    agentSchemas: new Proxy({}, { get: () => ({ output: permissive, input: permissive }) }),
  }
})

const planGoalMock = vi.fn()
vi.mock('../harness/planner', () => ({
  planGoal: (...args: unknown[]) => planGoalMock(...args),
}))

// --- minimal in-memory fake of the PostgREST chains journal.ts/runs.ts issue
// (same shape as executor.test.ts's FakeAdmin/FakeQueryBuilder/FakeTable) ---

interface FakeRow {
  id: string
  [key: string]: unknown
}

class FakeTable {
  rows = new Map<string, FakeRow>()
  private seq = 0
  nextId(prefix: string): string {
    this.seq += 1
    return `${prefix}-${this.seq}`
  }
}

class FakeQueryBuilder implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: { col: string; op: 'eq' | 'is'; val: unknown }[] = []
  private opMode: 'select' | 'update' | 'insert' = 'select'
  private patch: Record<string, unknown> | null = null
  private insertRow: Record<string, unknown> | null = null
  private singleMode: 'single' | 'maybeSingle' | null = null

  constructor(
    private table: FakeTable,
    private tableName: string
  ) {}

  select(_cols?: string) {
    return this
  }
  eq(col: string, val: unknown) {
    this.filters.push({ col, op: 'eq', val })
    return this
  }
  is(col: string, val: unknown) {
    this.filters.push({ col, op: 'is', val })
    return this
  }
  update(patch: Record<string, unknown>) {
    this.opMode = 'update'
    this.patch = patch
    return this
  }
  insert(row: Record<string, unknown>) {
    this.opMode = 'insert'
    this.insertRow = row
    return this
  }

  private matches(row: FakeRow): boolean {
    return this.filters.every(({ col, op, val }) => {
      const rowVal = row[col]
      if (op === 'eq') return rowVal === val
      return val === null ? rowVal === null || rowVal === undefined : rowVal === val
    })
  }

  private matchingRows(): FakeRow[] {
    return [...this.table.rows.values()].filter((r) => this.matches(r))
  }

  private async exec(): Promise<{ data: unknown; error: unknown }> {
    if (this.opMode === 'insert') {
      const row = { ...this.insertRow } as FakeRow
      row.id = (row.id as string) ?? this.table.nextId(this.tableName)
      this.table.rows.set(row.id, row)
      return { data: this.singleMode ? row : [row], error: null }
    }
    if (this.opMode === 'update') {
      const rows = this.matchingRows()
      for (const row of rows) Object.assign(row, this.patch)
      return { data: this.singleMode ? (rows[0] ?? null) : rows, error: null }
    }
    const rows = this.matchingRows().map((r) => ({ ...r }))
    if (this.singleMode === 'single') return { data: rows[0] ?? null, error: rows[0] ? null : { message: 'not found' } }
    if (this.singleMode === 'maybeSingle') return { data: rows[0] ?? null, error: null }
    return { data: rows, error: null }
  }

  single() {
    this.singleMode = 'single'
    return this.exec()
  }
  maybeSingle() {
    this.singleMode = 'maybeSingle'
    return this.exec()
  }
  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.exec().then(onfulfilled, onrejected)
  }
}

class FakeAdmin {
  private tables = new Map<string, FakeTable>()
  private tableFor(name: string): FakeTable {
    if (!this.tables.has(name)) this.tables.set(name, new FakeTable())
    return this.tables.get(name)!
  }
  from(name: string) {
    return new FakeQueryBuilder(this.tableFor(name), name)
  }
  seed(tableName: string, row: FakeRow): void {
    this.tableFor(tableName).rows.set(row.id, { ...row })
  }
  getRow(tableName: string, id: string): FakeRow | undefined {
    return this.tableFor(tableName).rows.get(id)
  }
  allRows(tableName: string): FakeRow[] {
    return [...this.tableFor(tableName).rows.values()]
  }
}

const adminHolder = vi.hoisted<{ admin: unknown }>(() => ({ admin: null }))
vi.mock('../harness/supabase-admin', () => ({
  createAdminClient: () => adminHolder.admin,
}))

function seedRun(admin: FakeAdmin, runId: string, plan: Plan | null, overrides: Partial<AgentRunRow> = {}): void {
  admin.seed('agent_runs', {
    id: runId,
    user_id: 'user-1',
    goal: 'test goal',
    status: 'queued',
    plan: plan as unknown as Record<string, unknown> | null,
    budget_tokens: 100_000,
    spent_tokens: 0,
    result: null,
    error: null,
    started_at: null,
    finished_at: null,
    created_at: new Date().toISOString(),
    continuation_count: 0,
    ...overrides,
  })
}

// --- reading the step ledger back out of trace_spans ------------------------
//
// A real runAgentUnit call (this file never mocks lib/trace/spans.ts) writes
// TWO kind='node' rows per label into trace_spans for the same call: this
// file's own journal.ts row (name=label, attributes.stepStatus set) and
// spans.ts's own buffered observability span (same name, no stepStatus) —
// see lib/graph/journal.ts's header for why that coexistence is correct, not
// a bug. isJournaledStepRow is the same chokepoint journal.ts's own upsert
// lookup uses to tell them apart.

function journaledStep(admin: FakeAdmin, name: string): FakeRow {
  const rows = admin
    .allRows('trace_spans')
    .filter((r) => r.name === name && isJournaledStepRow(r as { kind?: unknown; attributes?: unknown }))
  if (rows.length !== 1) {
    throw new Error(`journaledStep: expected exactly one journaled trace_spans row named "${name}", found ${rows.length}`)
  }
  return rows[0]!
}

function stepAttrs(row: FakeRow): Record<string, unknown> {
  return (row.attributes as Record<string, unknown> | null) ?? {}
}

function stepStatus(row: FakeRow | undefined): unknown {
  return row && stepAttrs(row).stepStatus
}

// --- MemorySaver-backed graph config ---------------------------------------
//
// The literal LangGraph's Pregel runtime actually reads a per-call
// checkpointer override off — see lib/graph/invoke.ts's PREGEL_CHECKPOINTER_KEY
// comment for how this was verified against the pinned 1.4.10 dist. Not
// exported from invoke.ts (private to that file's own design), so pinned here
// too — this file bypasses invoke.ts entirely (it tests the raw compiled
// graph, not the invoke-layer's thread-ownership/demo-expiry wrapping around
// it), so it needs the same literal invoke.ts uses internally.
const PREGEL_CHECKPOINTER_KEY = '__pregel_checkpointer'

function makeConfig(threadId: string, userId: string, saver: MemorySaver) {
  return {
    configurable: {
      thread_id: threadId,
      threadId,
      userId,
      [PREGEL_CHECKPOINTER_KEY]: saver,
    },
  }
}

const SEQUENTIAL_PLAN: Plan = {
  goal: 'test goal',
  steps: [
    { label: 'a', agent_type: 'sourcer', input: {}, dependsOn: [] },
    { label: 'b', agent_type: 'sourcer', input: {}, dependsOn: ['a'] },
  ],
}

let harnessRunGraph: typeof import('./runs').harnessRunGraph

beforeEach(async () => {
  vi.resetModules()
  for (const k of Object.keys(impls)) delete impls[k]
  planGoalMock.mockReset()
  ;({ harnessRunGraph } = await import('./runs'))
})

afterEach(() => {
  vi.restoreAllMocks()
})

function setAdmin(admin: FakeAdmin): void {
  adminHolder.admin = admin
}

describe('harnessRunGraph — ownership', () => {
  it('refuses a runId whose agent_runs.user_id does not match config.configurable.userId', async () => {
    const admin = new FakeAdmin()
    setAdmin(admin)
    const runId = 'run-owned-by-someone-else'
    seedRun(admin, runId, SEQUENTIAL_PLAN) // seeded with user_id: 'user-1'

    const saver = new MemorySaver()
    const { RunOwnershipError } = await import('./runs')
    await expect(harnessRunGraph.invoke({ runId }, makeConfig('t-owner', 'user-2', saver))).rejects.toBeInstanceOf(
      RunOwnershipError
    )
  })
})

describe('harnessRunGraph — happy DAG', () => {
  it('runs a two-step sequential DAG to completion, threading b a\'s output through deps', async () => {
    const admin = new FakeAdmin()
    setAdmin(admin)
    const runId = 'run-happy'
    seedRun(admin, runId, SEQUENTIAL_PLAN)

    let calls = 0
    impls.sourcer = vi.fn(async () => {
      calls += 1
      return { output: { jobIds: ['j1'], found: 1, inserted: 1 }, tokensUsed: 5 }
    })

    const saver = new MemorySaver()
    const outcome = await harnessRunGraph.invoke({ runId }, makeConfig('t-happy', 'user-1', saver))

    expect(outcome.status).toBe('completed')
    expect(outcome.summary).toEqual({ completed: 2, failed: 0, skipped: 0 })
    expect(calls).toBe(2)
    expect(outcome.spentTokens).toBe(10)

    const runRow = admin.getRow('agent_runs', runId)!
    expect(runRow.status).toBe('completed')

    expect(stepStatus(journaledStep(admin, 'a'))).toBe('completed')
    expect(stepStatus(journaledStep(admin, 'b'))).toBe('completed')
  })
})

describe('harnessRunGraph — dependency skip cascade', () => {
  it('a genuine failure on "a" cascades "b" to skipped with a clear reason', async () => {
    const admin = new FakeAdmin()
    setAdmin(admin)
    const runId = 'run-cascade'
    seedRun(admin, runId, SEQUENTIAL_PLAN)

    impls.sourcer = vi.fn(async (ctx) => {
      if (ctx.stepLabel === 'a') throw new Error('boom')
      return { output: { jobIds: [], found: 0, inserted: 0 }, tokensUsed: 1 }
    })

    const saver = new MemorySaver()
    const outcome = await harnessRunGraph.invoke({ runId }, makeConfig('t-cascade', 'user-1', saver))

    // HONEST STATUS (mirrors executor.ts's own finalStatus rule): with only
    // "a"/"b" in this plan and "a" the one that fails, NOTHING completed —
    // 'failed' is reserved for exactly that, same as runAgentRun's own.
    expect(outcome.status).toBe('failed')
    const a = outcome.steps.find((s) => s.label === 'a')!
    const b = outcome.steps.find((s) => s.label === 'b')!
    expect(a.status).toBe('failed')
    expect(a.error).toContain('boom')
    expect(b.status).toBe('skipped')
    expect(b.error).toBe('dependency did not complete')
  }, 15_000)
})

describe('harnessRunGraph — budget abort is NEVER resumable; deadline pause IS', () => {
  it('budget exhaustion marks the remaining step skipped and the run terminal (never "incomplete"-shaped)', async () => {
    const admin = new FakeAdmin()
    setAdmin(admin)
    const runId = 'run-budget'
    seedRun(admin, runId, SEQUENTIAL_PLAN, { budget_tokens: 5 })

    impls.sourcer = vi.fn(async () => ({ output: { jobIds: [], found: 0, inserted: 0 }, tokensUsed: 20 }))

    const saver = new MemorySaver()
    const outcome = await harnessRunGraph.invoke({ runId }, makeConfig('t-budget', 'user-1', saver))

    expect(outcome.status).toBe('completed_with_errors')
    expect(outcome.aborted).toBe('budget')
    const b = outcome.steps.find((s) => s.label === 'b')!
    expect(b.status).toBe('skipped')
    expect(b.error).toMatch(/budget exhausted/i)
    expect(impls.sourcer).toHaveBeenCalledTimes(1) // "b" never even attempted

    const runRow = admin.getRow('agent_runs', runId)!
    expect(runRow.status).toBe('completed_with_errors')
  })

  it('deadline pause interrupts (resumable); invoke(null) on resume adopts "a" and completes "b"', async () => {
    const admin = new FakeAdmin()
    setAdmin(admin)
    const runId = 'run-deadline'
    seedRun(admin, runId, SEQUENTIAL_PLAN)

    let mockNow = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => mockNow)

    let aCalls = 0
    let bCalls = 0
    impls.sourcer = vi.fn(async (ctx) => {
      if (ctx.stepLabel === 'a') {
        aCalls += 1
        mockNow += 10_000_000_000 // jump far past MAX_RUN_MS before the wave loop re-checks the deadline
        return { output: { jobIds: ['j1'], found: 1, inserted: 1 }, tokensUsed: 5 }
      }
      bCalls += 1
      return { output: { jobIds: [], found: 0, inserted: 0 }, tokensUsed: 5 }
    })

    const saver = new MemorySaver()
    const config = makeConfig('t-deadline', 'user-1', saver)

    const first = await harnessRunGraph.invoke({ runId }, config)
    expect(first).toEqual(expect.objectContaining({ __interrupt__: expect.any(Array) }))
    const interruptPayload = (first as unknown as { __interrupt__: { value: unknown }[] }).__interrupt__[0].value
    expect(interruptPayload).toEqual(
      expect.objectContaining({ kind: 'deadline', completedLabels: ['a'], pendingLabels: ['b'] })
    )
    expect(aCalls).toBe(1)
    expect(bCalls).toBe(0)

    // The agent_runs row itself is still 'running' here — see lib/graph/runs.ts's
    // header on why the 'paused' transition is NOT written from inside the
    // entrypoint body (interrupt() throws, unwinding before any code after it
    // could run) and is instead the future route/invoke-layer's job.
    expect(admin.getRow('agent_runs', runId)!.status).toBe('running')

    nowSpy.mockRestore() // give the resumed attempt a full, real deadline window
    const second = await harnessRunGraph.invoke(null, config)

    expect((second as { status: string }).status).toBe('completed')
    expect(aCalls).toBe(1) // "a" was ADOPTED — memoized, never re-invoked
    expect(bCalls).toBe(1)
    expect((second as { spentTokens: number }).spentTokens).toBe(10) // 5 (a) + 5 (b), never double-counted

    const runRow = admin.getRow('agent_runs', runId)!
    expect(runRow.status).toBe('completed')
  })
})

describe('harnessRunGraph — loop bounds hold', () => {
  const loopPlan = (maxIterations: number, targetCount: number): Plan => ({
    goal: 'test goal',
    steps: [
      {
        label: 'poll',
        agent_type: 'sourcer',
        input: {},
        dependsOn: [],
        loop: { maxIterations, until: { key: 'found', op: 'gte', value: targetCount } },
      },
    ],
  })

  it('never exceeds loop.maxIterations even when the until condition is never met', async () => {
    const admin = new FakeAdmin()
    setAdmin(admin)
    const runId = 'run-loop-ceiling'
    seedRun(admin, runId, loopPlan(3, 100))

    let iter = 0
    impls.sourcer = vi.fn(async () => {
      iter += 1
      return { output: { jobIds: [], found: iter * 10, inserted: 0 }, tokensUsed: 1 }
    })

    const saver = new MemorySaver()
    const outcome = await harnessRunGraph.invoke({ runId }, makeConfig('t-loop-ceiling', 'user-1', saver))

    const step = outcome.steps.find((s) => s.label === 'poll')!
    expect(step.loop?.iterations).toBe(3)
    expect(step.loop?.stopReason).toBe('max-iterations')
    expect(impls.sourcer).toHaveBeenCalledTimes(3)
  })

  it('stops as soon as the until condition is met, well before maxIterations', async () => {
    const admin = new FakeAdmin()
    setAdmin(admin)
    const runId = 'run-loop-early-stop'
    seedRun(admin, runId, loopPlan(5, 100))

    let iter = 0
    impls.sourcer = vi.fn(async () => {
      iter += 1
      return { output: { jobIds: [], found: iter === 2 ? 150 : 10, inserted: 0 }, tokensUsed: 1 }
    })

    const saver = new MemorySaver()
    const outcome = await harnessRunGraph.invoke({ runId }, makeConfig('t-loop-early', 'user-1', saver))

    const step = outcome.steps.find((s) => s.label === 'poll')!
    expect(step.loop?.iterations).toBe(2)
    expect(step.loop?.stopReason).toBe('condition-met')
    expect(impls.sourcer).toHaveBeenCalledTimes(2)
  })

  it('a deadline hit MID-LOOP never journals a false terminal status, then resumes to completion', async () => {
    // Regression for the loop step's OWN internal deadline check: it must not
    // race the outer wave-boundary interrupt() with a direct, non-memoized
    // "aborted" write for the same label (see runLoopStep's header comment).
    const admin = new FakeAdmin()
    setAdmin(admin)
    const runId = 'run-loop-deadline'
    seedRun(admin, runId, {
      goal: 'test goal',
      steps: [
        {
          label: 'poll',
          agent_type: 'sourcer',
          input: {},
          dependsOn: [],
          loop: { maxIterations: 5, until: { key: 'found', op: 'gte', value: 3 } },
        },
      ],
    })

    let mockNow = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => mockNow)

    let iter = 0
    impls.sourcer = vi.fn(async () => {
      iter += 1
      if (iter === 1) mockNow += 10_000_000_000 // past MAX_RUN_MS before the loop's next pass re-checks the deadline
      return { output: { jobIds: [], found: iter === 1 ? 1 : 5, inserted: 0 }, tokensUsed: 1 }
    })

    const saver = new MemorySaver()
    const config = makeConfig('t-loop-deadline', 'user-1', saver)

    const first = await harnessRunGraph.invoke({ runId }, config)
    expect(first).toEqual(expect.objectContaining({ __interrupt__: expect.any(Array) }))
    expect(impls.sourcer).toHaveBeenCalledTimes(1)

    // The parent 'poll' row must NOT show a fabricated terminal status during
    // the pause window — journalStepStart wrote it 'running' when the loop
    // was dispatched, and nothing since has overwritten it as 'failed'.
    const pausedRow = journaledStep(admin, 'poll')
    expect(stepStatus(pausedRow)).toBe('running')
    expect(stepAttrs(pausedRow).input).toEqual({})

    nowSpy.mockRestore()
    const second = await harnessRunGraph.invoke(null, config)

    expect((second as { status: string }).status).toBe('completed')
    expect(impls.sourcer).toHaveBeenCalledTimes(2) // iteration 1 was NOT re-invoked (memoized)
    const step = (second as { steps: { label: string; loop?: { iterations: number; stopReason: string } }[] }).steps.find(
      (s) => s.label === 'poll'
    )!
    expect(step.loop).toEqual({ iterations: 2, stopReason: 'condition-met' })

    expect(stepStatus(journaledStep(admin, 'poll'))).toBe('completed')
  })
})

describe('harnessRunGraph — fan-out over an upstream list', () => {
  it('fans a child out per upstream jobId, aggregating completed/failed counts', async () => {
    const admin = new FakeAdmin()
    setAdmin(admin)
    const runId = 'run-fanout'
    const plan: Plan = {
      goal: 'test goal',
      steps: [
        { label: 'source', agent_type: 'sourcer', input: {}, dependsOn: [] },
        {
          label: 'enrich',
          agent_type: 'enricher',
          input: {},
          dependsOn: ['source'],
          fanOut: { overDep: 'source', overKey: 'jobIds', itemKey: 'jobId', maxChildren: 10 },
        },
      ],
    }
    seedRun(admin, runId, plan)

    impls.sourcer = vi.fn(async () => ({ output: { jobIds: ['j1', 'j2', 'j3'], found: 3, inserted: 3 }, tokensUsed: 2 }))
    const seenJobIds: string[] = []
    impls.enricher = vi.fn(async (ctx) => {
      const jobId = (ctx.input as { jobId: string }).jobId
      seenJobIds.push(jobId)
      return { output: { enriched: [{ jobId, signals: {} }] }, tokensUsed: 1 }
    })

    const saver = new MemorySaver()
    const outcome = await harnessRunGraph.invoke({ runId }, makeConfig('t-fanout', 'user-1', saver))

    expect(outcome.status).toBe('completed')
    const enrich = outcome.steps.find((s) => s.label === 'enrich')!
    expect(enrich.fanOut).toEqual({ total: 3, completed: 3, failed: 0 })
    expect(seenJobIds.sort()).toEqual(['j1', 'j2', 'j3'])
    expect(outcome.outputs.enrich).toEqual(
      expect.objectContaining({ fannedOut: 3, completed: 3, failed: 0, childLabels: ['enrich#1', 'enrich#2', 'enrich#3'] })
    )
  })
})

describe('harnessRunGraph — replan is bounded and validated', () => {
  it('an accepted replanRequest appends a new step that then runs; the plan is persisted', async () => {
    const admin = new FakeAdmin()
    setAdmin(admin)
    const runId = 'run-replan'
    const plan: Plan = {
      goal: 'test goal',
      steps: [{ label: 'seed', agent_type: 'sourcer', input: {}, dependsOn: [] }],
    }
    seedRun(admin, runId, plan)

    let extraRan = false
    impls.sourcer = vi.fn(async (): Promise<AgentResult> => ({
      output: { jobIds: ['j1'], found: 1, inserted: 1 },
      tokensUsed: 1,
      replanRequest: {
        reason: 'found a promising job, score it',
        steps: [{ label: 'extra', agent_type: 'matcher', input: {}, dependsOn: [] }],
      },
    }))
    impls.matcher = vi.fn(async () => {
      extraRan = true
      return { output: { matches: [], topJobIds: [] }, tokensUsed: 1 }
    })

    const saver = new MemorySaver()
    const outcome = await harnessRunGraph.invoke({ runId }, makeConfig('t-replan', 'user-1', saver))

    expect(outcome.status).toBe('completed')
    expect(extraRan).toBe(true)
    expect(outcome.replanEvents).toEqual([
      { fromLabel: 'seed', accepted: true, reason: 'found a promising job, score it', addedLabels: ['extra'] },
    ])
    expect(outcome.steps.map((s) => s.label).sort()).toEqual(['extra', 'seed'])

    const runRow = admin.getRow('agent_runs', runId)!
    const persistedPlan = runRow.plan as Plan
    expect(persistedPlan.steps.map((s) => s.label)).toEqual(['seed', 'extra'])
  })

  it('rejects a replan that would exceed the remaining token budget, journaling the refusal', async () => {
    const admin = new FakeAdmin()
    setAdmin(admin)
    const runId = 'run-replan-over-budget'
    const plan: Plan = {
      goal: 'test goal',
      steps: [{ label: 'seed', agent_type: 'sourcer', input: {}, dependsOn: [] }],
    }
    // Budget fully consumed by "seed" itself -> no room left for a replan.
    seedRun(admin, runId, plan, { budget_tokens: 5 })

    impls.sourcer = vi.fn(async (): Promise<AgentResult> => ({
      output: { jobIds: ['j1'], found: 1, inserted: 1 },
      tokensUsed: 5,
      replanRequest: {
        reason: 'spawn more work',
        steps: [{ label: 'extra', agent_type: 'matcher', input: {}, dependsOn: [] }],
      },
    }))

    const saver = new MemorySaver()
    const outcome = await harnessRunGraph.invoke({ runId }, makeConfig('t-replan-budget', 'user-1', saver))

    expect(outcome.replanEvents).toEqual([
      {
        fromLabel: 'seed',
        accepted: false,
        reason: 'no token budget remaining — cannot extend the graph',
        addedLabels: [],
      },
    ])
    expect(outcome.steps.map((s) => s.label)).toEqual(['seed']) // "extra" never joined the graph
  })

  it('an accepted replan survives a deadline pause+resume without the journal row flipping to rejected', async () => {
    // Regression: handleReplanRequest re-runs as plain code on every replay,
    // and by resume time agent_runs.plan already carries "extra" (persisted
    // by the FIRST attempt's acceptance) — recomputing applyReplan against
    // that reloaded plan would wrongly see a duplicate label and overwrite
    // the true accepted '__replan-1' row with a fabricated rejection. See
    // handleReplanRequest's header comment for the fix (the decision itself
    // is memoized via makeReplanTask; only its idempotent application to
    // records/plan.steps replays).
    const admin = new FakeAdmin()
    setAdmin(admin)
    const runId = 'run-replan-deadline'
    const plan: Plan = {
      goal: 'test goal',
      steps: [{ label: 'seed', agent_type: 'sourcer', input: {}, dependsOn: [] }],
    }
    seedRun(admin, runId, plan)

    let mockNow = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => mockNow)

    impls.sourcer = vi.fn(async (): Promise<AgentResult> => {
      mockNow += 10_000_000_000 // past MAX_RUN_MS before the wave loop re-checks the deadline
      return {
        output: { jobIds: ['j1'], found: 1, inserted: 1 },
        tokensUsed: 1,
        replanRequest: {
          reason: 'found a promising job, score it',
          steps: [{ label: 'extra', agent_type: 'matcher', input: {}, dependsOn: [] }],
        },
      }
    })
    let extraRan = false
    impls.matcher = vi.fn(async () => {
      extraRan = true
      return { output: { matches: [], topJobIds: [] }, tokensUsed: 1 }
    })

    const saver = new MemorySaver()
    const config = makeConfig('t-replan-deadline', 'user-1', saver)

    const first = await harnessRunGraph.invoke({ runId }, config)
    expect(first).toEqual(expect.objectContaining({ __interrupt__: expect.any(Array) }))
    expect(extraRan).toBe(false) // "extra" was added but never ran before the pause

    const replanRowPaused = journaledStep(admin, '__replan-1')
    expect(stepStatus(replanRowPaused)).toBe('completed')
    expect(stepAttrs(replanRowPaused).output).toEqual(
      expect.objectContaining({ accepted: true, addedLabels: ['extra'] })
    )

    nowSpy.mockRestore()
    const second = await harnessRunGraph.invoke(null, config)

    expect((second as { status: string }).status).toBe('completed')
    expect(extraRan).toBe(true)
    expect((second as { replanEvents: unknown }).replanEvents).toEqual([
      { fromLabel: 'seed', accepted: true, reason: 'found a promising job, score it', addedLabels: ['extra'] },
    ])
    expect((second as { steps: { label: string }[] }).steps.map((s) => s.label).sort()).toEqual(['extra', 'seed'])

    // The journal row must still read accepted, not silently overwritten.
    const replanRowFinal = journaledStep(admin, '__replan-1')
    expect(stepStatus(replanRowFinal)).toBe('completed')
    expect(stepAttrs(replanRowFinal).output).toEqual(expect.objectContaining({ accepted: true, addedLabels: ['extra'] }))

    // And the persisted plan carries "extra" exactly once, not duplicated.
    const runRow = admin.getRow('agent_runs', runId)!
    const persistedPlan = runRow.plan as Plan
    expect(persistedPlan.steps.map((s) => s.label)).toEqual(['seed', 'extra'])
  })
})

describe('harnessRunGraph — plannerTask strips untrusted autoSubmit (runtime proof)', () => {
  it('an applier step the stubbed planner marks autoSubmit:true is persisted/executed with autoSubmit:false', async () => {
    const admin = new FakeAdmin()
    setAdmin(admin)
    const runId = 'run-strip-submit'
    seedRun(admin, runId, null, { goal: 'apply to the first good match' }) // no plan -> plannerTask runs

    planGoalMock.mockResolvedValue({
      fallback: false,
      tokensUsed: 42,
      plan: {
        goal: 'apply to the first good match',
        steps: [{ label: 'submit', agent_type: 'applier', input: { jobId: 'j1', autoSubmit: true }, dependsOn: [] }],
      },
    })

    let seenAutoSubmit: unknown
    impls.applier = vi.fn(async (ctx) => {
      seenAutoSubmit = (ctx.input as { autoSubmit?: boolean }).autoSubmit
      return { output: { draftId: 'd1', status: 'pending_review' }, tokensUsed: 3 }
    })

    const saver = new MemorySaver()
    const outcome = await harnessRunGraph.invoke({ runId }, makeConfig('t-strip-submit', 'user-1', saver))

    expect(outcome.status).toBe('completed')
    expect(seenAutoSubmit).toBe(false) // stripped before the step ever ran

    const runRow = admin.getRow('agent_runs', runId)!
    const persistedPlan = runRow.plan as Plan
    expect((persistedPlan.steps[0].input as { autoSubmit?: boolean }).autoSubmit).toBe(false) // stripped before it was ever persisted
  })
})
