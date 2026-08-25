// Tests for lib/harness/executor.ts's runAgentRun — specifically the
// RESUMPTION contract described at the top of that file:
//   - a step already `completed` from a prior attempt is ADOPTED (its stored
//     output reused, its agent NEVER called again) — this is what stops the
//     product re-spending money on work it already did.
//   - a run that pauses at its wall-clock DEADLINE ends in the resumable
//     'incomplete' status with its not-yet-run steps left `pending`.
//   - a run that stops because the BUDGET is exhausted NEVER becomes
//     'incomplete' — its remaining steps are marked `skipped`, and even a
//     second runAgentRun call against it spends nothing further.
//   - loop bounds hold: a step's `loop.maxIterations` is a hard ceiling that
//     is never exceeded, and the loop stops as soon as its `until` condition
//     is met rather than always running to the ceiling.
//
// ZERO network, ZERO real LLM calls, ZERO real DB. Every agent invocation is
// a test-controlled fake registered in `mockState.handlers`; AdminClient is
// an in-memory fake table store (see FakeAdmin below) built to support the
// exact PostgREST chain shapes executor.ts issues against agent_runs /
// agent_steps. './llm', './keys', './registry', and the agentSchemas half of
// './schemas' are mocked; './dynamic' (loop/fan-out control flow) and the
// rest of './schemas' are the REAL modules, since they're pure and are
// exactly the control flow this file means to exercise.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminClient, AgentRunRow, Plan } from './types'

// --- test-controlled agent registry -----------------------------------------

const mockState = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: { stepLabel: string }) => Promise<{ output: unknown; tokensUsed?: number }>>(),
  callLog: [] as string[],
}))

vi.mock('./registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./registry')>()
  return {
    ...actual,
    getAgent: () => async (ctx: { stepLabel: string }) => {
      mockState.callLog.push(ctx.stepLabel)
      const base = ctx.stepLabel.replace(/#\d+$/, '')
      const handler = mockState.handlers.get(ctx.stepLabel) ?? mockState.handlers.get(base)
      if (!handler) throw new Error(`no test handler registered for step "${ctx.stepLabel}"`)
      return handler(ctx)
    },
  }
})

vi.mock('./keys', () => ({
  loadApiKeys: vi.fn().mockResolvedValue({ openrouter: 'fake-key', userId: 'user-1' }),
}))

// callLlm must never be reached — every test agent returns its output
// directly without touching ctx.llm, so a call here would mean a test is
// accidentally exercising a real-shaped LLM path.
vi.mock('./llm', () => ({
  callLlm: vi.fn().mockRejectedValue(new Error('callLlm must not be called — executor tests use fake agents only')),
}))

// Only agentSchemas is replaced (permissive — this file tests orchestration,
// not per-agent output shape validation); everything else (PlanStepSchema,
// detectCycle, stripUntrustedSubmit, STEP_AGENT_TYPES...) stays real.
vi.mock('./schemas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./schemas')>()
  const permissive = { safeParse: (v: unknown) => ({ success: true, data: v }) }
  return {
    ...actual,
    agentSchemas: new Proxy({}, { get: () => ({ output: permissive, input: permissive }) }),
  }
})

