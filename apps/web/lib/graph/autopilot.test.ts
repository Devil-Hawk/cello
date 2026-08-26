// Tests for lib/graph/autopilot.ts's autopilotTickGraph — the LangGraph
// Functional API port of the pre-port lib/harness/autopilot.ts. Same testing
// philosophy as runs.test.ts/refresh.test.ts: a REAL @langchain/langgraph
// MemorySaver (real Functional API memoization), with refreshCompany,
// scoreJobBatch, runAgentUnit and loadApiKeys mocked — this file tests
// orchestration (caps, dispatch, budget, journaling, fresh-thread-per-tick,
// replay safety), not lib/ats's provider detection, lib/harness/agents/
// matcher.ts's own scoring logic, or lib/graph/unit.ts's own contract (all
// separately tested). The GOAL LEDGER's own state-machine correctness
// (caps, dedupe, merge-under-concurrency) is lib/harness/goals.test.ts's
// job, not re-proven here — this file only proves the GRAPH wires goals.ts
// in correctly. ZERO network, ZERO real LLM calls, ZERO real Postgres.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemorySaver } from '@langchain/langgraph'
import type { CompanyInput, CompanyRefreshResult } from '../ats'
import type { SearchGoal } from '../harness/goals'
import { createGoal, writeGoals } from '../harness/goals'

// --- mocks -------------------------------------------------------------------

const refreshCompanyMock = vi.fn(async (_store: unknown, company: CompanyInput): Promise<CompanyRefreshResult> => ({
  companyId: company.id,
  companyName: company.name,
  provider: 'greenhouse',
  found: 0,
  inserted: 0,
  errors: [],
}))
vi.mock('../ats', async (importOriginal) => {
  // mapWithConcurrency stays REAL — autopilot.ts depends on it for sourceTask's
  // own bounded-concurrency refresh loop, and it is pure/deterministic.
  const actual = await importOriginal<typeof import('../ats')>()
  return { ...actual, refreshCompany: (store: unknown, company: CompanyInput) => refreshCompanyMock(store, company) }
})

const scoreJobBatchMock = vi.fn(async (_opts: unknown): Promise<{ scored: unknown[]; failedCount: number; candidatesConsidered: number; skippedReason?: string }> => ({
  scored: [],
  failedCount: 0,
  candidatesConsidered: 0,
  skippedReason: 'no-companies',
}))
vi.mock('../harness/agents/matcher', async (importOriginal) => {
  // Real ownedJobsQuery is kept (loadCandidateJobs builds its FK-join filter
  // through it — see FakeQueryBuilder's companies.user_id special case
  // above); only scoreJobBatch is faked, since that's the metered LLM path
  // this file never wants to actually run.
  const actual = await importOriginal<typeof import('../harness/agents/matcher')>()
  return {
    ...actual,
    scoreJobBatch: (opts: unknown) => scoreJobBatchMock(opts),
  }
})

const loadApiKeysMock = vi.fn(async (_admin: unknown, _userId: string): Promise<Record<string, unknown>> => ({
  openrouter: 'fake-key',
  userId: 'user-1',
}))
vi.mock('../harness/keys', () => ({
  loadApiKeys: (admin: unknown, userId: string) => loadApiKeysMock(admin, userId),
}))

// callLlm must never be reached in the untargeted-sweep tests (scoreJobBatch
// is mocked and never touches the llm it's handed); the goal-path tests below
// override this per-test.
interface FakeLlmResult {
  content: string
  tokensUsed: number
  promptTokens: number
  completionTokens: number
  model: string
}
const callLlmMock = vi.fn(async (_apiKeys: unknown, _opts: unknown, _signal?: unknown): Promise<FakeLlmResult> => {
  throw new Error('autopilot.test.ts: callLlm must not be called unless a test overrides callLlmMock')
})
vi.mock('../harness/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../harness/llm')>()
  return { ...actual, callLlm: (apiKeys: unknown, opts: unknown, signal?: unknown) => callLlmMock(apiKeys, opts, signal) }
})

