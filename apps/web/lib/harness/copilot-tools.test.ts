// Dispatch-side gating tests for the copilot tool dispatcher
// (lib/harness/copilot-tools.ts). The submit/send guard itself
// (submitOrSendReason) lives in app/api/copilot/route.ts, which this workflow
// does not own — these tests cover what IS owned here: that a tool backed by
// a disabled agent is hard-rejected at dispatch (not merely hidden from the
// prompt), that dispatchTool always resolves to an {error} observation rather
// than throwing (so one bad tool call can never crash the copilot turn), and
// that job ownership is enforced transitively via companies.user_id so one
// user can never reach another user's job through a tool argument.
//
// ZERO network, ZERO real LLM calls, ZERO real DB: AdminClient is an
// in-memory fake table store (see fakeAdmin below), every LLM-needing/
// network-needing external call the dispatcher can reach is mocked
// (webSearch below; callLlm is never reached because every test here only
// exercises tool paths that need no LLM key at all — explain_match,
// get_application, list_runs, web_search).

import { afterEach, describe, expect, it, vi } from 'vitest'

const { webSearchMock, generateDossierMock } = vi.hoisted(() => ({
  webSearchMock: vi.fn(),
  generateDossierMock: vi.fn(),
}))
vi.mock('@/lib/search', () => ({ webSearch: webSearchMock }))
// research_company/research_companies' only network+LLM-touching dependency —
// mocked so the batch-tool tests below (caps, partial failure, concurrency)
// are ZERO real LLM calls / ZERO real network, same standard as the rest of
// this file.
vi.mock('./agents/company_researcher', () => ({
  generateDossier: generateDossierMock,
  // Unused by dispatchTool (only generateDossier is called directly), but
  // lib/harness/registry.ts's UNIT_REGISTRY imports the AgentFn wrapper
  // transitively — a real implementation isn't needed, just a stub so that
  // import doesn't fail.
  company_researcher: vi.fn(),
}))

import {
  dispatchTool,
  isRunTool,
  isValidTool,
  RESEARCH_COMPANIES_CONCURRENCY,
  RESEARCH_COMPANIES_DEFAULT_LIMIT,
  RESEARCH_COMPANIES_MAX_LIMIT,
  type CopilotToolContext,
} from './copilot-tools'
import type { AdminClient, DecryptedApiKeys } from './types'
import { runInTraceContext, SpanBuffer, type SpanRecord } from '../trace/spans'

// --- minimal in-memory fake of the PostgREST query-builder chain shapes ------
// dispatchTool's read tools actually use: select().eq().eq().maybeSingle(),
// select().eq().single(), select().eq().order().limit() (awaited directly).
// Not a general Supabase mock — just enough surface for these tools.

type Row = Record<string, unknown>

class FakeQuery implements PromiseLike<{ data: unknown; error: null }> {
  private rows: Row[]
  // Full table set, so an embedded-relation filter (ownedJobsQuery's own
  // `.eq('companies.user_id', userId)`) can join company_id -> companies
  // the way PostgREST's `companies!inner(...)` embed actually does — a plain
  // `r['companies.user_id']` lookup would just be undefined for every row.
  constructor(
    rows: Row[],
    private allTables: Record<string, Row[]> = {}
  ) {
    this.rows = rows
  }
  select(_cols?: string) {
    return this
  }
  // A column of the posting embedded in a person_roles row (`jobs.title`), or of that posting's company (`jobs.companies.user_id`).
  private get(r: Row, col: string): unknown {
    if (col.startsWith('jobs.companies.')) {
      const field = col.slice('jobs.companies.'.length)
      const company = (this.allTables.companies ?? []).find((c) => c.id === (r.jobs as Row | undefined)?.company_id)
      return company?.[field]
    }
    if (col.startsWith('jobs.')) return (r.jobs as Row | undefined)?.[col.slice('jobs.'.length)]
    return r[col]
  }
  eq(col: string, val: unknown) {
    // A filter on the embedded person_roles rows keeps only those rows inside each job, as PostgREST does.
    if (col.startsWith('person_roles.')) {
      const field = col.slice('person_roles.'.length)
      this.rows = this.rows.map((r) => ({ ...r, person_roles: ([] as Row[]).concat((r.person_roles as Row[] | Row | undefined) ?? []).filter((p) => p[field] === val) }))
      return this
    }
    if (col.startsWith('companies.')) {
      const field = col.slice('companies.'.length)
      const byId = new Map((this.allTables.companies ?? []).map((c) => [c.id, c]))
      this.rows = this.rows.filter((r) => byId.get(r.company_id as string)?.[field] === val)
      return this
    }
    this.rows = this.rows.filter((r) => this.get(r, col) === val)
    return this
  }
  in(col: string, vals: unknown[]) {
    this.rows = this.rows.filter((r) => vals.includes(this.get(r, col)))
    return this
  }
  is(col: string, val: unknown) {
    this.rows = this.rows.filter((r) => (val === null ? this.get(r, col) == null : this.get(r, col) === val))
    return this
  }
  ilike(col: string, pattern: string) {
    const needle = pattern.replace(/%/g, '').toLowerCase()
    this.rows = this.rows.filter((r) => String(r[col] ?? '').toLowerCase().includes(needle))
    return this
  }
  // Stand-in for websearch_to_tsquery over jobs.tsv: AND-matches every word
  // of the query against `title`, case-insensitively — enough to exercise
  // listJobs' "found via FTS" vs "FTS empty, fall back to trgm" branches
  // without simulating real tsvector stemming/ranking.
  textSearch(col: string, query: string, _opts?: unknown) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    this.rows = this.rows.filter((r) => {
      const haystack = String(this.get(r, col) ?? this.get(r, col.startsWith('jobs.') ? 'jobs.title' : 'title') ?? '').toLowerCase()
      return words.every((w) => haystack.includes(w))
    })
    return this
  }
  // openRolesOnly: the fixtures hold no stale or closed rows (freshness.test.ts covers the filter).
  or(_filters: string, _opts?: unknown) {
    return this
  }
  not(_col: string, _op: string, _val: unknown) {
    return this
  }
  order(_col: string, _opts?: unknown) {
    return this
  }
  limit(n: number) {
    this.rows = this.rows.slice(0, n)
    return this
  }
  async maybeSingle() {
    return { data: this.rows[0] ?? null, error: null }
  }
  async single() {
    return { data: this.rows[0] ?? null, error: this.rows[0] ? null : { message: 'not found' } }
  }
  // Support `await ctx.admin.from(...).select(...)` used directly (no
  // maybeSingle/single) by making the builder itself thenable.
  then<TResult1 = { data: unknown; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({ data: this.rows, error: null }).then(onfulfilled)
  }
}

