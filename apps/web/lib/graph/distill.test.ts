// Tests for lib/graph/distill.ts#distillInsights — the reward-loop distiller
// (langgraph port design doc Step 6). loadApiKeys/callLlm/callEmbedding are
// mocked so this file proves distillInsights' OWN contract (floor-before-
// spend, evidence traceability, the weekly gate) against a fake admin, never
// a real database or a real model — same fake-PostgREST-chain style as
// lib/graph/journal.test.ts and lib/insights/store.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminClient } from '../harness/types'

// --- mocks -------------------------------------------------------------------

const loadApiKeysMock = vi.fn()
vi.mock('../harness/keys', () => ({
  loadApiKeys: (...args: unknown[]) => loadApiKeysMock(...args),
}))

const callLlmMock = vi.fn()
const callEmbeddingMock = vi.fn()
vi.mock('../harness/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../harness/llm')>()
  return {
    ...actual,
    callLlm: (...args: unknown[]) => callLlmMock(...args),
    callEmbedding: (...args: unknown[]) => callEmbeddingMock(...args),
  }
})

const { distillInsights, DISTILL_GOAL } = await import('./distill')
const { MissingKeyError } = await import('../harness/llm')
const { MIN_SAMPLE_PER_CLASS } = await import('../evals/harness')

// --- fake admin: agent_runs / eval_verdicts tables + a stubbed .rpc() ------

interface Row extends Record<string, unknown> {}

class FakeTable {
  rows: Row[] = []
  seq = 0
  constructor(private prefix: string) {}
  nextId(): string {
    this.seq += 1
    return `${this.prefix}-${this.seq}`
  }
}

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: Array<(r: Row) => boolean> = []
  private mode: 'select' | 'insert' | 'update' = 'select'
  private patch: Record<string, unknown> | null = null
  private insertRow: Record<string, unknown> | null = null
  private orderCol: string | null = null
  private orderAsc = true
  private limitN: number | null = null

  constructor(private table: FakeTable) {}

  select(_cols?: string) {
    return this
  }
  eq(col: string, val: unknown) {
    this.filters.push((r) => r[col] === val)
    return this
  }
  in(col: string, vals: unknown[]) {
    this.filters.push((r) => vals.includes(r[col]))
    return this
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderCol = col
    this.orderAsc = opts?.ascending ?? true
    return this
  }
  limit(n: number) {
    this.limitN = n
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

  private exec(): { data: unknown; error: unknown } {
    if (this.mode === 'insert') {
      const row: Row = { id: this.table.nextId(), ...this.insertRow }
      this.table.rows.push(row)
      return { data: row, error: null }
    }
    if (this.mode === 'update') {
      const matched = this.table.rows.filter((r) => this.filters.every((f) => f(r)))
      for (const r of matched) Object.assign(r, this.patch)
      return { data: matched, error: null }
    }
    let result = this.table.rows.filter((r) => this.filters.every((f) => f(r)))
    if (this.orderCol) {
      const col = this.orderCol
      result = [...result].sort((a, b) => {
        const av = String(a[col] ?? '')
        const bv = String(b[col] ?? '')
        const cmp = av < bv ? -1 : av > bv ? 1 : 0
        return this.orderAsc ? cmp : -cmp
      })
    }
    if (this.limitN != null) result = result.slice(0, this.limitN)
    return { data: result, error: null }
  }

  async single() {
    const { data, error } = this.exec()
    const rows = (Array.isArray(data) ? data : [data]) as (Row | null)[]
    return { data: rows[0] ?? null, error }
  }
  async maybeSingle() {
    return this.single()
  }
  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.exec()).then(onfulfilled, onrejected)
  }
}

type RpcHandler = (params: Record<string, unknown>) => { data: unknown; error: unknown }

/** Every distill_* RPC defaults to "no candidates" — a test overrides only
 *  the one it's exercising. upsert_insight defaults to a real insert-shaped
 *  response (mirrors lib/insights/store.test.ts's fake rpc) so ingestInsight
 *  succeeds without every test having to know its exact param shape. */