interface RunAgentUnitCall {
  unitType: string
  input: unknown
  label?: string
}
const runAgentUnitCalls: RunAgentUnitCall[] = []
const runAgentUnitMock = vi.fn(async (unitType: string, ctx: { input: unknown; label?: string }) => {
  runAgentUnitCalls.push({ unitType, input: ctx.input, label: ctx.label })
  if (unitType === 'cv_tailor') {
    return { output: { resumeSummary: 'tailored summary', coverLetter: 'tailored letter' }, tokensUsed: 100 }
  }
  if (unitType === 'applier') {
    return { output: { status: 'pending_review', submissionRef: null }, tokensUsed: 50 }
  }
  throw new Error(`autopilot.test.ts: no runAgentUnit fake behavior for unit type "${unitType}"`)
})
vi.mock('./unit', () => ({
  runAgentUnit: (unitType: string, ctx: { input: unknown; label?: string }) => runAgentUnitMock(unitType, ctx),
}))

// verifyCvTailorDraft (lib/graph/verify/cv-tailor.ts) wraps runAgentUnit('cv_tailor')
// with a containment gate + a real judge call (autoevals -> a real fetch) —
// neither belongs in an orchestration test that asserts ZERO network. Faked
// here to DELEGATE into the same runAgentUnitMock every other test in this
// file already configures (so a test that overrides runAgentUnitMock's
// implementation — e.g. the budget-exhaustion test below — still drives this
// path identically to before verify existed), always reporting a clean
// 'verified' outcome. lib/graph/verify/cv-tailor.test.ts is where the real
// verify control flow (containment retry, judge-failed, unjudged) is tested.
const verifyCvTailorDraftMock = vi.fn(
  async (args: { unitConfig: { configurable: { runId: string } }; jobId: string }) => {
    const result = (await runAgentUnitMock('cv_tailor', {
      input: { jobId: args.jobId },
      label: `tailor:${args.jobId}`,
    })) as { output: { resumeSummary: string; coverLetter: string }; tokensUsed: number }
    return {
      kind: 'verified' as const,
      resumeSummary: result.output.resumeSummary,
      coverLetter: result.output.coverLetter,
      keywords: [] as string[],
      tokensUsed: result.tokensUsed,
      verdict: { name: 'cv_tailor groundedness', verdict: 'pass' as const, score: 1, threshold: 0.5, n: 1, summary: 'ok' },
    }
  }
)
vi.mock('./verify/cv-tailor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./verify/cv-tailor')>()
  return { ...actual, verifyCvTailorDraft: (args: never) => verifyCvTailorDraftMock(args) }
})

const logHarnessErrorMock = vi.fn()
vi.mock('../observability/log', () => ({
  logHarnessError: (...args: unknown[]) => logHarnessErrorMock(...args),
}))

// --- fake admin (same PostgREST-chain shape as runs.test.ts/refresh.test.ts) -

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

class FakeQueryBuilder implements PromiseLike<{ data: unknown; error: unknown; count?: number }> {
  private filters: { col: string; op: 'eq' | 'is' | 'gte'; val: unknown }[] = []
  private inFilter: [string, unknown[]] | null = null
  private opMode: 'select' | 'update' | 'insert' = 'select'
  private patch: Record<string, unknown> | null = null
  private insertRow: Record<string, unknown> | null = null
  private singleMode: 'single' | 'maybeSingle' | null = null
  private countMode = false

  constructor(
    private table: FakeTable,
    private tableName: string,
    private tables: Map<string, FakeTable>
  ) {}