/** Build a fake AdminClient over a fixed set of in-memory tables. Each call to
 *  .from(table) starts a fresh FakeQuery over a COPY of that table's rows, so
 *  filters from one call never bleed into another. `rpc` stands in for the
 *  trgm-fallback Postgres functions (search_jobs_by_title_trgm,
 *  search_contacts_by_name_trgm) — keyed by function name, returning that
 *  function's fixed row set regardless of params (these tests assert on the
 *  RESULT of the fallback branch firing, not on the RPC's own args). */
function fakeAdmin(tables: Record<string, Row[]>, rpc: Record<string, Row[]> = {}): AdminClient {
  const admin = {
    from(table: string) {
      return new FakeQuery([...(tables[table] ?? [])], tables)
    },
    async rpc(fn: string) {
      return { data: rpc[fn] ?? [], error: null }
    },
  }
  return admin as unknown as AdminClient
}

const BASE_KEYS: DecryptedApiKeys = { openrouter: 'fake-key', userId: 'me' }

/** The person's own row for a role (public.person_roles), as it comes back embedded in a job. */
function verdict(over: Row = {}): Row {
  return {
    user_id: 'me',
    checked_at: '2026-10-06T08:00:00Z',
    blocked_reasons: [],
    want_p: 0.7,
    want_reason: 'Payments work.',
    want_detail: null,
    chance: 'possible',
    chance_detail: { checks: [], gaps: [], confirm: [], note: null },
    ...over,
  }
}

function baseCtx(admin: AdminClient, overrides: Partial<CopilotToolContext> = {}): CopilotToolContext {
  return {
    admin,
    userId: 'me',
    userEmail: 'me@example.com',
    apiKeys: BASE_KEYS,
    ...overrides,
  }
}

describe('dispatchTool — agent gating (server-side, not merely prompt-hidden)', () => {
  it('rejects a tool whose spec names an agent NOT in enabledAgents', async () => {
    const admin = fakeAdmin({
      jobs: [{ id: 'job-1', title: 'Engineer', company_id: 'co-1', person_roles: [verdict()] }],
      companies: [{ id: 'co-1', name: 'Acme', user_id: 'me' }],
    })
    // explain_match's catalog spec has agent: 'matcher' — exclude it.
    const ctx = baseCtx(admin, { enabledAgents: new Set(['sourcer']) })

    const result = await dispatchTool(ctx, 'explain_match', { jobId: 'job-1' })

    expect(result).toMatchObject({ error: expect.stringContaining('matcher') })
    expect(result).toMatchObject({ error: expect.stringContaining('disabled') })
  })

  it('the SAME tool succeeds once its backing agent IS enabled', async () => {
    const admin = fakeAdmin({
      jobs: [{ id: 'job-1', title: 'Engineer', company_id: 'co-1', person_roles: [verdict()] }],
      companies: [{ id: 'co-1', name: 'Acme', user_id: 'me' }],
    })
    const ctx = baseCtx(admin, { enabledAgents: new Set(['matcher']) })

    const result = await dispatchTool(ctx, 'explain_match', { jobId: 'job-1' })

    expect(result).not.toHaveProperty('error')
    expect(result).toMatchObject({ matched: true, fit: { want: { reason: 'Payments work.' }, chance: { label: 'possible' } } })
    expect(JSON.stringify(result)).not.toMatch(/"score"/)
  })

  it('undefined enabledAgents means "all enabled" (default, unchanged behavior)', async () => {
    const admin = fakeAdmin({
      jobs: [{ id: 'job-1', title: 'Engineer', company_id: 'co-1', person_roles: [verdict()] }],
      companies: [{ id: 'co-1', name: 'Acme', user_id: 'me' }],
    })
    const ctx = baseCtx(admin) // no enabledAgents field at all

    const result = await dispatchTool(ctx, 'explain_match', { jobId: 'job-1' })
    expect(result).not.toHaveProperty('error')
  })

  it('a tool with NO backing agent (e.g. list_contacts) is never gated regardless of enabledAgents', async () => {
    const admin = fakeAdmin({ contacts: [] })
    const ctx = baseCtx(admin, { enabledAgents: new Set([]) }) // everything with an agent would be excluded

    const result = await dispatchTool(ctx, 'list_contacts', {})
    expect(result).not.toHaveProperty('error')
  })

  it('gating is enforced even though the model was never shown the tool (defense in depth) — the DB is never queried', async () => {
    const fromSpy = vi.fn((table: string) => new FakeQuery([]))
    const admin = { from: fromSpy } as unknown as AdminClient
    const ctx = baseCtx(admin, { enabledAgents: new Set(['sourcer']) })

    await dispatchTool(ctx, 'explain_match', { jobId: 'job-1' })

    // Rejected before ever touching the jobs/companies tables.
    expect(fromSpy).not.toHaveBeenCalled()
  })
})

