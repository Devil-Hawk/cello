// Tests for lib/graph/journal.ts — idempotent agent_runs/trace_spans writes
// keyed on (run_id, label, iteration) rather than a remembered row id, which
// is the shape LangGraph Functional-API replay needs (see that file's
// header). The central claim under test: calling journalStepStart or
// journalStepFinish TWICE with the same key produces ONE row, updated in
// place — never a duplicate — even though the backing store is trace_spans,
// a table lib/trace/spans.ts's own withSpan ALSO writes kind='node' rows
// into (see journal.ts's header on why the two coexist and how
// isJournaledStepRow tells them apart).
//
// ZERO network, ZERO real DB — same fake-PostgREST-chain style as
// lib/graph/invoke.test.ts and lib/harness/pre-migration-schema.test.ts.

import { beforeEach, describe, expect, it } from 'vitest'
import type { AdminClient } from '../harness/types'
import {
  isJournaledStepRow,
  journalStepFinish,
  journalStepOutput,
  journalStepStart,
  markRunPaused,
  markRunRunning,
  markRunTerminal,
  stepRowToAgentStepRow,
} from './journal'

interface Row extends Record<string, unknown> {}

class FakeTable {
  rows: Row[] = []
  seq = 0
  constructor(private idField: string) {}
  nextId(): string {
    this.seq += 1
    return `${this.idField}-${this.seq}`
  }
}

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: { col: string; op: 'eq' | 'is'; val: unknown }[] = []
  private mode: 'select' | 'insert' | 'update' = 'select'
  private patch: Record<string, unknown> | null = null
  private insertRow: Record<string, unknown> | null = null

  constructor(
    private table: FakeTable,
    private pk: string
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
  insert(row: Record<string, unknown>) {
    this.mode = 'insert'
    this.insertRow = row
    return this
  }
  update(patch: Record<string, unknown>) {
    this.mode = 'update'
    this.patch = patch
    return this
  }

  private matches(row: Row): boolean {
    return this.filters.every(({ col, op, val }) => (op === 'is' && val === null ? row[col] == null : row[col] === val))
  }

  private exec(): { data: unknown; error: unknown } {
    if (this.mode === 'insert') {
      const row: Row = { [this.pk]: this.table.nextId(), ...this.insertRow }
      this.table.rows.push(row)
      return { data: row, error: null }
    }
    if (this.mode === 'update') {
      const matched = this.table.rows.filter((r) => this.matches(r))
      for (const r of matched) Object.assign(r, this.patch)
      return { data: matched, error: null }
    }
    return { data: this.table.rows.filter((r) => this.matches(r)), error: null }
  }

  async maybeSingle() {
    const { data, error } = this.exec()
    const rows = (Array.isArray(data) ? data : [data]) as (Row | null)[]
    return { data: rows[0] ?? null, error }
  }
  async single() {
    const { data, error } = this.exec()
    const rows = (Array.isArray(data) ? data : [data]) as (Row | null)[]
    return { data: rows[0] ?? null, error }
  }
  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.exec()).then(onfulfilled, onrejected)
  }
}

function makeFakeAdmin() {
  const tables = {
    trace_spans: new FakeTable('span_id'),
    agent_runs: new FakeTable('id'),
  }
  const admin = {
    from: (name: string) => {
      const table = (tables as Record<string, FakeTable>)[name]
      if (!table) throw new Error(`fake admin: unhandled table "${name}"`)
      return new FakeQuery(table, name === 'trace_spans' ? 'span_id' : 'id')
    },
  } as unknown as AdminClient
  return { admin, tables }
}

/** Every journalStepStart/Finish call in this file resolves user_id off the
 *  run row (trace_spans.user_id is NOT NULL) — see journal.ts's
 *  lookupRunUserId. */
function seedRun(tables: ReturnType<typeof makeFakeAdmin>['tables'], runId: string, userId = 'user-1'): void {
  tables.agent_runs.rows.push({ id: runId, user_id: userId })
}