  select(_cols?: string, opts?: { count?: 'exact'; head?: boolean }) {
    if (opts?.count === 'exact') this.countMode = true
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
  gte(col: string, val: unknown) {
    this.filters.push({ col, op: 'gte', val })
    return this
  }
  in(col: string, vals: unknown[]) {
    this.inFilter = [col, vals]
    return this
  }
  order() {
    return this
  }
  limit() {
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
    const eqOk = this.filters.every(({ col, op, val }) => {
      // Fakes the FK-join filter ownedJobsQuery builds (`companies!inner`
      // embedded, filtered by `.eq('companies.user_id', ...)`) — this
      // FakeQueryBuilder has no real embed support, so this is the one
      // column PostgREST would resolve through a join instead of a plain
      // row field.
      if (col === 'companies.user_id') {
        const company = this.tables.get('companies')?.rows.get(row.company_id as string)
        return company?.user_id === val
      }
      const rowVal = row[col]
      if (op === 'eq') return rowVal === val
      if (op === 'gte') return typeof rowVal === 'string' && typeof val === 'string' && rowVal >= val
      return val === null ? rowVal === null || rowVal === undefined : rowVal === val
    })
    if (!eqOk) return false
    if (this.inFilter) {
      const [col, vals] = this.inFilter
      return vals.includes(row[col])
    }
    return true
  }

  private matchingRows(): FakeRow[] {
    return [...this.table.rows.values()].filter((r) => this.matches(r))
  }

  private async exec(): Promise<{ data: unknown; error: unknown; count?: number }> {
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
    if (this.countMode) return { data: null, error: null, count: rows.length }
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
  then<TResult1 = { data: unknown; error: unknown; count?: number }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown; count?: number }) => TResult1 | PromiseLike<TResult1>) | null,
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
    return new FakeQueryBuilder(this.tableFor(name), name, this.tables)
  }
  seed(tableName: string, row: FakeRow): void {
    this.tableFor(tableName).rows.set(row.id, { ...row })
  }
  allRows(tableName: string): FakeRow[] {
    return [...this.tableFor(tableName).rows.values()]
  }
}

const adminHolder = vi.hoisted<{ admin: unknown }>(() => ({ admin: null }))
vi.mock('../harness/supabase-admin', () => ({
  createAdminClient: () => adminHolder.admin,
}))

function setAdmin(admin: FakeAdmin): void {
  adminHolder.admin = admin
}

function seedCompanies(admin: FakeAdmin, userId: string, count: number): void {
  for (let i = 0; i < count; i++) {
    admin.seed('companies', {
      id: `co-${i}`,
      user_id: userId,
      name: `Company ${i}`,
      domain: null,
      career_url: null,
      metadata: null,
      is_dream_company: false,
    })
  }
}

// userId defaults to makeProfile()'s own default ('user-1') — every existing
// call site relies on this. Seeds a matching eval_verdicts 'pass' row per
// job alongside match_score: loadCandidateJobs' allowlist (Step 4 item 3)
// requires a RECORDED non-failing verdict for an already-scored job, not
// merely the absence of a failing one — see loadVerifiedJobIds's own header.
function seedJobs(
  admin: FakeAdmin,
  companyIds: string[],
  perCompany: number,
  matchScore: number,
  userId = 'user-1'
): string[] {
  const ids: string[] = []
  let n = 0
  for (const companyId of companyIds) {
    for (let i = 0; i < perCompany; i++) {
      n += 1
      const id = `job-${n}`
      ids.push(id)
      admin.seed('jobs', {
        id,
        title: `Role ${n}`,
        description: 'Do the work.',
        location: 'Remote',
        url: `https://example.com/${id}`,
        company_id: companyId,
        match_score: matchScore,
        discovered_at: new Date(2026, 0, 1, 0, 0, n).toISOString(),
      })
      admin.seed('eval_verdicts', {
        id: `${id}-verdict`,
        user_id: userId,
        subject_kind: 'match_score',
        subject_id: id,
        judge: 'deterministic',
        verdict: 'pass',
      })
    }
  }
  return ids
}