describe('dispatchTool — always resolves to {error}, never throws', () => {
  it('an unknown tool name resolves to an {error} observation', async () => {
    const admin = fakeAdmin({})
    const ctx = baseCtx(admin)

    const result = await dispatchTool(ctx, 'not_a_real_tool', {})
    expect(result).toEqual({ error: expect.stringContaining('Unknown tool') })
  })

  it('a DB failure inside a tool handler is caught and returned as {error}, not thrown', async () => {
    const admin = {
      from(_table: string) {
        throw new Error('simulated DB outage')
      },
    } as unknown as AdminClient
    const ctx = baseCtx(admin)

    await expect(dispatchTool(ctx, 'list_runs', {})).resolves.toEqual({ error: 'simulated DB outage' })
  })

  it('an MCP-namespaced tool whose server lookup throws still resolves to {error}, not a rejection', async () => {
    const admin = {
      from(_table: string) {
        throw new Error('simulated DB outage during MCP server lookup')
      },
    } as unknown as AdminClient
    const ctx = baseCtx(admin)

    await expect(dispatchTool(ctx, 'mcp:myserver:sometool', {})).resolves.toEqual({
      error: 'simulated DB outage during MCP server lookup',
    })
  })

  it('a syntactically-unrecognized "mcp:" name falls through as an ordinary unknown tool (not a crash)', async () => {
    const admin = fakeAdmin({})
    const ctx = baseCtx(admin)

    // Missing the second colon segment -> isMcpToolName is false, so this
    // never reaches dispatchMcpTool at all and is just an unknown tool name.
    const result = await dispatchTool(ctx, 'mcp:', {})
    expect(result).toEqual({ error: expect.stringContaining('Unknown tool') })
  })

  it('a non-Error throw is stringified, not left as an unhandled rejection', async () => {
    const admin = {
      from(_table: string) {
        // eslint-disable-next-line no-throw-literal
        throw 'plain string failure'
      },
    } as unknown as AdminClient
    const ctx = baseCtx(admin)

    await expect(dispatchTool(ctx, 'list_runs', {})).resolves.toEqual({ error: 'plain string failure' })
  })
})

describe('dispatchTool — job ownership enforced transitively via companies.user_id', () => {
  it('a job owned by a DIFFERENT user is not reachable via explain_match, even with the correct jobId', async () => {
    const admin = fakeAdmin({
      jobs: [{ id: 'job-1', title: 'Secret Role', company_id: 'co-1', person_roles: [verdict({ chance: 'strong', want_p: 0.99, want_reason: 'secret reason' })] }],
      // co-1 belongs to someone else, NOT 'me'.
      companies: [{ id: 'co-1', name: 'Other Person Co', user_id: 'someone-else' }],
    })
    const ctx = baseCtx(admin) // ctx.userId === 'me'

    const result = await dispatchTool(ctx, 'explain_match', { jobId: 'job-1' })

    expect(result).toMatchObject({ error: expect.stringContaining('job-1') })
    expect(result).toMatchObject({ error: expect.stringContaining('not in your tracked companies') })
    // Precise-id-error requirement: names the tool that returns real ids, so
    // a model that guessed wrong can self-correct in one step.
    expect(result).toMatchObject({ error: expect.stringContaining('list_jobs') })
    // Nothing about the role's assessment leaks into the response.
    expect(JSON.stringify(result)).not.toContain('0.99')
    expect(JSON.stringify(result)).not.toContain('secret reason')
  })

  it('the identical job IS reachable once it belongs to the caller', async () => {
    const admin = fakeAdmin({
      jobs: [{ id: 'job-1', title: 'My Role', company_id: 'co-1', person_roles: [verdict({ chance: 'strong', want_p: 0.77, want_reason: 'Good fit.' })] }],
      companies: [{ id: 'co-1', name: 'My Co', user_id: 'me' }],
    })
    const ctx = baseCtx(admin)

    const result = await dispatchTool(ctx, 'explain_match', { jobId: 'job-1' })
    expect(result).toMatchObject({ matched: true, fit: { want: { reason: 'Good fit.' }, chance: { label: 'strong' } } })
  })

  it('get_application enforces the same ownership check before returning anything about the job', async () => {
    const admin = fakeAdmin({
      jobs: [{ id: 'job-2', title: 'Other Role', company_id: 'co-2' }],
      companies: [{ id: 'co-2', name: 'Not Mine Inc', user_id: 'someone-else' }],
      applications: [{ id: 'app-1', user_id: 'someone-else', job_id: 'job-2', stage: 'applied', applied_at: null }],
    })
    const ctx = baseCtx(admin)

    const result = await dispatchTool(ctx, 'get_application', { jobId: 'job-2' })
    expect(result).toMatchObject({ error: expect.stringContaining('job-2') })
    expect(result).toMatchObject({ error: expect.stringContaining('list_jobs') })
  })

  it('a job with no company_id at all is rejected rather than treated as ownerless/public', async () => {
    const admin = fakeAdmin({
      jobs: [{ id: 'job-3', title: 'Orphan Role', company_id: null, chance: 'stretch' }],
      companies: [],
    })
    const ctx = baseCtx(admin)

    const result = await dispatchTool(ctx, 'explain_match', { jobId: 'job-3' })
    expect(result).toEqual({ error: 'Job has no company' })
  })

  it('get_dossier (agent: company_researcher) enforces ownership too, and does not leak whether a dossier exists for a company that is not the caller\'s', async () => {
    const admin = fakeAdmin({
      companies: [{ id: 'co-9', name: 'Rival Corp', user_id: 'someone-else', domain: 'rival.com' }],
      company_dossiers: [
        { company_id: 'co-9', user_id: 'someone-else', summary: 'Confidential dossier text', sponsors_visa: 'likely', signals: {}, comp_intel: {}, refreshed_at: null },
      ],
    })
    const ctx = baseCtx(admin)

    const result = await dispatchTool(ctx, 'get_dossier', { companyId: 'co-9' })
    expect(result).toMatchObject({ error: expect.stringContaining('co-9') })
    expect(result).toMatchObject({ error: expect.stringContaining('list_jobs') })
    expect(JSON.stringify(result)).not.toContain('Confidential')
  })
})