describe('journalStepStart / journalStepFinish — idempotent upsert by (run_id, label, iteration)', () => {
  let admin: AdminClient
  let tables: ReturnType<typeof makeFakeAdmin>['tables']

  beforeEach(() => {
    ;({ admin, tables } = makeFakeAdmin())
    seedRun(tables, 'run-1')
  })

  it('journalStepStart called twice with the same key updates one row, never duplicates', async () => {
    const id1 = await journalStepStart(admin, { runId: 'run-1', agentType: 'matcher', label: 'match', input: { a: 1 } })
    const id2 = await journalStepStart(admin, { runId: 'run-1', agentType: 'matcher', label: 'match', input: { a: 2 } })

    expect(id1).toBe(id2)
    expect(tables.trace_spans.rows).toHaveLength(1)
    const row = tables.trace_spans.rows[0]!
    expect(row.kind).toBe('node')
    expect(row.name).toBe('match')
    const attrs = row.attributes as Record<string, unknown>
    expect(attrs.input).toEqual({ a: 2 })
    expect(attrs.stepStatus).toBe('running')
    expect(row.status).toBeNull() // open span — no ok/error yet
  })

  it('journalStepFinish called twice with the same key updates one row, never duplicates', async () => {
    await journalStepStart(admin, { runId: 'run-1', agentType: 'matcher', label: 'match', input: {} })

    const id1 = await journalStepFinish(admin, {
      runId: 'run-1',
      agentType: 'matcher',
      label: 'match',
      status: 'completed',
      output: { score: 1 },
      tokensUsed: 10,
    })
    const id2 = await journalStepFinish(admin, {
      runId: 'run-1',
      agentType: 'matcher',
      label: 'match',
      status: 'completed',
      output: { score: 2 },
      tokensUsed: 20,
    })

    expect(id1).toBe(id2)
    expect(tables.trace_spans.rows).toHaveLength(1)
    const row = tables.trace_spans.rows[0]!
    const attrs = row.attributes as Record<string, unknown>
    expect(attrs.output).toEqual({ score: 2 })
    expect(attrs.tokensUsed).toBe(20)
    expect(row.status).toBe('ok')
  })

  it('journalStepFinish with no prior journalStepStart still lands exactly one row (defensive insert path)', async () => {
    await journalStepFinish(admin, {
      runId: 'run-1',
      agentType: 'matcher',
      label: 'match',
      status: 'completed',
      output: { score: 1 },
      tokensUsed: 5,
    })
    expect(tables.trace_spans.rows).toHaveLength(1)
    const row = tables.trace_spans.rows[0]!
    expect((row.attributes as Record<string, unknown>).stepStatus).toBe('completed')
    // trace_spans.start_time is NOT NULL with no default — a defensive
    // insert with only end_time supplied must still populate it, or the
    // equivalent call against a real Postgres instance throws and this row
    // silently never lands.
    expect(typeof row.start_time).toBe('string')
    expect(row.start_time).toBe(row.end_time)
  })

  it('a failed finish projects to status "error"; a skipped finish still projects to "ok"', async () => {
    await journalStepFinish(admin, {
      runId: 'run-1',
      agentType: 'matcher',
      label: 'failing-step',
      status: 'failed',
      output: { error: 'boom' },
      tokensUsed: 0,
    })
    await journalStepFinish(admin, {
      runId: 'run-1',
      agentType: 'matcher',
      label: 'skipped-step',
      status: 'skipped',
      output: { skipped: 'dep failed' },
      tokensUsed: 0,
    })
    const failed = tables.trace_spans.rows.find((r) => r.name === 'failing-step')!
    const skipped = tables.trace_spans.rows.find((r) => r.name === 'skipped-step')!
    expect(failed.status).toBe('error')
    expect(skipped.status).toBe('ok')
  })

  it('distinguishes loop iterations by the iteration column, not just the label', async () => {
    await journalStepStart(admin, { runId: 'run-1', agentType: 'matcher', label: 'loop#1', input: {}, iteration: 1 })
    await journalStepStart(admin, { runId: 'run-1', agentType: 'matcher', label: 'loop#2', input: {}, iteration: 2 })
    // Same key repeated (label + iteration) still collapses to one row.
    await journalStepStart(admin, { runId: 'run-1', agentType: 'matcher', label: 'loop#1', input: { retry: true }, iteration: 1 })

    expect(tables.trace_spans.rows).toHaveLength(2)
    const iter1 = tables.trace_spans.rows.find((r) => (r.attributes as Record<string, unknown>).iteration === 1)
    expect((iter1?.attributes as Record<string, unknown>).input).toEqual({ retry: true })
  })

  it('a plain step (no iteration) and a same-labelled iteration never collide', async () => {
    await journalStepStart(admin, { runId: 'run-1', agentType: 'matcher', label: 'match', input: {} })
    await journalStepStart(admin, { runId: 'run-1', agentType: 'matcher', label: 'match', input: {}, iteration: 1 })
    expect(tables.trace_spans.rows).toHaveLength(2)
  })

  it('keeps runs apart: the same label in two different runs never collapses into one row', async () => {
    seedRun(tables, 'run-2')
    await journalStepStart(admin, { runId: 'run-1', agentType: 'matcher', label: 'match', input: {} })
    await journalStepStart(admin, { runId: 'run-2', agentType: 'matcher', label: 'match', input: {} })
    expect(tables.trace_spans.rows).toHaveLength(2)
  })

  it('never mistakes a spans.ts-authored node span sharing (run_id, name) for its own row', async () => {
    // lib/trace/spans.ts's own withSpan writes a kind='node' row with the
    // SAME name for the same unit call, but carries no attributes.stepStatus
    // — exactly what isJournaledStepRow exists to tell apart (see file
    // header). Simulate that row already existing before this file ever
    // touches the key.
    tables.trace_spans.rows.push({
      span_id: 'span-from-spans-ts',
      run_id: 'run-1',
      kind: 'node',
      name: 'match',
      attributes: { agentType: 'matcher', label: 'match', tokensUsed: 5 }, // no stepStatus
    })

    const id = await journalStepStart(admin, { runId: 'run-1', agentType: 'matcher', label: 'match', input: {} })

    expect(id).not.toBe('span-from-spans-ts')
    expect(tables.trace_spans.rows).toHaveLength(2)
    const ownRow = tables.trace_spans.rows.find((r) => r.span_id === id)!
    expect(isJournaledStepRow(ownRow)).toBe(true)
    const untouched = tables.trace_spans.rows.find((r) => r.span_id === 'span-from-spans-ts')!
    expect(untouched.attributes).toEqual({ agentType: 'matcher', label: 'match', tokensUsed: 5 })
  })

  it('journalStepOutput reads back a finished step by key, without ever remembering its row id', async () => {
    await journalStepFinish(admin, {
      runId: 'run-1',
      agentType: 'planner',
      label: '__replan-1',
      status: 'completed',
      output: { accepted: true, reason: 'budget freed up', addedLabels: ['extra-step'] },
      tokensUsed: 0,
    })

    const output = await journalStepOutput(admin, { runId: 'run-1', label: '__replan-1' })
    expect(output).toEqual({ accepted: true, reason: 'budget freed up', addedLabels: ['extra-step'] })
    expect(await journalStepOutput(admin, { runId: 'run-1', label: 'never-journaled' })).toBeNull()
  })
})