// --- MemorySaver-backed graph config (same literal invoke.ts's Pregel runtime
// reads a per-call checkpointer override off — see that file's
// PREGEL_CHECKPOINTER_KEY comment). This file bypasses invoke.ts entirely (it
// tests the raw compiled graph), so it needs the same literal.
const PREGEL_CHECKPOINTER_KEY = '__pregel_checkpointer'

function makeConfig(threadId: string, userId: string, saver: MemorySaver) {
  return {
    configurable: { thread_id: threadId, threadId, userId, [PREGEL_CHECKPOINTER_KEY]: saver },
  }
}

function makeProfile(overrides: Partial<{ id: string; resume_text: string | null; preferences: Record<string, unknown> }> = {}) {
  return {
    id: 'user-1',
    full_name: 'Test User',
    email: 'test@example.com',
    resume_text: 'Forward deployed engineer, 6 years.',
    preferences: { autopilot: { enabled: true, minScore: 90, dailyCap: 15, budgetTokens: 150_000 } },
    ...overrides,
  }
}

let autopilotTickGraph: typeof import('./autopilot').autopilotTickGraph

beforeEach(async () => {
  vi.resetModules()
  refreshCompanyMock.mockClear()
  scoreJobBatchMock.mockClear()
  loadApiKeysMock.mockClear()
  callLlmMock.mockClear()
  runAgentUnitMock.mockClear()
  runAgentUnitCalls.length = 0
  logHarnessErrorMock.mockClear()
  ;({ autopilotTickGraph } = await import('./autopilot'))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('autopilotTickGraph — disabled / no-resume skips', () => {
  it('skips a disabled profile without creating an agent_runs row', async () => {
    const admin = new FakeAdmin()
    setAdmin(admin)
    const profile = makeProfile({ preferences: { autopilot: { enabled: false } } })
    const saver = new MemorySaver()

    const result = (await autopilotTickGraph.invoke({ profile }, makeConfig('t1', profile.id, saver))) as { skipped?: string }
    expect(result.skipped).toBe('disabled')
    expect(admin.allRows('agent_runs')).toHaveLength(0)
  })

  it('skips a profile with no resume and no usable LLM backend', async () => {
    loadApiKeysMock.mockResolvedValueOnce({})
    const admin = new FakeAdmin()
    setAdmin(admin)
    const profile = makeProfile({ resume_text: null })
    const saver = new MemorySaver()

    const result = (await autopilotTickGraph.invoke({ profile }, makeConfig('t2', profile.id, saver))) as { skipped?: string }
    expect(result.skipped).toBe('no-resume')
    expect(admin.allRows('agent_runs')).toHaveLength(0)
  })

  it('refuses a profile.id that does not match config.configurable.userId', async () => {
    const admin = new FakeAdmin()
    setAdmin(admin)
    const profile = makeProfile({ id: 'user-1' })
    const saver = new MemorySaver()
    await expect(autopilotTickGraph.invoke({ profile }, makeConfig('t3', 'someone-else', saver))).rejects.toThrow(/does not match/)
  })
})

describe('autopilotTickGraph — untargeted sweep, happy path', () => {
  it('sources, scores, drafts eligible jobs, journals one agent_runs row, and never sets autoSubmit true', async () => {
    const admin = new FakeAdmin()
    setAdmin(admin)
    const profile = makeProfile()
    seedCompanies(admin, profile.id, 3)
    const companyIds = admin.allRows('companies').map((c) => c.id as string)
    seedJobs(admin, companyIds, 1, 95) // 3 jobs, all above minScore

    scoreJobBatchMock.mockResolvedValueOnce({ scored: [{ jobId: 'x' }], failedCount: 0, candidatesConsidered: 3 })

    const saver = new MemorySaver()
    const result = (await autopilotTickGraph.invoke({ profile }, makeConfig('t-happy', profile.id, saver))) as {
      runId?: string
      eligible?: number
      handoff?: number
      message: string
    }

    expect(result.runId).toBeTruthy()
    expect(result.eligible).toBe(3)
    expect(result.handoff).toBe(3)
    expect(result.message).toContain('queued 3 for review')

    const runs = admin.allRows('agent_runs')
    expect(runs).toHaveLength(1)
    expect(runs[0].status).toBe('completed')
    expect(runs[0].thread_id).toBe('t-happy')

    // Every draft attempted tailor THEN applier, and applier always carried
    // autoSubmit:false — the one place this file's guarantee is enforced.
    const applierCalls = runAgentUnitCalls.filter((c) => c.unitType === 'applier')
    expect(applierCalls).toHaveLength(3)
    for (const c of applierCalls) {
      expect((c.input as { autoSubmit: unknown }).autoSubmit).toBe(false)
    }
    expect(scoreJobBatchMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 60 }))
  })

  it('action-selection allowlists a scored job only with a recorded non-failing verdict (Step 4 item 3)', async () => {
    const admin = new FakeAdmin()
    setAdmin(admin)
    const profile = makeProfile()
    seedCompanies(admin, profile.id, 1)
    const companyId = admin.allRows('companies')[0].id as string

    // Three already-scored jobs, same match_score, three different verdict
    // states — only the 'pass' one should reach `eligible`.
    const jobBase = {
      title: 'Role',
      description: 'Do the work.',
      location: 'Remote',
      company_id: companyId,
      match_score: 95,
      discovered_at: '2026-01-01T00:00:00.000Z',
    }
    admin.seed('jobs', { id: 'job-verified', url: 'https://example.com/verified', ...jobBase })
    admin.seed('eval_verdicts', {
      id: 'verdict-verified',
      user_id: profile.id,
      subject_kind: 'match_score',
      subject_id: 'job-verified',
      judge: 'deterministic',
      verdict: 'pass',
    })
    admin.seed('jobs', { id: 'job-failed', url: 'https://example.com/failed', ...jobBase })
    admin.seed('eval_verdicts', {
      id: 'verdict-failed',
      user_id: profile.id,
      subject_kind: 'match_score',
      subject_id: 'job-failed',
      judge: 'deterministic',
      verdict: 'fail',
    })
    admin.seed('jobs', { id: 'job-unrecorded', url: 'https://example.com/unrecorded', ...jobBase })
    // No eval_verdicts row for job-unrecorded at all — a scored job that
    // predates the verify stage (or a seed that bypassed it) with nothing
    // to certify it, and the exact gap the allowlist (not a blocklist)
    // closes.

    scoreJobBatchMock.mockResolvedValueOnce({ scored: [], failedCount: 0, candidatesConsidered: 3 })

    const saver = new MemorySaver()
    const result = (await autopilotTickGraph.invoke({ profile }, makeConfig('t-allowlist', profile.id, saver))) as {
      eligible?: number
    }

    expect(result.eligible).toBe(1)
    const applierCalls = runAgentUnitCalls.filter((c) => c.unitType === 'applier')
    expect(applierCalls).toHaveLength(1)
    expect((applierCalls[0].input as { jobId: string }).jobId).toBe('job-verified')
  })

  it('an unexpected verifyCvTailorDraft failure (not budget, not containment) is journaled via logHarnessError, then falls through to a handoff draft', async () => {
    const admin = new FakeAdmin()
    setAdmin(admin)
    const profile = makeProfile()
    seedCompanies(admin, profile.id, 1)
    const companyIds = admin.allRows('companies').map((c) => c.id as string)
    seedJobs(admin, companyIds, 1, 95)

    scoreJobBatchMock.mockResolvedValueOnce({ scored: [], failedCount: 0, candidatesConsidered: 1 })
    // Neither BudgetExceededError/BudgetCapError nor CvTailorContainmentError
    // — e.g. loadJobFacts/loadResumeText/claimsFor's DB read failing inside
    // verifyCvTailorDraft. Before this fix, prepareApplicationDraft's catch
    // swallowed exactly this with no log line and no eval_verdicts write.
    verifyCvTailorDraftMock.mockRejectedValueOnce(new Error('profiles read failed'))

    const saver = new MemorySaver()
    const result = (await autopilotTickGraph.invoke({ profile }, makeConfig('t-verify-throw', profile.id, saver))) as {
      eligible?: number
      handoff?: number
    }

    expect(result.eligible).toBe(1)
    expect(result.handoff).toBe(1) // still reaches applier with no tailored content, exactly as before this stage
    expect(logHarnessErrorMock).toHaveBeenCalledTimes(1)
    const [ctx, err] = logHarnessErrorMock.mock.calls[0] as [Record<string, unknown>, Error]
    expect(ctx).toMatchObject({ agentType: 'cv_tailor', phase: 'verify' })
    expect(err.message).toBe('profiles read failed')
  })

  it('caps company refresh at MAX_COMPANIES_REFRESH even with more companies on file', async () => {
    const admin = new FakeAdmin()
    setAdmin(admin)
    const profile = makeProfile()
    seedCompanies(admin, profile.id, 25)

    const saver = new MemorySaver()
    await autopilotTickGraph.invoke({ profile }, makeConfig('t-companies', profile.id, saver))

    expect(refreshCompanyMock).toHaveBeenCalledTimes(20)
  })

  it('caps drafted jobs per tick at MAX_ACTIONS_PER_TICK even with more eligible candidates', async () => {
    const admin = new FakeAdmin()
    setAdmin(admin)
    const profile = makeProfile()
    seedCompanies(admin, profile.id, 1)
    const companyIds = admin.allRows('companies').map((c) => c.id as string)
    seedJobs(admin, companyIds, 20, 95) // 20 eligible candidates, cap is 8

    const saver = new MemorySaver()
    const result = (await autopilotTickGraph.invoke({ profile }, makeConfig('t-cap', profile.id, saver))) as { eligible?: number }

    expect(result.eligible).toBe(8)
    const applierCalls = runAgentUnitCalls.filter((c) => c.unitType === 'applier')
    expect(applierCalls).toHaveLength(8)
  })

  it('stops dispatching new drafts once the tick token budget is exhausted', async () => {
    // parseAutopilotConfig clamps budgetTokens to a floor of 10_000, so this
    // drives exhaustion with an expensive per-draft mock (6_000 tokens) rather
    // than an artificially tiny configured budget.
    runAgentUnitMock.mockImplementation(async (unitType: string, ctx: { input: unknown }) => {
      runAgentUnitCalls.push({ unitType, input: ctx.input })
      if (unitType === 'cv_tailor') return { output: { resumeSummary: 'x', coverLetter: 'y' }, tokensUsed: 6_000 }
      return { output: { status: 'pending_review', submissionRef: null }, tokensUsed: 0 }
    })

    const admin = new FakeAdmin()
    setAdmin(admin)
    const profile = makeProfile({
      preferences: { autopilot: { enabled: true, minScore: 90, dailyCap: 15, budgetTokens: 10_000 } },
    })
    seedCompanies(admin, profile.id, 1)
    const companyIds = admin.allRows('companies').map((c) => c.id as string)
    seedJobs(admin, companyIds, 5, 95) // 5 eligible; each draft costs 6_000 tokens (tailor only, in this mock)

    const saver = new MemorySaver()
    const result = (await autopilotTickGraph.invoke({ profile }, makeConfig('t-budget', profile.id, saver))) as {
      budgetExhausted?: boolean
    }

    expect(result.budgetExhausted).toBe(true)
    // 10_000 token budget / 6_000 per draft: the budget check runs BEFORE
    // each dispatch using the spend seen so far, so two drafts (0 < 10_000,
    // then 6_000 < 10_000) go out before a third sees 12_000 >= 10_000 and
    // stops — the same bounded-overspend ceiling documented on meteredLlm's
    // header (ponytail note) and on lib/graph/runs.ts's own §3d budget gate.
    const applierCalls = runAgentUnitCalls.filter((c) => c.unitType === 'applier')
    expect(applierCalls).toHaveLength(2)
  })

  it('reports no eligible matches without ever calling runAgentUnit', async () => {
    const admin = new FakeAdmin()
    setAdmin(admin)
    const profile = makeProfile()
    seedCompanies(admin, profile.id, 1)

    const saver = new MemorySaver()
    const result = (await autopilotTickGraph.invoke({ profile }, makeConfig('t-empty', profile.id, saver))) as { message: string }

    expect(result.message).toContain('No new eligible matches')
    expect(runAgentUnitMock).not.toHaveBeenCalled()
  })
})