describe('dispatchTool — web_search (mocked @/lib/search, zero real network)', () => {
  it('requires a query', async () => {
    const admin = fakeAdmin({})
    const ctx = baseCtx(admin)
    const result = await dispatchTool(ctx, 'web_search', {})
    expect(result).toEqual({ error: 'query is required' })
    expect(webSearchMock).not.toHaveBeenCalled()
  })

  it('returns normalized results and forwards this user\'s id so webSearch() resolves every configured BYOK backend', async () => {
    webSearchMock.mockResolvedValueOnce({
      backend: 'exa',
      ok: true,
      results: [{ title: 'AI Engineer', url: 'https://boards.greenhouse.io/acme/jobs/1', snippet: 'Hiring now.', source: 'boards.greenhouse.io' }],
    })
    const admin = fakeAdmin({})
    const ctx = baseCtx(admin)

    const result = await dispatchTool(ctx, 'web_search', { query: 'AI Engineer remote', limit: 3 })

    // userId (not a pre-resolved exaKey) is what's forwarded now — webSearch()
    // itself resolves EVERY configured backend (tavily/serper/exa/searxng)
    // from this one field, not just Exa (see lib/search/index.ts's
    // resolveCredentials). This is what makes a Tavily/Serper key configured
    // in Settings actually reach the copilot's web_search tool.
    expect(webSearchMock).toHaveBeenCalledWith('AI Engineer remote', expect.objectContaining({ limit: 3, userId: 'me' }))
    expect(result).toMatchObject({
      count: 1,
      backend: 'exa',
      results: [{ title: 'AI Engineer', url: 'https://boards.greenhouse.io/acme/jobs/1' }],
    })
    expect(result).not.toHaveProperty('error')
  })

  it('reports zero results honestly instead of an error', async () => {
    webSearchMock.mockResolvedValueOnce({ backend: 'duckduckgo', ok: true, results: [], reason: 'no_results' })
    const admin = fakeAdmin({})
    const ctx = baseCtx(admin)

    const result = await dispatchTool(ctx, 'web_search', { query: 'an extremely specific query' })
    expect(result).toMatchObject({ count: 0, results: [], reason: 'no_results' })
    expect(result).not.toHaveProperty('error')
  })

  it('surfaces a backend failure (e.g. all configured backends failed) as {error}, never throws', async () => {
    webSearchMock.mockResolvedValueOnce({ backend: 'duckduckgo', ok: false, results: [], reason: 'blocked', detail: 'bot challenge' })
    const admin = fakeAdmin({})
    const ctx = baseCtx(admin)

    const result = await dispatchTool(ctx, 'web_search', { query: 'remote software engineer' })
    expect(result).toMatchObject({ error: expect.stringContaining('blocked') })
  })

  it('a webSearch() rejection still resolves to {error} rather than throwing out of dispatchTool', async () => {
    webSearchMock.mockRejectedValueOnce(new Error('unexpected'))
    const admin = fakeAdmin({})
    const ctx = baseCtx(admin)

    const result = await dispatchTool(ctx, 'web_search', { query: 'AI Engineer' })
    expect(result).toMatchObject({ error: expect.any(String) })
  })
})

