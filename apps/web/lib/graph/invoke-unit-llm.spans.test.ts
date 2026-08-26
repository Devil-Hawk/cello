// End-to-end span-parentage test for Step 2 of the langgraph port: the REAL
// lib/graph/invoke.ts -> lib/graph/unit.ts -> lib/harness/llm.ts call chain
// (not a hand-simulated stand-in — lib/trace/spans.test.ts already covers
// the primitive mechanism directly) produces exactly the tree the spec asks
// for: one root 'graph' span, a 'node' span nested under it for the unit,
// an 'llm' span nested under THAT for the model call, flushed as one
// batched insert at the very end of invokeGraphForUser.
//
// ZERO network, ZERO real DB/LangGraph: './pg' and the model provider are
// mocked; the "compiled graph" invoke.ts drives is a fake whose invoke()
// calls the REAL runAgentUnit directly (same shape lib/graph/oneshot.ts and
// lib/graph/runs.ts's makeUnitTask do) — same fake-PostgREST-chain style as
// lib/graph/invoke.test.ts and lib/graph/unit.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminClient, AgentFn } from '../harness/types'

vi.mock('./pg', () => ({
  withCheckpointer: async (fn: (saver: unknown) => Promise<unknown>) => fn({ fakeSaver: true }),
}))

const loadApiKeysMock = vi.fn()
vi.mock('../harness/keys', () => ({
  loadApiKeys: (...args: unknown[]) => loadApiKeysMock(...args),
}))

const impls: Partial<Record<string, AgentFn>> = {}
vi.mock('../harness/registry', () => ({
  UNIT_REGISTRY: new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        const fn = impls[prop]
        if (!fn) throw new Error(`no impl registered for unit type "${prop}"`)
        return fn
      },
    }
  ),
}))

const callOpenRouterMock = vi.fn()
vi.mock('../harness/providers/openrouter', () => ({
  callOpenRouter: (...args: unknown[]) => callOpenRouterMock(...args),
  DEFAULT_MODEL: 'anthropic/claude-sonnet-5',
}))

vi.mock('../harness/spend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../harness/spend')>()
  return { ...actual, assertWithinBudget: async () => undefined, recordSpend: async () => undefined }
})

// callLlm's metered path builds its own admin client for the budget guards
// above (both stubbed no-ops) — never used for anything else in this test,
// since the span buffer callLlm joins here is the ambient one invoke.ts
// created (scope.owns is false), so callLlm never flushes it itself.
vi.mock('../harness/supabase-admin', () => ({
  createAdminClient: () => ({ __unused: true }),
}))

import { invokeGraphForUser, type CompiledGraphLike } from './invoke'
import { runAgentUnit } from './unit'
import { isJournaledStepRow } from './journal'

// --- fake admin: graph_threads + agent_runs + a trace_spans capturer -------

interface Row extends Record<string, unknown> {}