describe('autopilotTickGraph — fresh thread, replay safety', () => {
  it('invoking the SAME completed thread twice never re-dispatches work or double-writes agent_runs', async () => {
    const admin = new FakeAdmin()
    setAdmin(admin)
    const profile = makeProfile()
    seedCompanies(admin, profile.id, 1)
    const companyIds = admin.allRows('companies').map((c) => c.id as string)
    seedJobs(admin, companyIds, 1, 95)

    const saver = new MemorySaver()
    const config = makeConfig('t-replay', profile.id, saver)

    const first = await autopilotTickGraph.invoke({ profile }, config)
    expect(admin.allRows('agent_runs')).toHaveLength(1)
    expect(refreshCompanyMock).toHaveBeenCalledTimes(1)
    const applierCallsAfterFirst = runAgentUnitCalls.filter((c) => c.unitType === 'applier').length

    // Same thread, no input, no resume — THE RESUME RULE's invoke(null) shape.
    // A fully-completed thread returns the cached result without re-running
    // the entrypoint body at all (verified against a real MemorySaver — see
    // lib/graph/invoke.ts's SPIKE_FINDINGS).
    const second = await autopilotTickGraph.invoke(null, config)

    expect(second).toEqual(first)
    expect(admin.allRows('agent_runs')).toHaveLength(1) // not a second row
    expect(refreshCompanyMock).toHaveBeenCalledTimes(1) // not re-dispatched
    expect(runAgentUnitCalls.filter((c) => c.unitType === 'applier')).toHaveLength(applierCallsAfterFirst)
  })
})