// --- research_company / research_companies -----------------------------------
//
// The parallelism fix: the copilot used to have only a SINGULAR
// research_company tool, so "verify 6 companies" was 6 serial turns — it
// exhausted its step budget after 2 (see the workflow brief this file was
// updated for). research_companies fans out internally with BOUNDED
// concurrency instead. These tests prove: (1) the batch size cannot exceed
// its hard cap no matter what the model passes, (2) one bad/invented id never
// fails the rest of the batch — every id gets its own per-item result and
// reason, mirroring score_jobs' jobResults, and (3) the fan-out is actually
// concurrency-bounded, not secretly serial or secretly unbounded.

function companyRow(id: string, overrides: Partial<Row> = {}): Row {
  return { id, name: `Company ${id}`, user_id: 'me', domain: null, ...overrides }
}

/** Default generateDossier stand-in: resolves immediately with a minimal,
 *  successful CompanyResearcherResult keyed off whatever company was passed
 *  in — good enough for tests that only care about which companies were
 *  attempted, not dossier content itself. */
function defaultDossierImpl({ company }: { company: { id: string; name: string } }) {
  return Promise.resolve({
    dossierId: `dossier-${company.id}`,
    companyId: company.id,
    sponsorsVisa: 'unknown' as const,
    hasSummary: true,
    sourceCount: 2,
  })
}

afterEach(() => {
  generateDossierMock.mockReset()
})

describe('research_companies — catalog wiring', () => {
  it('is a recognized, "run"-kind tool (gated by the route\'s one-run-tool-per-turn budget, like trigger_run)', () => {
    expect(isValidTool('research_companies')).toBe(true)
    expect(isRunTool('research_companies')).toBe(true)
  })
})

describe('dispatchTool — research_company (precise id errors, self-correction)', () => {
  it('an invented/unknown companyId gets an error naming the exact id AND the tool to get a real one', async () => {
    const admin = fakeAdmin({ companies: [] })
    const ctx = baseCtx(admin)

    const result = await dispatchTool(ctx, 'research_company', { companyId: 'e6f0a1b2-fake' })

    expect(result).toMatchObject({ error: expect.stringContaining('e6f0a1b2-fake') })
    expect(result).toMatchObject({ error: expect.stringContaining('list_jobs') })
    expect(generateDossierMock).not.toHaveBeenCalled()
  })

  it('a company owned by someone else resolves the SAME precise not-found error (no existence leak)', async () => {
    const admin = fakeAdmin({ companies: [companyRow('co-9', { user_id: 'someone-else' })] })
    const ctx = baseCtx(admin)

    const result = await dispatchTool(ctx, 'research_company', { companyId: 'co-9' })

    expect(result).toMatchObject({ error: expect.stringContaining('co-9') })
    expect(result).toMatchObject({ error: expect.stringContaining('list_jobs') })
    expect(generateDossierMock).not.toHaveBeenCalled()
  })

  it('a real, owned companyId researches successfully', async () => {
    generateDossierMock.mockImplementation(defaultDossierImpl)
    const admin = fakeAdmin({ companies: [companyRow('co-1')], jobs: [] })
    const ctx = baseCtx(admin)

    const result = await dispatchTool(ctx, 'research_company', { companyId: 'co-1' })

    expect(result).not.toHaveProperty('error')
    expect(result).toMatchObject({ company: 'Company co-1', dossierId: 'dossier-co-1' })
  })
})