// --- minimal in-memory fake of the PostgREST chains executor.ts issues -----

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
  private filters: { col: string; op: 'eq' | 'is' | 'in'; val: unknown }[] = []
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
  in(col: string, vals: unknown[]) {
    this.filters.push({ col, op: 'in', val: vals })
    return this
  }
  lt(_col: string, _val: unknown) {
    return this
  }
  order(_col: string, _opts?: unknown) {
    return this
  }
  limit(_n: number) {
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
      if (op === 'is') return val === null ? rowVal === null || rowVal === undefined : rowVal === val
      if (op === 'in') return Array.isArray(val) && val.includes(rowVal)
      return true
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

function seedRun(admin: FakeAdmin, runId: string, plan: Plan, overrides: Partial<AgentRunRow> = {}): void {
  admin.seed('agent_runs', {
    id: runId,
    user_id: 'user-1',
    goal: 'test goal',
    status: 'queued',
    plan: plan as unknown as Record<string, unknown>,
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

const SEQUENTIAL_PLAN: Plan = {
  goal: 'test goal',
  steps: [
    { label: 'a', agent_type: 'sourcer', input: {}, dependsOn: [] },
    { label: 'b', agent_type: 'sourcer', input: {}, dependsOn: ['a'] },
  ],
}

let runAgentRun: typeof import('./executor').runAgentRun

beforeEach(async () => {
  vi.resetModules()
  mockState.handlers.clear()
  mockState.callLog.length = 0
  ;({ runAgentRun } = await import('./executor'))
})

afterEach(() => {
  vi.restoreAllMocks()
})

function callCount(label: string): number {
  return mockState.callLog.filter((l) => l === label).length
}

describe('runAgentRun — RESUMPTION: a completed step is ADOPTED, never re-executed', () => {
  it('a run interrupted after step "a" completes leaves "b" pending; a second call adopts "a" and only runs "b"', async () => {
    const admin = new FakeAdmin()
    const runId = 'run-1'
    seedRun(admin, runId, SEQUENTIAL_PLAN)

    // Control the wall-clock deadline deterministically: jump Date.now() far
    // forward the moment step "a" resolves, so the NEXT wave-scheduler pass
    // (right before "b" would dispatch) sees the deadline as already blown.
    let mockNow = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => mockNow)

    mockState.handlers.set('a', async () => {
      mockNow += 10_000_000_000 // jump far past MAX_RUN_MS
      return { output: { step: 'a', done: true }, tokensUsed: 10 }
    })
    mockState.handlers.set('b', async () => ({ output: { step: 'b', done: true }, tokensUsed: 7 }))

    const outcome1 = await runAgentRun(admin as unknown as AdminClient, runId)

    expect(outcome1.status).toBe('incomplete')
    expect(outcome1.aborted).toBe('deadline')
    const aStep1 = outcome1.steps.find((s) => s.label === 'a')!
    const bStep1 = outcome1.steps.find((s) => s.label === 'b')!
    expect(aStep1.status).toBe('completed')
    expect(bStep1.status).toBe('pending') // left pending, not skipped — this is what makes it resumable
    expect(callCount('a')).toBe(1)
    expect(callCount('b')).toBe(0)

    // The persisted agent_steps row for "b" is genuinely still pending in the DB too.
    const bRowAfterCall1 = admin.allRows('agent_steps').find((r) => r.label === 'b')!
    expect(bRowAfterCall1.status).toBe('pending')
    const aRowAfterCall1 = admin.allRows('agent_steps').find((r) => r.label === 'a')!
    expect(aRowAfterCall1.status).toBe('completed')
    const aFinishedAtAfterCall1 = aRowAfterCall1.finished_at

    // --- Second call: simulate a resumption re-entry (e.g. the cron picking
    // up the 'incomplete' run). Stop advancing the clock so "b" gets a full
    // fresh deadline window and can actually complete this time.
    mockState.callLog.length = 0
    nowSpy.mockRestore()

    const outcome2 = await runAgentRun(admin as unknown as AdminClient, runId)

    expect(outcome2.status).toBe('completed')
    // "a" was ADOPTED — its agent was never invoked on the second call at all.
    expect(callCount('a')).toBe(0)
    expect(callCount('b')).toBe(1)

    const aStep2 = outcome2.steps.find((s) => s.label === 'a')!
    const bStep2 = outcome2.steps.find((s) => s.label === 'b')!
    expect(aStep2.status).toBe('completed')
    expect(bStep2.status).toBe('completed')

    // Token accounting proves it too: only "b"'s 7 tokens were newly spent —
    // if "a" had been re-run, spent would have double-counted its 10.
    expect(outcome2.spentTokens).toBe(17) // 10 (a, from call 1) + 7 (b, from call 2)

    // The adopted row for "a" was never rewritten — same finished_at as after call 1.
    const aRowAfterCall2 = admin.allRows('agent_steps').find((r) => r.label === 'a')!
    expect(aRowAfterCall2.finished_at).toBe(aFinishedAtAfterCall1)
  })
})

describe('runAgentRun — a deadline-stopped run is resumable; a budget-stopped run is NOT', () => {
  it('deadline stop -> status "incomplete", remaining step left "pending"', async () => {
    const admin = new FakeAdmin()
    const runId = 'run-deadline'
    seedRun(admin, runId, SEQUENTIAL_PLAN, { budget_tokens: 100_000 })

    let mockNow = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => mockNow)
    mockState.handlers.set('a', async () => {
      mockNow += 10_000_000_000
      return { output: { ok: true }, tokensUsed: 5 }
    })
    mockState.handlers.set('b', async () => ({ output: { ok: true }, tokensUsed: 5 }))

    const outcome = await runAgentRun(admin as unknown as AdminClient, runId)

    expect(outcome.status).toBe('incomplete')
    expect(outcome.aborted).toBe('deadline')
    expect(outcome.steps.find((s) => s.label === 'b')!.status).toBe('pending')
  })

  it('budget exhaustion -> status is NEVER "incomplete"; the remaining step is "skipped", not "pending"', async () => {
    const admin = new FakeAdmin()
    const runId = 'run-budget'
    // Budget small enough that step "a" alone blows through it.
    seedRun(admin, runId, SEQUENTIAL_PLAN, { budget_tokens: 5 })

    mockState.handlers.set('a', async () => ({ output: { ok: true }, tokensUsed: 20 }))
    mockState.handlers.set('b', async () => ({ output: { ok: true }, tokensUsed: 20 }))

    const outcome = await runAgentRun(admin as unknown as AdminClient, runId)

    expect(outcome.status).not.toBe('incomplete')
    expect(outcome.status).toBe('completed_with_errors')
    expect(outcome.aborted).toBe('budget')
    const bStep = outcome.steps.find((s) => s.label === 'b')!
    expect(bStep.status).toBe('skipped')
    expect(bStep.error).toMatch(/budget exhausted/i)
    expect(callCount('b')).toBe(0) // never even attempted
  })

  it('re-invoking a budget-stopped run a second time spends NOTHING further and never runs the skipped step', async () => {
    const admin = new FakeAdmin()
    const runId = 'run-budget-2'
    seedRun(admin, runId, SEQUENTIAL_PLAN, { budget_tokens: 5 })

    mockState.handlers.set('a', async () => ({ output: { ok: true }, tokensUsed: 20 }))
    mockState.handlers.set('b', async () => ({ output: { ok: true }, tokensUsed: 999 })) // would blow up spend if ever run

    const outcome1 = await runAgentRun(admin as unknown as AdminClient, runId)
    expect(outcome1.status).toBe('completed_with_errors')
    expect(admin.getRow('agent_runs', runId)!.spent_tokens).toBe(20)

    mockState.callLog.length = 0
    const outcome2 = await runAgentRun(admin as unknown as AdminClient, runId)

    // Still not resumed into real progress: no new spend, "b" still never dispatched.
    expect(callCount('a')).toBe(0) // adopted
    expect(callCount('b')).toBe(0) // gated by budget before dispatch, every time
    expect(admin.getRow('agent_runs', runId)!.spent_tokens).toBe(20) // unchanged
    expect(outcome2.status).not.toBe('incomplete')
  })
})

describe('runAgentRun — loop bounds hold', () => {
  it('never exceeds loop.maxIterations even when the until condition is never met', async () => {
    const admin = new FakeAdmin()
    const runId = 'run-loop-ceiling'
    const plan: Plan = {
      goal: 'test goal',
      steps: [
        {
          label: 'poll',
          agent_type: 'sourcer',
          input: {},
          dependsOn: [],
          loop: { maxIterations: 3, until: { key: 'count', op: 'gte', value: 100 } },
        },
      ],
    }
    seedRun(admin, runId, plan)
    // NOTE: ctx.stepLabel for a loop iteration is the STEP's own label
    // ('poll') on every iteration — the per-iteration "poll#N" label only
    // exists in the agent_steps journal, not in what the agent function
    // receives — so iteration tracking here uses a local counter, not the
    // step label.
    let iter = 0
    mockState.handlers.set('poll', async () => {
      iter += 1
      return { output: { count: iter * 10 }, tokensUsed: 1 } // 10, 20, 30 — always progressing, never reaches 100
    })

    const outcome = await runAgentRun(admin as unknown as AdminClient, runId)

    const step = outcome.steps.find((s) => s.label === 'poll')!
    expect(step.loop?.iterations).toBe(3) // exactly the ceiling, never more
    expect(step.loop?.stopReason).toBe('max-iterations')
    expect(callCount('poll')).toBe(3) // the agent itself was dispatched exactly 3 times, never a 4th
  })

  it('stops as soon as the until condition is met, well before maxIterations', async () => {
    const admin = new FakeAdmin()
    const runId = 'run-loop-early-stop'
    const plan: Plan = {
      goal: 'test goal',
      steps: [
        {
          label: 'poll',
          agent_type: 'sourcer',
          input: {},
          dependsOn: [],
          loop: { maxIterations: 5, until: { key: 'count', op: 'gte', value: 100 } },
        },
      ],
    }
    seedRun(admin, runId, plan)
    let iter = 0
    mockState.handlers.set('poll', async () => {
      iter += 1
      return { output: { count: iter === 2 ? 150 : 10 }, tokensUsed: 1 }
    })

    const outcome = await runAgentRun(admin as unknown as AdminClient, runId)

    const step = outcome.steps.find((s) => s.label === 'poll')!
    expect(step.loop?.iterations).toBe(2)
    expect(step.loop?.stopReason).toBe('condition-met')
    expect(callCount('poll')).toBe(2) // never ran a 3rd time once satisfied
  })
})