class FakeTable {
  rows: Row[] = []
  seq = 0
  constructor(private idField: string, private idPrefix: string) {}
  nextId(): string {
    this.seq += 1
    return `${this.idPrefix}-${this.seq}`
  }
}

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: { col: string; op: 'eq' | 'is'; val: unknown }[] = []
  private mode: 'select' | 'insert' | 'update' = 'select'
  private patch: Record<string, unknown> | null = null
  private insertPayload: Record<string, unknown> | Record<string, unknown>[] | null = null
  constructor(private table: FakeTable) {}
  select(_c?: string) {
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
  insert(payload: Record<string, unknown> | Record<string, unknown>[]) {
    this.mode = 'insert'
    this.insertPayload = payload
    return this
  }
  update(patch: Record<string, unknown>) {
    this.mode = 'update'
    this.patch = patch
    return this
  }
  private matches(row: Row) {
    return this.filters.every(({ col, op, val }) => (op === 'is' && val === null ? row[col] == null : row[col] === val))
  }
  private exec(): { data: unknown; error: unknown } {
    if (this.mode === 'insert') {
      if (Array.isArray(this.insertPayload)) {
        const rows = this.insertPayload.map((r) => ({ id: this.table.nextId(), ...r }))
        this.table.rows.push(...rows)
        return { data: rows, error: null }
      }
      const row: Row = { id: this.table.nextId(), ...this.insertPayload }
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
    return this.maybeSingle()
  }
  then<T1 = { data: unknown; error: unknown }, T2 = never>(
    onf?: ((v: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null,
    onr?: ((e: unknown) => T2 | PromiseLike<T2>) | null
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.exec()).then(onf, onr)
  }
}

function makeFakeAdmin() {
  const tables = {
    graph_threads: new FakeTable('thread_id', 'thread'),
    // runAgentUnit's own journaling (lib/graph/journal.ts) resolves a new
    // step row's user_id off this table (trace_spans.user_id is NOT NULL) —
    // the domain agent_runs row a real harness run would already have.
    agent_runs: new FakeTable('id', 'run'),
    trace_spans: new FakeTable('span_id', 'span'),
  }
  const admin = {
    from: (name: string) => {
      const table = (tables as Record<string, FakeTable>)[name]
      if (!table) throw new Error(`fake admin: unhandled table "${name}"`)
      return new FakeQuery(table)
    },
  } as unknown as AdminClient
  return { admin, tables }
}

const OWNER = 'user-owner'
const FAKE_LLM_RESULT = { content: 'ok', tokensUsed: 5, promptTokens: 3, completionTokens: 2, model: 'anthropic/claude-sonnet-5' }

describe('invoke.ts -> unit.ts -> llm.ts: real span parentage end to end', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const k of Object.keys(impls)) delete impls[k]
    loadApiKeysMock.mockResolvedValue({ userId: OWNER, provider: { active: 'openrouter' } })
    callOpenRouterMock.mockResolvedValue(FAKE_LLM_RESULT)
  })

  it('one graph invocation running one unit that makes one llm call flushes 3 spans: graph -> node -> llm', async () => {
    const { admin, tables } = makeFakeAdmin()
    tables.graph_threads.rows.push({
      thread_id: 'thread-1',
      user_id: OWNER,
      surface: 'run',
      expires_at: null,
      run_id: null,
      conversation_id: null,
    })
    tables.agent_runs.rows.push({ id: 'run-domain-1', user_id: OWNER })

    impls.sourcer = async (ctx) => {
      await ctx.llm({ prompt: 'find jobs' })
      return { output: { jobIds: [], found: 0, inserted: 0 }, tokensUsed: 0 }
    }

    const graph: CompiledGraphLike = {
      invoke: async (_input, config) => {
        const configurable = config.configurable as { userId: string; threadId: string }
        return runAgentUnit('sourcer', {
          input: {},
          admin,
          // The domain agent_runs.id a real harness run would already have
          // (lib/graph/runs.ts's makeUnitTask builds this same shape) — NOT
          // invoke.ts's own per-invocation configurable.runId, which is a
          // different id entirely (see invoke.ts's own header).
          config: { configurable: { userId: configurable.userId, runId: 'run-domain-1', threadId: configurable.threadId } },
        })
      },
      getState: async () => ({ config: { configurable: {} } }),
    }

    await invokeGraphForUser({ admin, userId: OWNER, surface: 'run', graph, threadId: 'thread-1' })

    const rows = tables.trace_spans.rows
    // 3 from lib/trace/spans.ts's own buffered flush (graph/node/llm) PLUS
    // ONE more from lib/graph/journal.ts's direct, synchronous write for the
    // 'sourcer' unit call — a SEPARATE kind='node' row, not a 4th kind. See
    // journal.ts's header for why the two coexist rather than merging.
    expect(rows).toHaveLength(4)

    const graphSpan = rows.find((r) => r.kind === 'graph')!
    const nodeSpans = rows.filter((r) => r.kind === 'node')
    const bufferedNodeSpan = nodeSpans.find((r) => !isJournaledStepRow(r as { kind?: unknown; attributes?: unknown }))!
    const journaledNodeSpan = nodeSpans.find((r) => isJournaledStepRow(r as { kind?: unknown; attributes?: unknown }))!
    const llmSpan = rows.find((r) => r.kind === 'llm')!

    expect(nodeSpans).toHaveLength(2)
    expect(graphSpan).toMatchObject({ name: 'run', parent_span_id: null, run_id: null, thread_id: 'thread-1', user_id: OWNER })
    expect(bufferedNodeSpan).toMatchObject({ name: 'sourcer', parent_span_id: graphSpan.span_id, run_id: 'run-domain-1' })
    expect(llmSpan).toMatchObject({ name: 'llm', parent_span_id: bufferedNodeSpan.span_id, run_id: 'run-domain-1', status: 'ok' })
    expect((llmSpan.attributes as Record<string, unknown>).model).toBe(FAKE_LLM_RESULT.model)

    // journal.ts's own row: live step-ledger state, not the trace tree —
    // no parent, carries the fine-grained stepStatus, run_id set the same
    // way.
    expect(journaledNodeSpan).toMatchObject({ name: 'sourcer', parent_span_id: null, run_id: 'run-domain-1', status: 'ok' })
    expect((journaledNodeSpan.attributes as Record<string, unknown>).stepStatus).toBe('completed')

    // ONE flush for the whole invocation's buffered spans, not one per
    // span/unit/call — the unit's own scope.owns was false (it joined
    // invoke.ts's ambient buffer), so only invoke.ts's own finally{} flushed
    // the buffered 3. journal.ts's row is a 4th, separate direct insert.
    expect(tables.trace_spans.seq).toBe(4)
  })

  it('error path: a graph.invoke() that throws still flushes the root graph span, recorded as "error"', async () => {
    const { admin, tables } = makeFakeAdmin()
    tables.graph_threads.rows.push({
      thread_id: 'thread-1',
      user_id: OWNER,
      surface: 'run',
      expires_at: null,
      run_id: null,
      conversation_id: null,
    })

    const graph: CompiledGraphLike = {
      invoke: async () => {
        throw new Error('graph blew up mid-run')
      },
      getState: async () => ({ config: { configurable: {} } }),
    }

    await expect(invokeGraphForUser({ admin, userId: OWNER, surface: 'run', graph, threadId: 'thread-1' })).rejects.toThrow(
      'graph blew up mid-run'
    )

    // A killed/thrown invocation loses at most its own buffer — here nothing
    // was killed, the throw was caught, so the buffer's one span (the root)
    // is still flushed via invoke.ts's finally{}, not lost.
    expect(tables.trace_spans.rows).toHaveLength(1)
    expect(tables.trace_spans.rows[0]).toMatchObject({
      kind: 'graph',
      name: 'run',
      status: 'error',
      attributes: expect.objectContaining({ error: 'graph blew up mid-run' }),
    })
  })
})