describe('dispatchTool — research_companies (batch: caps, partial failure, bounded concurrency)', () => {
  it('requires a non-empty companyIds array', async () => {
    const admin = fakeAdmin({})
    const ctx = baseCtx(admin)

    const result = await dispatchTool(ctx, 'research_companies', {})

    expect(result).toMatchObject({ error: expect.stringContaining('companyIds') })
    expect(generateDossierMock).not.toHaveBeenCalled()
  })

  it('with no explicit limit, caps the batch at the DEFAULT size even with more ids passed', async () => {
    generateDossierMock.mockImplementation(defaultDossierImpl)
    const ids = Array.from({ length: RESEARCH_COMPANIES_DEFAULT_LIMIT + 4 }, (_, i) => `co-${i}`)
    const admin = fakeAdmin({ companies: ids.map((id) => companyRow(id)), jobs: [] })
    const ctx = baseCtx(admin)

    const result = await dispatchTool(ctx, 'research_companies', { companyIds: ids })

    expect(generateDossierMock).toHaveBeenCalledTimes(RESEARCH_COMPANIES_DEFAULT_LIMIT)
    expect(result).toMatchObject({ requested: ids.length, researched: RESEARCH_COMPANIES_DEFAULT_LIMIT })
    expect(result).toMatchObject({ note: expect.stringContaining('research_companies again') })
  })

  it('a large requested limit is clamped to the HARD MAX, never exceeding it', async () => {
    generateDossierMock.mockImplementation(defaultDossierImpl)
    const ids = Array.from({ length: RESEARCH_COMPANIES_MAX_LIMIT + 5 }, (_, i) => `co-${i}`)
    const admin = fakeAdmin({ companies: ids.map((id) => companyRow(id)), jobs: [] })
    const ctx = baseCtx(admin)

    const result = await dispatchTool(ctx, 'research_companies', { companyIds: ids, limit: 999 })

    expect(generateDossierMock).toHaveBeenCalledTimes(RESEARCH_COMPANIES_MAX_LIMIT)
    expect(result).toMatchObject({ researched: RESEARCH_COMPANIES_MAX_LIMIT })
  })

  it('a negative/invalid limit falls back to the default, not zero and not unlimited', async () => {
    generateDossierMock.mockImplementation(defaultDossierImpl)
    const ids = Array.from({ length: RESEARCH_COMPANIES_DEFAULT_LIMIT + 3 }, (_, i) => `co-${i}`)
    const admin = fakeAdmin({ companies: ids.map((id) => companyRow(id)), jobs: [] })
    const ctx = baseCtx(admin)

    const result = await dispatchTool(ctx, 'research_companies', { companyIds: ids, limit: -7 })

    expect(generateDossierMock).toHaveBeenCalledTimes(RESEARCH_COMPANIES_DEFAULT_LIMIT)
    expect(result).toMatchObject({ researched: RESEARCH_COMPANIES_DEFAULT_LIMIT })
  })

  it('duplicate ids in the request are de-duplicated before the cap is applied', async () => {
    generateDossierMock.mockImplementation(defaultDossierImpl)
    const admin = fakeAdmin({ companies: [companyRow('co-1'), companyRow('co-2')], jobs: [] })
    const ctx = baseCtx(admin)

    const result = await dispatchTool(ctx, 'research_companies', {
      companyIds: ['co-1', 'co-1', 'co-2', 'co-1'],
    })

    expect(generateDossierMock).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ requested: 4, researched: 2 })
  })

  it('one bad/unknown id never fails the batch — every id gets its own status + reason', async () => {
    generateDossierMock.mockImplementation(defaultDossierImpl)
    const admin = fakeAdmin({ companies: [companyRow('co-good')], jobs: [] })
    const ctx = baseCtx(admin)

    const result = (await dispatchTool(ctx, 'research_companies', {
      companyIds: ['co-good', 'co-invented-does-not-exist'],
    })) as { requested: number; researched: number; failed: number; results: Array<Record<string, unknown>> }

    expect(result.requested).toBe(2)
    expect(result.researched).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.results).toHaveLength(2)

    const good = result.results.find((r) => r.companyId === 'co-good')
    const bad = result.results.find((r) => r.companyId === 'co-invented-does-not-exist')
    expect(good).toMatchObject({ status: 'researched', dossierId: 'dossier-co-good' })
    expect(bad).toMatchObject({ status: 'error' })
    expect(String((bad as Record<string, unknown>).reason)).toContain('co-invented-does-not-exist')
    expect(String((bad as Record<string, unknown>).reason)).toContain('list_jobs')
  })

  it('a generateDossier throw for one company is caught and reported per-item, not thrown from the tool', async () => {
    generateDossierMock.mockImplementation(async ({ company }: { company: { id: string; name: string } }) => {
      if (company.id === 'co-boom') throw new Error('simulated fetch failure')
      return defaultDossierImpl({ company })
    })
    const admin = fakeAdmin({ companies: [companyRow('co-ok'), companyRow('co-boom')], jobs: [] })
    const ctx = baseCtx(admin)

    const result = (await dispatchTool(ctx, 'research_companies', {
      companyIds: ['co-ok', 'co-boom'],
    })) as { researched: number; failed: number; results: Array<Record<string, unknown>> }

    expect(result.researched).toBe(1)
    expect(result.failed).toBe(1)
    const boom = result.results.find((r) => r.companyId === 'co-boom')
    expect(boom).toMatchObject({ status: 'error' })
    expect(String((boom as Record<string, unknown>).reason)).toContain('simulated fetch failure')
  })

  it('fans out with BOUNDED concurrency — never more in flight than the cap, but genuinely parallel (not serial)', async () => {
    const ids = Array.from({ length: RESEARCH_COMPANIES_MAX_LIMIT }, (_, i) => `co-${i}`)
    const admin = fakeAdmin({ companies: ids.map((id) => companyRow(id)), jobs: [] })
    const ctx = baseCtx(admin)

    let inFlight = 0
    let maxInFlight = 0
    generateDossierMock.mockImplementation(async ({ company }: { company: { id: string; name: string } }) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 10))
      inFlight--
      return defaultDossierImpl({ company })
    })

    const result = await dispatchTool(ctx, 'research_companies', { companyIds: ids, limit: RESEARCH_COMPANIES_MAX_LIMIT })

    expect(result).toMatchObject({ researched: RESEARCH_COMPANIES_MAX_LIMIT })
    // Bounded: never exceeds the documented concurrency cap...
    expect(maxInFlight).toBeLessThanOrEqual(RESEARCH_COMPANIES_CONCURRENCY)
    // ...but genuinely parallel, not accidentally serialized to 1-at-a-time.
    expect(maxInFlight).toBeGreaterThan(1)
  })
})