describe('autopilotTickGraph — goal-directed tick', () => {
  it('advances an active goal through judgeTask + draftTask, never claims a submission, and persists the ledger', async () => {
    const admin = new FakeAdmin()
    setAdmin(admin)
    // Created an hour ago, not at a fixed date: goals carry expiresAt, and a
    // hardcoded creation date quietly expired a week later, turning both goal
    // tests red on wall-clock time alone.
    const goal: SearchGoal = createGoal({ statement: 'Apply to FDE roles', targetCount: 2 }, new Date(Date.now() - 60 * 60 * 1000))
    const profile = makeProfile({ preferences: writeGoals({ autopilot: { enabled: true } }, [goal]) })
    admin.seed('profiles', { id: profile.id, preferences: profile.preferences })

    seedCompanies(admin, profile.id, 1)
    const companyIds = admin.allRows('companies').map((c) => c.id as string)
    seedJobs(admin, companyIds, 1, 80)

    callLlmMock.mockResolvedValueOnce({
      content: '{"decision":"keep","rationale":"Strong fit for the stated goal.","confidence":0.9}',
      tokensUsed: 120,
      promptTokens: 100,
      completionTokens: 20,
      model: 'test/model',
    })

    const saver = new MemorySaver()
    const result = (await autopilotTickGraph.invoke({ profile }, makeConfig('t-goal', profile.id, saver))) as {
      goal?: { statement: string; drafted: number; summary: string }
      handoff?: number
    }

    expect(result.goal).toBeTruthy()
    expect(result.goal!.summary).toContain('Nothing has been submitted')
    expect(result.handoff).toBe(1)
    const applierCalls = runAgentUnitCalls.filter((c) => c.unitType === 'applier')
    expect(applierCalls).toHaveLength(1)
    expect((applierCalls[0].input as { autoSubmit: unknown }).autoSubmit).toBe(false)

    // The ledger was actually persisted back to profiles.preferences.
    const savedProfile = admin.allRows('profiles').find((p) => p.id === profile.id)!
    const savedGoals = (savedProfile.preferences as { searchGoals?: unknown[] }).searchGoals ?? []
    expect(savedGoals).toHaveLength(1)
  })

  it('invoking the SAME completed goal thread twice never re-judges or double-writes the ledger', async () => {
    // Same replay-safety shape as "fresh thread, replay safety" above
    // (step-10 should-fix: that test only covered the untargeted-sweep path —
    // this extends it to judgeTask/draftTask's own ledger writes, which is
    // where a second entrypoint run would actually show up: a re-judged
    // candidate appended to goal.judgements, or a second applier dispatch).
    const admin = new FakeAdmin()
    setAdmin(admin)
    const goal: SearchGoal = createGoal({ statement: 'Apply to FDE roles', targetCount: 2 }, new Date(Date.now() - 60 * 60 * 1000))
    const profile = makeProfile({ preferences: writeGoals({ autopilot: { enabled: true } }, [goal]) })
    admin.seed('profiles', { id: profile.id, preferences: profile.preferences })

    seedCompanies(admin, profile.id, 1)
    const companyIds = admin.allRows('companies').map((c) => c.id as string)
    seedJobs(admin, companyIds, 1, 80)

    callLlmMock.mockResolvedValueOnce({
      content: '{"decision":"keep","rationale":"Strong fit for the stated goal.","confidence":0.9}',
      tokensUsed: 120,
      promptTokens: 100,
      completionTokens: 20,
      model: 'test/model',
    })

    const saver = new MemorySaver()
    const config = makeConfig('t-goal-replay', profile.id, saver)

    const first = await autopilotTickGraph.invoke({ profile }, config)
    expect(admin.allRows('agent_runs')).toHaveLength(1)
    expect(callLlmMock).toHaveBeenCalledTimes(1)
    const applierCallsAfterFirst = runAgentUnitCalls.filter((c) => c.unitType === 'applier').length
    const judgementsAfterFirst = (
      (admin.allRows('profiles').find((p) => p.id === profile.id)!.preferences as { searchGoals?: { judgements: unknown[] }[] })
        .searchGoals ?? []
    )[0].judgements.length

    // Same thread, no input, no resume — THE RESUME RULE's invoke(null) shape.
    const second = await autopilotTickGraph.invoke(null, config)

    expect(second).toEqual(first)
    expect(admin.allRows('agent_runs')).toHaveLength(1) // not a second row
    expect(callLlmMock).toHaveBeenCalledTimes(1) // judgeTask did not re-fire
    expect(runAgentUnitCalls.filter((c) => c.unitType === 'applier')).toHaveLength(applierCallsAfterFirst) // not re-drafted

    const savedProfile = admin.allRows('profiles').find((p) => p.id === profile.id)!
    const savedGoals = (savedProfile.preferences as { searchGoals?: { judgements: unknown[] }[] }).searchGoals ?? []
    expect(savedGoals).toHaveLength(1)
    expect(savedGoals[0].judgements).toHaveLength(judgementsAfterFirst) // single ledger effect, not double-judged
  })
})

// The graph-shape scan that used to live here — proving no task other than
// draftTask's own helper can reach applier or a submit path, and that the
// entrypoint never calls interrupt() — moved to lib/evals/graph-shape.test.ts
// (Step 8 of the langgraph port: consolidating invariant 6's graph-shape
// regression tests into one file). It was a pure source-text scan with no
// dependency on this file's mocks; see that file's own header for why it
// sits there now instead of here.