function makeRpcHandlers(overrides: Partial<Record<string, RpcHandler>> = {}) {
  let seq = 0
  const insightInserts: Record<string, unknown>[] = []
  const base: Record<string, RpcHandler> = {
    distill_match_score_by_score_band: () => ({ data: [], error: null }),
    distill_match_score_by_source: () => ({ data: [], error: null }),
    distill_draft_by_seniority: () => ({ data: [], error: null }),
    distill_outreach_by_company: () => ({ data: [], error: null }),
    upsert_insight: (params) => {
      seq += 1
      insightInserts.push(params)
      const row = {
        id: `insight-${seq}`,
        inserted: true,
        kind: params.p_kind,
        statement: params.p_statement,
        evidence: params.p_evidence,
        confidence: params.p_confidence,
        status: 'active',
        source: params.p_source,
        company_id: params.p_company_id ?? null,
        supersedes_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      return { data: [row], error: null }
    },
  }
  return { handlers: { ...base, ...overrides }, insightInserts }
}

function makeFakeAdmin(rpcHandlers: Partial<Record<string, RpcHandler>>) {
  const tables = { agent_runs: new FakeTable('run'), eval_verdicts: new FakeTable('verdict') }
  const rpcCalls: { fn: string; params: Record<string, unknown> }[] = []
  const admin = {
    from: (name: string) => {
      const table = (tables as Record<string, FakeTable>)[name]
      if (!table) throw new Error(`fake admin: unhandled table "${name}"`)
      return new FakeQuery(table)
    },
    rpc: async (fn: string, params: Record<string, unknown>) => {
      rpcCalls.push({ fn, params })
      const handler = rpcHandlers[fn]
      if (!handler) throw new Error(`fake admin: unhandled rpc "${fn}"`)
      return handler(params)
    },
  } as unknown as AdminClient
  return { admin, tables, rpcCalls }
}

/** Seed a batch of eval_verdicts rows the fake table can answer `.in('id',
 *  ids)` reads against — what fetchRationales/evidence-traceability need. */
function seedVerdicts(table: FakeTable, ids: string[], rationale: string | null = 'A rationale sentence.'): void {
  for (const id of ids) table.rows.push({ id, user_id: 'u1', subject_kind: 'match_score', judge: 'deterministic', verdict: 'pass', rationale })
}

beforeEach(() => {
  loadApiKeysMock.mockReset().mockResolvedValue({ openrouter: 'sk-test' })
  callLlmMock.mockReset()
  callEmbeddingMock.mockReset().mockRejectedValue(new MissingKeyError('no embedding provider'))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('distillInsights — weekly gate', () => {
  it('refuses to run again within WEEKLY_GATE_MS of the last distillation run for this user', async () => {
    const { handlers } = makeRpcHandlers()
    const { admin, tables, rpcCalls } = makeFakeAdmin(handlers)
    tables.agent_runs.rows.push({
      id: 'run-prev',
      user_id: 'u1',
      goal: DISTILL_GOAL,
      status: 'completed',
      created_at: new Date().toISOString(),
    })

    const result = await distillInsights(admin, 'u1')

    expect(result.ran).toBe(false)
    expect(result.reason).toMatch(/weekly gate/)
    expect(rpcCalls).toHaveLength(0) // no aggregation query even attempted
    expect(tables.agent_runs.rows).toHaveLength(1) // no new run row started
  })

  it('does not gate a different user off another user\'s recent run', async () => {
    const { handlers } = makeRpcHandlers()
    const { admin, tables } = makeFakeAdmin(handlers)
    tables.agent_runs.rows.push({
      id: 'run-prev',
      user_id: 'someone-else',
      goal: DISTILL_GOAL,
      status: 'completed',
      created_at: new Date().toISOString(),
    })

    const result = await distillInsights(admin, 'u1')
    expect(result.ran).toBe(true)
  })
})

describe('distillInsights — floor-first, structurally (invariant 7)', () => {
  it('a below-floor candidate never reaches callLlm — the refusal is a typed eval_verdicts row instead', async () => {
    const belowFloorIds = ['v1', 'v2', 'v3'] // 3 positive < MIN_SAMPLE_PER_CLASS
    const { handlers } = makeRpcHandlers({
      distill_match_score_by_score_band: () => ({
        data: [{ band: '85-100', positive_count: 3, negative_count: 2, verdict_ids: belowFloorIds }],
        error: null,
      }),
    })
    const { admin, tables } = makeFakeAdmin(handlers)
    seedVerdicts(tables.eval_verdicts, belowFloorIds)

    const result = await distillInsights(admin, 'u1')

    expect(callLlmMock).not.toHaveBeenCalled()
    expect(loadApiKeysMock).not.toHaveBeenCalled() // no spend-adjacent work at all for a below-floor candidate
    expect(result.refusals).toBe(1)
    expect(result.insightsWritten).toBe(0)

    const refusalRows = tables.eval_verdicts.rows.filter((r) => r.subject_kind === 'distillation')
    expect(refusalRows).toHaveLength(1)
    expect(refusalRows[0]).toMatchObject({ judge: 'deterministic', verdict: 'insufficient-data' })
    expect(refusalRows[0].rationale).toContain(String(MIN_SAMPLE_PER_CLASS))
  })

  it('a candidate crossing the floor on only ONE side still refuses — the floor is per-class, not per-total', async () => {
    // 25 positive, 1 negative: plenty of total volume, but the negative class
    // alone is far under MIN_SAMPLE_PER_CLASS.
    const ids = Array.from({ length: 26 }, (_, i) => `v${i}`)
    const { handlers } = makeRpcHandlers({
      distill_draft_by_seniority: () => ({
        data: [{ band: 'senior', positive_count: 25, negative_count: 1, verdict_ids: ids }],
        error: null,
      }),
    })
    const { admin, tables } = makeFakeAdmin(handlers)
    seedVerdicts(tables.eval_verdicts, ids)

    const result = await distillInsights(admin, 'u1')

    expect(callLlmMock).not.toHaveBeenCalled()
    expect(result.refusals).toBe(1)
    expect(result.insightsWritten).toBe(0)
  })
})

describe('distillInsights — insight evidence traceability', () => {
  it('every verdict id an insight cites in its evidence is a real eval_verdicts row', async () => {
    const ids = Array.from({ length: 23 }, (_, i) => `v${i}`) // 12 positive / 11 negative, both over the floor
    const { handlers, insightInserts } = makeRpcHandlers({
      distill_match_score_by_score_band: () => ({
        data: [{ band: '85-100', positive_count: 12, negative_count: 11, verdict_ids: ids }],
        error: null,
      }),
    })
    const { admin, tables } = makeFakeAdmin(handlers)
    seedVerdicts(tables.eval_verdicts, ids)
    callLlmMock.mockResolvedValue({
      content: 'Jobs scored 85-100 progress to interview far more often than they are rejected.',
      tokensUsed: 60,
      promptTokens: 50,
      completionTokens: 10,
      model: 'anthropic/claude-haiku-4.5',
    })

    const result = await distillInsights(admin, 'u1')

    expect(result.insightsWritten).toBe(1)
    expect(insightInserts).toHaveLength(1)

    const evidence = insightInserts[0].p_evidence as { verdictIds: string[]; perClassCounts: { positive: number; negative: number } }
    expect(evidence.perClassCounts).toEqual({ positive: 12, negative: 11 })
    expect(evidence.verdictIds).toHaveLength(23)
    const existingIds = new Set(tables.eval_verdicts.rows.map((r) => r.id))
    for (const id of evidence.verdictIds) expect(existingIds.has(id)).toBe(true)

    // ingestInsight's contract (source/kind) — kind: 'pattern' is what makes
    // this insight actually reachable by buildMatchContext/buildGoalStrategy
    // Context/buildOutreachContext's relevantInsights(..., ['strategy',
    // 'pattern'], ...) — see distill.ts's CONSUMPTION SIDE header note.
    expect(insightInserts[0]).toMatchObject({ p_kind: 'pattern', p_source: 'reward_loop' })
  })

  it('a candidate at exactly MIN_SAMPLE_PER_CLASS on both sides is distilled, not refused', async () => {
    const ids = Array.from({ length: MIN_SAMPLE_PER_CLASS * 2 }, (_, i) => `v${i}`)
    const { handlers } = makeRpcHandlers({
      distill_match_score_by_source: () => ({
        data: [{ band: 'greenhouse', positive_count: MIN_SAMPLE_PER_CLASS, negative_count: MIN_SAMPLE_PER_CLASS, verdict_ids: ids }],
        error: null,
      }),
    })
    const { admin, tables } = makeFakeAdmin(handlers)
    seedVerdicts(tables.eval_verdicts, ids)
    callLlmMock.mockResolvedValue({ content: 'Greenhouse-sourced jobs progress at an even split.', tokensUsed: 10, promptTokens: 8, completionTokens: 2, model: 'x' })

    const result = await distillInsights(admin, 'u1')

    expect(callLlmMock).toHaveBeenCalledTimes(1)
    expect(result.insightsWritten).toBe(1)
    expect(result.refusals).toBe(0)
  })
})

describe('distillInsights — refusal paths around the model call itself', () => {
  it('no usable API keys -> an "unjudged" distillation verdict, never a thrown error', async () => {
    const ids = Array.from({ length: MIN_SAMPLE_PER_CLASS * 2 }, (_, i) => `v${i}`)
    const { handlers } = makeRpcHandlers({
      distill_draft_by_seniority: () => ({
        data: [{ band: 'staff', positive_count: MIN_SAMPLE_PER_CLASS, negative_count: MIN_SAMPLE_PER_CLASS, verdict_ids: ids }],
        error: null,
      }),
    })
    const { admin, tables } = makeFakeAdmin(handlers)
    seedVerdicts(tables.eval_verdicts, ids)
    loadApiKeysMock.mockRejectedValue(new MissingKeyError('no keys configured'))

    const result = await distillInsights(admin, 'u1')

    expect(callLlmMock).not.toHaveBeenCalled()
    expect(result.insightsWritten).toBe(0)
    expect(result.refusals).toBe(1)
    const rows = tables.eval_verdicts.rows.filter((r) => r.subject_kind === 'distillation')
    expect(rows).toHaveLength(1)
    expect(rows[0].verdict).toBe('unjudged')
  })
})

describe('distillInsights — run bookkeeping', () => {
  it('marks the agent_runs row completed with a result summary when it actually ran', async () => {
    const { handlers } = makeRpcHandlers()
    const { admin, tables } = makeFakeAdmin(handlers)

    const result = await distillInsights(admin, 'u1')

    expect(result.ran).toBe(true)
    expect(tables.agent_runs.rows).toHaveLength(1)
    expect(tables.agent_runs.rows[0]).toMatchObject({ goal: DISTILL_GOAL, status: 'completed', user_id: 'u1' })
  })
})