// ---------------------------------------------------------------------------
// list_jobs / list_contacts: ILIKE retired for FTS + trgm (20260816000009_
// job_search.sql). One check per branch: FTS match, short-query trgm-direct,
// FTS-empty trgm-fallback, and list_contacts' own trgm search.
// ---------------------------------------------------------------------------
describe('list_jobs — FTS + trgm search (ILIKE retired)', () => {
  const co = { id: 'co-1', name: 'Acme', user_id: 'me', is_dream_company: false }
  // The person's own rows, each with its posting embedded, as the list query returns them.
  const posting = (id: string, title: string, chance: string, want_p: number) => ({
    user_id: 'me',
    job_id: id,
    hidden_reason: null,
    chance,
    want_p,
    jobs: { id, title, company_id: 'co-1', is_new: false, location: null, posted_at: null },
  })
  const person_roles = [posting('job-1', 'Staff Backend Engineer', 'strong', 0.8), posting('job-2', 'Product Designer', 'possible', 0.6)]

  it('a real word query (>=4 chars) matches via FTS (textSearch), no rpc needed', async () => {
    const admin = fakeAdmin({ companies: [co], person_roles })
    const ctx = baseCtx(admin)

    const result = (await dispatchTool(ctx, 'list_jobs', { query: 'backend' })) as { jobs: { jobId: string }[] }

    expect(result.jobs).toHaveLength(1)
    expect(result.jobs[0].jobId).toBe('job-1')
  })

  it('a short query (<4 chars) skips FTS and goes straight to the trgm rpc', async () => {
    const admin = fakeAdmin({ companies: [co], person_roles }, { search_jobs_by_title_trgm: [{ job_id: 'job-2', score: 0.9 }] })
    const ctx = baseCtx(admin)

    const result = (await dispatchTool(ctx, 'list_jobs', { query: 'dsn' })) as { jobs: { jobId: string }[] }

    expect(result.jobs).toHaveLength(1)
    expect(result.jobs[0].jobId).toBe('job-2')
  })

  it('an FTS miss (typo) falls back to the trgm rpc instead of reporting empty', async () => {
    // "enginer" matches no title via the FTS stand-in (textSearch is a
    // straight substring match), but the trgm rpc fixture stands in for
    // Postgres finding job-1 by similarity anyway.
    const admin = fakeAdmin({ companies: [co], person_roles }, { search_jobs_by_title_trgm: [{ job_id: 'job-1', score: 0.5 }] })
    const ctx = baseCtx(admin)

    const result = (await dispatchTool(ctx, 'list_jobs', { query: 'enginer' })) as { jobs: { jobId: string }[] }

    expect(result.jobs).toHaveLength(1)
    expect(result.jobs[0].jobId).toBe('job-1')
  })
})

describe('list_contacts — trgm search (ILIKE retired)', () => {
  it('a query resolves through the trgm rpc, not a substring scan', async () => {
    const admin = fakeAdmin(
      { contacts: [{ id: 'c-1', name: 'Dana Okafor', user_id: 'me', email: null, title: null, relationship: null, company_id: null, last_contact_at: null }] },
      { search_contacts_by_name_trgm: [{ contact_id: 'c-1', score: 0.8 }] }
    )
    const ctx = baseCtx(admin)

    const result = (await dispatchTool(ctx, 'list_contacts', { query: 'Dana' })) as { contacts: { id: string }[] }

    expect(result.contacts).toHaveLength(1)
    expect(result.contacts[0].id).toBe('c-1')
  })

  it('no rpc matches -> empty result, no error', async () => {
    const admin = fakeAdmin({ contacts: [] }, { search_contacts_by_name_trgm: [] })
    const ctx = baseCtx(admin)

    const result = (await dispatchTool(ctx, 'list_contacts', { query: 'nobody' })) as { contacts: unknown[]; count: number }

    expect(result.count).toBe(0)
    expect(result.contacts).toEqual([])
  })
})