describe('stepRowToAgentStepRow — the seam translation back to the pre-port shape', () => {
  it('maps a journaled trace_spans row onto AgentStepRow field-for-field', () => {
    const mapped = stepRowToAgentStepRow({
      span_id: 'span-1',
      run_id: 'run-1',
      parent_span_id: null,
      name: 'match',
      kind: 'node',
      start_time: '2026-08-18T00:00:00.000Z',
      end_time: '2026-08-18T00:01:00.000Z',
      attributes: { agentType: 'matcher', stepStatus: 'completed', iteration: null, input: { a: 1 }, output: { scored: 3 }, tokensUsed: 42 },
    })

    expect(mapped).toEqual({
      id: 'span-1',
      run_id: 'run-1',
      agent_type: 'matcher',
      label: 'match',
      status: 'completed',
      input: { a: 1 },
      output: { scored: 3 },
      tokens_used: 42,
      started_at: '2026-08-18T00:00:00.000Z',
      finished_at: '2026-08-18T00:01:00.000Z',
      created_at: '2026-08-18T00:00:00.000Z',
      parent_step_id: null,
      iteration: null,
    })
  })
})

describe('agent_runs status writers', () => {
  let admin: AdminClient
  let tables: ReturnType<typeof makeFakeAdmin>['tables']

  beforeEach(() => {
    ;({ admin, tables } = makeFakeAdmin())
    tables.agent_runs.rows.push({ id: 'run-1', status: 'queued' })
  })

  it('markRunRunning sets status to running', async () => {
    await markRunRunning(admin, 'run-1')
    expect(tables.agent_runs.rows[0].status).toBe('running')
  })

  it('markRunRunning writes thread_id in the same update when supplied', async () => {
    await markRunRunning(admin, 'run-1', '2026-08-16T00:00:00.000Z', 'thread-abc')
    expect(tables.agent_runs.rows[0].status).toBe('running')
    expect(tables.agent_runs.rows[0].started_at).toBe('2026-08-16T00:00:00.000Z')
    expect(tables.agent_runs.rows[0].thread_id).toBe('thread-abc')
  })

  it('markRunRunning leaves thread_id untouched when not supplied', async () => {
    await markRunRunning(admin, 'run-1')
    expect(tables.agent_runs.rows[0].thread_id).toBeUndefined()
  })

  it('markRunPaused sets status to paused (graph-native, distinct from the pre-port "incomplete")', async () => {
    await markRunPaused(admin, 'run-1')
    expect(tables.agent_runs.rows[0].status).toBe('paused')
  })

  it('markRunTerminal sets a terminal status and finished_at, and carries error/result through', async () => {
    await markRunTerminal(admin, 'run-1', 'failed', { error: 'boom' })
    expect(tables.agent_runs.rows[0].status).toBe('failed')
    expect(tables.agent_runs.rows[0].error).toBe('boom')
    expect(tables.agent_runs.rows[0].finished_at).toBeTruthy()
  })

  it('markRunTerminal(completed) carries the result through', async () => {
    await markRunTerminal(admin, 'run-1', 'completed', { result: { ok: true } })
    expect(tables.agent_runs.rows[0].status).toBe('completed')
    expect(tables.agent_runs.rows[0].result).toEqual({ ok: true })
  })
})