// Every tool call is one Langfuse observation under the active trace.
describe('dispatchTool in Langfuse', () => {
  const configure = (isDemo: boolean) => {
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-lf-fake')
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-fake')
    vi.stubEnv('LANGFUSE_BASE_URL', 'https://langfuse.example.com')
    vi.stubEnv('LANGFUSE_CONTENT_USER_IDS', 'u1,u,me,user-1')
    vi.stubEnv('LANGFUSE_DEMO_SAMPLE_RATE', '1')
    return new SpanBuffer('me', null, undefined, { isDemo })
  }
  afterEach(() => {
    vi.unstubAllEnvs()
  })
  const traced = async (buffer: SpanBuffer, ctx: CopilotToolContext, tool: string, args: Record<string, unknown>) => {
    const result = await runInTraceContext({ buffer, parentSpanId: 'root', runId: null }, () => dispatchTool(ctx, tool, args))
    return { result, rows: (buffer as unknown as { pending: SpanRecord[] }).pending }
  }

  it('a built-in tool is a tool observation named for the tool, under the active span, with its args and result', async () => {
    const admin = fakeAdmin({
      jobs: [{ id: 'job-1', title: 'Engineer', company_id: 'co-1', person_roles: [verdict()] }],
      companies: [{ id: 'co-1', name: 'Acme', user_id: 'me' }],
    })
    const { rows } = await traced(configure(false), baseCtx(admin), 'explain_match', { jobId: 'job-1' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'tool', name: 'explain_match', parent_span_id: 'root', status: 'ok', attributes: { tool: 'explain_match', error: false } })
    expect(rows[0].lf).toMatchObject({ name: 'explain_match', type: 'tool', input: { jobId: 'job-1' }, output: { matched: true, fit: expect.objectContaining({ chance: expect.objectContaining({ label: 'possible' }) }) } })
  })

  it('web_search is a retriever', async () => {
    webSearchMock.mockResolvedValue({ results: [] })
    const { rows } = await traced(configure(false), baseCtx(fakeAdmin({})), 'web_search', { query: 'acme' })
    expect(rows[0].lf?.type).toBe('retriever')
  })

  it('search_kb is a retriever too, and a non-lookup tool stays a tool', async () => {
    const kb = await traced(configure(false), baseCtx(fakeAdmin({})), 'search_kb', {})
    expect(kb.rows[0].lf?.type).toBe('retriever')
    const other = await traced(configure(false), baseCtx(fakeAdmin({})), 'explain_match', { jobId: 'x' })
    expect(other.rows[0].lf?.type).toBe('tool')
  })

  it('a returned { error } marks the observation ERROR with a coarse code, and the raw message only with capture on', async () => {
    const owner = await traced(configure(false), baseCtx(fakeAdmin({}), { enabledAgents: new Set(['sourcer']) }), 'explain_match', { jobId: 'job-1' })
    expect(owner.rows[0].lf).toMatchObject({ level: 'ERROR', errorCode: 'agent_disabled' })
    expect(owner.rows[0].lf?.errorMessage).toContain('disabled')
    expect(owner.rows[0].attributes).toMatchObject({ error: true })
    const unknown = await traced(configure(false), baseCtx(fakeAdmin({})), 'not_a_tool_sk-abc', {})
    expect(unknown.rows[0]).toMatchObject({ name: 'unknown-tool' })
    expect(unknown.rows[0].lf).toMatchObject({ level: 'ERROR', errorCode: 'unknown_tool' })
  })

  it('list_contacts, get_dossier and get_application send ids and counts, never other people\'s details', async () => {
    const admin = fakeAdmin({
      contacts: [
        { id: 'c-1', user_id: 'me', name: 'Jane Recruiter', email: 'jane@acme.com', title: 'Recruiter', company_id: 'co-1' },
        { id: 'c-2', user_id: 'me', name: 'Joe Manager', email: 'joe@acme.com', title: 'Manager', company_id: 'co-1' },
      ],
    })
    const { rows } = await traced(configure(false), baseCtx(admin), 'list_contacts', { query: 'jane', companyId: 'co-1' })
    const lf = rows[0].lf!
    expect(lf.input).toEqual({ ids: { companyId: 'co-1' } })
    expect(lf.output).toMatchObject({ count: expect.any(Number), ids: expect.any(Array) })
    const dump = JSON.stringify(lf)
    for (const secret of ['Jane', 'jane@acme.com', 'Recruiter', 'Joe']) expect(dump).not.toContain(secret)
  })

  it('get_dossier and get_application report a real count and the ids asked about, still no details', async () => {
    const admin = fakeAdmin({
      jobs: [{ id: 'job-1', title: 'Secret Role', company_id: 'co-1', user_id: 'me' }],
      companies: [{ id: 'co-1', name: 'Acme', user_id: 'me' }],
      applications: [{ id: 'app-1', job_id: 'job-1', user_id: 'me', stage: 'applied', notes: 'private note' }],
      company_dossiers: [{ company_id: 'co-1', user_id: 'me', summary: 'Dossier gossip', sponsors_visa: 'likely', signals: {}, comp_intel: {}, refreshed_at: null }],
    })
    const dossier = await traced(configure(false), baseCtx(admin), 'get_dossier', { companyId: 'co-1' })
    expect(dossier.rows[0].lf?.output).toEqual({ count: 1, ids: ['co-1'] })
    expect(dossier.rows[0].attributes).toBeDefined()
    const app = await traced(configure(false), baseCtx(admin), 'get_application', { jobId: 'job-1' })
    expect(app.rows[0].lf?.output).toMatchObject({ count: 1, ids: expect.arrayContaining(['job-1', 'app-1']) })
    const dump = JSON.stringify([dossier.rows[0].lf, app.rows[0].lf])
    for (const secret of ['Dossier gossip', 'private note', 'Secret Role']) expect(dump).not.toContain(secret)
  })

  it('an MCP tool is always call-mcp-tool; the server and tool names only travel as capture-gated detail', async () => {
    const admin = { from: () => { throw new Error('mcp server lookup failed') } } as unknown as AdminClient
    const { rows } = await traced(configure(false), baseCtx(admin), 'mcp:evil sk-ant-api03-CANARY_x:sometool', {})
    expect(rows[0].name).toBe('call-mcp-tool')
    expect(rows[0].lf).toMatchObject({ name: 'call-mcp-tool', detail: { mcp_server: expect.any(String), mcp_tool: 'sometool' } })
  })

  it('a demo trace builds no input or output for a tool call', async () => {
    const admin = fakeAdmin({ contacts: [] })
    const { rows } = await traced(configure(true), baseCtx(admin), 'list_contacts', {})
    expect(rows[0].lf?.input).toBeUndefined()
    expect(rows[0].lf?.output).toBeUndefined()
  })

  it('outside a trace, and with Langfuse off, dispatching is unchanged and records nothing', async () => {
    const admin = fakeAdmin({ contacts: [] })
    const plain = await dispatchTool(baseCtx(admin), 'list_contacts', {})
    expect(plain).not.toHaveProperty('error')
    const buffer = new SpanBuffer('me', null, undefined, { isDemo: false }) // Langfuse unconfigured
    const { rows } = await traced(buffer, baseCtx(admin), 'list_contacts', {})
    expect(rows[0].lf).toBeUndefined()
  })
})
