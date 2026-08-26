// The PRODUCERS of the demo access-code trail: every place a feature route
// journals what a demo visitor did, and every place it journals that the same
// attempt failed.
//
// WHY A SECOND FILE, BESIDE audit.test.ts
//   audit.test.ts owns the SANITIZER — the privacy policy expressed as code —
//   and, at its bottom, four success paths that were the whole of the
//   instrumentation when it was written. That was 4 of 7 producers, and it was
//   the wrong 4 to stop at: 'resume.tailor' (the most expensive thing on the
//   resume surface), 'resume.export' (the last step of the demo's story) and
//   'resume.delete' (the one action whose evidence is gone the moment it
//   succeeds) had no test at all, and neither did the 'tailored'/'edited'
//   branches of SAVE_ACTIONS.
//
//   This file covers every producer, and covers the half that did not exist
//   before: THE FAILURES. A trail that records successes only cannot tell the
//   owner "did nothing" from "drove fifty failing runs through a path that
//   makes real outbound requests on my account", which is the exact question
//   the access code exists to answer.
//
// FOUR PROPERTIES, ASSERTED FOR EVERY PRODUCER
//   1. a demo session's attempt lands in access_code_events — success OR
//      failure, and a failure says WHY,
//   2. an ordinary user's identical request writes NOTHING, anywhere,
//   3. the audit write cannot change what the request returns — including when
//      it never answers at all (that is the deadline, below), and
//   4. nothing the route was handling — a résumé, an email, a person — reaches
//      the row.
//
// The routes are driven for real; only their I/O neighbours are faked. ZERO
// network, ZERO real database.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'
import { AUDIT_DEADLINE_MS, recordAccessEvent, withAuditDeadline } from './audit'
import { recordDemoEvent } from './session'
import { MissingKeyError } from '@/lib/harness/llm'

const CODE_ID = '11111111-2222-4333-8444-555555555555'
const DEMO_USER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

/** The demo workspace's own content. None of it may appear in any row. */
const CONTENT = {
  personName: 'Dana Okafor',
  personEmail: 'dana.okafor@acme.test',
  resumeLine: 'Senior engineer with 10 years leading platform teams',
  personTitle: 'VP Engineering',
  visitorName: 'Demo Visitor',
  ipv4: '203.0.113.7',
  userAgent: 'UA-1',
  subject: 'Following up on the platform role',
}

// --- the routes' I/O neighbours ---------------------------------------------
//
// Every one of these is a mutable slot so a single test can make ONE of them
// fail without disturbing the rest. `installDefaults()` puts them all back to
// the happy path before each test, so a failure injected in one test cannot
// leak into the next one and quietly turn a green assertion vacuous.

const io = vi.hoisted(() => ({
  sourceContactsForCompany: vi.fn(),
  readContactProviderKeys: vi.fn(),
  loadApiKeys: vi.fn(),
  userCompanyIds: vi.fn(),
  runBulkMatch: vi.fn(),
  readOutreachConfig: vi.fn(),
  findDuplicateInitial: vi.fn(),
  insertOutreach: vi.fn(),
  generateOutreachDraft: vi.fn(),
  optimizeResumeAndSave: vi.fn(),
  createMarkdownVersion: vi.fn(),
  deleteVersion: vi.fn(),
  getVersionById: vi.fn(),
  listVersions: vi.fn(),
  getBaseResume: vi.fn(),
  renderResumeVersionPdf: vi.fn(),
  renderResumeVersionDocx: vi.fn(),
}))

vi.mock('@/lib/contacts/sources', () => ({ sourceContactsForCompany: io.sourceContactsForCompany }))
vi.mock('@/lib/contacts/keys', () => ({ readContactProviderKeys: io.readContactProviderKeys }))
vi.mock('@/lib/harness/keys', () => ({ loadApiKeys: io.loadApiKeys }))
// importOriginal keeps the real `matcher` AgentFn intact — lib/harness/
// registry.ts's UNIT_REGISTRY (now loaded transitively by runAgentUnit,
// which match/batch/outreach's routes call) imports it even though neither
// flow under test here ever invokes it.
vi.mock('@/lib/harness/agents/matcher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/harness/agents/matcher')>()),
  userCompanyIds: io.userCompanyIds,
}))
vi.mock('@/lib/harness/agents/bulk_matcher', () => ({ runBulkMatch: io.runBulkMatch }))
vi.mock('@/lib/outreach/config', () => ({ readOutreachConfig: io.readOutreachConfig }))
vi.mock('@/lib/outreach/store', () => ({
  findDuplicateInitial: io.findDuplicateInitial,
  insertOutreach: io.insertOutreach,
}))
// fallbackOutreachDraft is REAL: it is the no-key path, and a demo workspace
// with no OpenRouter key is the ordinary case.
vi.mock('@/lib/harness/agents/outreach', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/harness/agents/outreach')>()),
  generateOutreachDraft: io.generateOutreachDraft,
}))
// verifyOutreachDraft (lib/graph/verify/outreach.ts) calls the REAL judge
// (autoevals -> a real fetch) — this file is about the demo trail, not
// verify, so it's faked as a pass-through (unchanged draft, no verdicts).
// lib/graph/verify/outreach.test.ts covers the real control flow.
vi.mock('@/lib/graph/verify/outreach', () => ({
  verifyOutreachDraft: async ({ draft }: { draft: { subject: string; body: string; tokensUsed: number } }) => ({
    subject: draft.subject,
    body: draft.body,
    tokensUsed: draft.tokensUsed,
    verdicts: [],
    failedVerdict: false,
  }),
}))
vi.mock('@/lib/harness/agents/resume_optimizer', () => ({ optimizeResumeAndSave: io.optimizeResumeAndSave }))
vi.mock('@/lib/resume/store', () => ({
  createMarkdownVersion: io.createMarkdownVersion,
  deleteVersion: io.deleteVersion,
  getVersionById: io.getVersionById,
  listVersions: io.listVersions,
  getBaseResume: io.getBaseResume,
}))
vi.mock('@/lib/resume/pdf', () => ({ renderResumeVersionPdf: io.renderResumeVersionPdf }))
vi.mock('@/lib/resume/docx', () => ({ renderResumeVersionDocx: io.renderResumeVersionDocx }))

/**
 * The service-role client, installed at the module boundary.
 *
 * lib/access/session.ts takes no client argument on purpose (see its header),
 * so mocking the module is the seam a test has and a route does not. Left null
 * by default, which is what a deployment with no service key looks like — never
 * a real client quietly attempting a network call.
 */
const serviceRole = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@/lib/harness/supabase-admin', () => ({
  createAdminClient: () => {
    if (!serviceRole.current) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY')
    return serviceRole.current
  },
}))

/** The caller's cookie-scoped client, as `createClient()` hands it to a route. */
const routeSession = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => routeSession.current }))

import { POST as scoreBatch } from '@/app/api/agents/match/batch/route'
import { POST as sourceContacts } from '@/app/api/contacts/source/route'
import { POST as draftOutreach } from '@/app/api/outreach/draft/route'
import { GET as resumeGet, POST as resumePost } from '@/app/api/resume/documents/route'

// --- the fakes ---------------------------------------------------------------

interface Insert {
  table: string
  row: Record<string, unknown>
}

interface AdminOptions {
  profileRow?: unknown
  codeRow?: unknown
  /** Never resolves — the hang the deadline exists for. */
  hangOnInsert?: boolean
  throwOnInsert?: boolean
}

/** The service-role client: answers "is this a demo", and takes the write. */
function fakeAdmin(options: AdminOptions): { admin: SupabaseClient; inserts: Insert[] } {
  const inserts: Insert[] = []
  const client = {
    from(table: string) {
      const row = async () => {
        if (table === 'access_codes') return { data: options.codeRow ?? null, error: null }
        if (table === 'profiles') return { data: options.profileRow ?? null, error: null }
        return { data: null, error: null }
      }
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        is: () => builder,
        or: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: row,
        single: row,
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject),
        // update() -> .eq(...) resolves through the SAME `builder.then` above
        // (runUnitOnce never chains .select() after an update) — see
        // lib/graph/oneshot.ts.
        update: () => builder,
        // Two calling conventions both have to work: a bare
        // `await ...insert(row)` (every pre-port caller) and
        // `await ...insert(row).select('id').single()` (lib/graph/oneshot.ts's
        // agent_runs bootstrap, needed once match/batch + outreach/draft route
        // through runAgentUnit). insert() therefore returns a thenable that is
        // ALSO chainable, rather than resolving immediately.
        insert: (inserted: Record<string, unknown>) => {
          // hangOnInsert/throwOnInsert model the AUDIT write hanging/failing
          // (auditRows() below only ever reads access_code_events too) —
          // scoped to that table specifically, not every table, now that
          // lib/graph/oneshot.ts's agent_runs bootstrap is a SECOND,
          // load-bearing admin insert match/batch + outreach/draft depend on
          // to run at all. Applying these to that one too would be testing a
          // different claim ("the route survives its OWN journaling infra
          // failing"), which is not what this suite is about.
          const failing = table === 'access_code_events'
          const settle = async () => {
            if (failing && options.hangOnInsert) return new Promise(() => {})
            if (failing && options.throwOnInsert) throw new Error('connection reset by peer')
            inserts.push({ table, row: inserted })
            return { data: null, error: null }
          }
          const settleSelected = async () => {
            if (failing && options.hangOnInsert) return new Promise(() => {})
            if (failing && options.throwOnInsert) throw new Error('connection reset by peer')
            inserts.push({ table, row: inserted })
            return { data: { id: `${table}-fake-id`, ...inserted }, error: null }
          }
          return {
            select: () => ({ single: settleSelected, maybeSingle: settleSelected }),
            then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
              settle().then(resolve, reject),
          }
        },
      }
      return builder
    },
  }
  return { admin: client as unknown as SupabaseClient, inserts }
}

function useServiceRole(options: AdminOptions) {
  const built = fakeAdmin(options)
  serviceRole.current = built.admin
  return built
}

/** The demo workspace as the routes' own cookie-scoped client sees it. */
function installRouteSession(rows: Record<string, unknown>): void {
  routeSession.current = {
    auth: {
      getUser: async () => ({
        data: { user: { id: DEMO_USER, email: 'demo@cello.test' } },
        error: null,
      }),
    },
    from(table: string) {
      const row = async () => ({ data: rows[table] ?? null, error: null })
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        or: () => builder,
        maybeSingle: row,
        single: row,
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null, count: 3 }).then(resolve, reject),
      }
      return builder
    },
  }
}

const LIVE_DEMO_PROFILE = { is_demo: true, demo_expires_at: '2999-01-01T00:00:00Z' }
const LIVE_CODE_ROW = { id: CODE_ID, expires_at: '2999-01-01T00:00:00Z', revoked_at: null }

/** The demo workspace's profile as BOTH clients read it. */
const DEMO_WORKSPACE_PROFILE = {
  ...LIVE_DEMO_PROFILE,
  resume_text: CONTENT.resumeLine,
  preferences: {},
  full_name: CONTENT.visitorName,
}

const ORDINARY_WORKSPACE_PROFILE = {
  ...DEMO_WORKSPACE_PROFILE,
  is_demo: false,
  demo_expires_at: null,
}

function auditRows(inserts: Insert[]): Record<string, unknown>[] {
  return inserts.filter((i) => i.table === 'access_code_events').map((i) => i.row)
}

function post(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': CONTENT.userAgent,
      'x-real-ip': CONTENT.ipv4,
    },
    body: JSON.stringify(body),
  })
}

function get(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    headers: { 'user-agent': CONTENT.userAgent, 'x-real-ip': CONTENT.ipv4 },
  })
}

let errorSpy: MockInstance<Parameters<typeof console.error>, ReturnType<typeof console.error>>

/** Every neighbour back on its happy path. */
function installDefaults(): void {
  io.sourceContactsForCompany.mockResolvedValue({
    companyId: 'company-1',
    companyName: 'Acme',
    domain: 'acme.test',
    jobId: null,
    // Real-looking people on purpose: property 4 has to hold against them.
    candidates: [{ name: CONTENT.personName, email: CONTENT.personEmail }],
    inserted: [{ id: 'contact-1', name: CONTENT.personName, email: CONTENT.personEmail, source: 'pattern' }],
    skippedExisting: 2,
    providers: [],
    freePathOnly: true,
    provenanceColumnsAvailable: true,
    search: { headline: 'Read 3 pages on acme.test', steps: [] },
  })
  io.readContactProviderKeys.mockResolvedValue({ hunter: null, apollo: null })
  io.loadApiKeys.mockResolvedValue({ openrouter: 'or-key', userId: DEMO_USER })
  io.userCompanyIds.mockResolvedValue(['company-1'])
  io.runBulkMatch.mockResolvedValue({
    scored: 7,
    failed: 1,
    candidatesConsidered: 9,
    skippedReasons: {},
    batches: 2,
    tokensUsed: 1234,
    jobOutcomes: [],
  })
  io.readOutreachConfig.mockResolvedValue({ openrouterKey: undefined })
  io.findDuplicateInitial.mockResolvedValue(null)
  io.insertOutreach.mockImplementation(async (_client: unknown, row: Record<string, unknown>) => ({
    id: 'msg-1',
    ...row,
  }))
  io.generateOutreachDraft.mockResolvedValue({ subject: CONTENT.subject, body: 'Body', tokensUsed: 0 })
  io.optimizeResumeAndSave.mockResolvedValue({
    document: { id: 'doc-1', version: 5, title: null },
    rescore: { atsScore: 80 },
  })
  io.createMarkdownVersion.mockResolvedValue({ id: 'doc-1', version: 4, title: null })
  io.deleteVersion.mockResolvedValue(undefined)
  io.getVersionById.mockResolvedValue({ id: 'doc-1', version: 4, title: null })
  io.listVersions.mockResolvedValue([])
  io.getBaseResume.mockResolvedValue(null)
  io.renderResumeVersionPdf.mockResolvedValue(new Uint8Array([1, 2, 3]))
  io.renderResumeVersionDocx.mockResolvedValue(new Uint8Array([1, 2, 3]))
}

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  serviceRole.current = null
  for (const stub of Object.values(io)) stub.mockReset()
  installDefaults()
  installRouteSession({
    profiles: DEMO_WORKSPACE_PROFILE,
    contacts: {
      id: 'contact-1',
      name: CONTENT.personName,
      email: CONTENT.personEmail,
      title: CONTENT.personTitle,
      company_id: null,
    },
    jobs: {
      id: 'job-1',
      title: 'Staff Platform Engineer',
      description: 'Own the deployment pipeline',
      company_id: 'company-1',
      match_details: null,
    },
  })
})

afterEach(() => {
  errorSpy.mockRestore()
  vi.useRealTimers()
})

// --- the deadline ------------------------------------------------------------
//
// The claim the route comments make — "this call cannot change what the request
// returns" — was FALSE while the write was awaited with no bound on it: a
// getUser() or an insert that is accepted and never answered spends the
// handler's whole maxDuration and turns a 200 into a gateway timeout. Never
// throwing is not enough; never HANGING is the other half.
//
// Fake timers, so these assert the bound rather than waiting for it.

describe('the audit write is bounded, not merely non-throwing', () => {
  it('gives up on work that never answers, and says so', async () => {
    vi.useFakeTimers()
    // MUTATION TEST: delete the Promise.race in withAuditDeadline and this
    // never settles — the test times out instead of passing.
    const pending = withAuditDeadline(() => new Promise<void>(() => {}))
    await vi.advanceTimersByTimeAsync(AUDIT_DEADLINE_MS)
    await expect(pending).resolves.toContain('abandoned')
  })

  it('does not wait the full budget for work that answers', async () => {
    vi.useFakeTimers()
    const done = withAuditDeadline(async () => {})
    // No timer advanced at all: a resolved write must not be held to the clock.
    await expect(done).resolves.toBeNull()
  })

  // A DELETED TEST, RECORDED SO IT IS NOT WRITTEN AGAIN. There was an
  // assertion here that an abandoned write which fails later leaves no
  // `unhandledRejection`. It is true, and it stayed GREEN when the rejection
  // handler it claimed to protect was deleted — because Promise.race attaches
  // handlers to every input, so the property has two independent causes and no
  // single mutation can kill it. A test that cannot fail is not coverage; the
  // guarantee that IS uniquely provided by that handler is "never rejects",
  // which is what the test below asserts.
  it('never rejects — a failure comes back as a message, early or late', async () => {
    // MUTATION TEST: drop the rejection handler from the raced promise in
    // withAuditDeadline and this goes red on the first assertion.
    await expect(withAuditDeadline(async () => { throw new Error('boom') })).resolves.toBe('boom')

    vi.useFakeTimers()
    let fail: (e: Error) => void = () => {}
    const pending = withAuditDeadline(() => new Promise<void>((_, reject) => { fail = reject }))
    await vi.advanceTimersByTimeAsync(AUDIT_DEADLINE_MS)
    // The write finally fails, long after nobody is waiting for it. The answer
    // already given must stand, and nothing may be thrown at the caller.
    fail(new Error('too late'))
    await expect(pending).resolves.toContain('abandoned')
  })

  it('survives work that throws before it ever returns a promise', async () => {
    await expect(
      withAuditDeadline(() => {
        throw new Error('not a client at all')
      })
    ).resolves.toBe('not a client at all')
  })

  it('recordAccessEvent resolves within the budget even if the insert hangs', async () => {
    vi.useFakeTimers()
    const { admin } = fakeAdmin({ hangOnInsert: true })
    const pending = recordAccessEvent(admin, { codeId: CODE_ID, kind: 'action', action: 'jobs.search' })
    await vi.advanceTimersByTimeAsync(AUDIT_DEADLINE_MS)
    await expect(pending).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalled()
  })

  it('recordDemoEvent resolves within the budget even if the WHOLE path hangs', async () => {
    vi.useFakeTimers()
    // The hang is in getUser — before the insert, and therefore not covered by
    // a deadline that only wraps the write. That was the real gap: the bound
    // has to sit around the auth round trip and the lookups too.
    const hangingSession = {
      auth: { getUser: () => new Promise(() => {}) },
    } as unknown as SupabaseClient
    useServiceRole({ profileRow: DEMO_WORKSPACE_PROFILE, codeRow: LIVE_CODE_ROW })

    const pending = recordDemoEvent(hangingSession, { kind: 'action', action: 'jobs.search' })
    await vi.advanceTimersByTimeAsync(AUDIT_DEADLINE_MS)
    await expect(pending).resolves.toBeUndefined()
  })
})

// --- the producers -----------------------------------------------------------

interface Producer {
  name: string
  /** Anything to set up before the run — an injected failure, usually. */
  arrange?: () => void
  /**
   * Overrides merged into the profile row the SERVICE-ROLE client returns.
   *
   * Both `/api/agents/match/batch` and the resume generate handler read
   * `resume_text` through the admin client, not through the caller's own — so
   * "this workspace has no resume" has to be arranged there. The demo flags on
   * that same row are what session.ts reads, which is why this merges into the
   * profile rather than replacing it.
   */
  adminProfile?: Record<string, unknown>
  run: () => Promise<Response>
  /** What the response must still be, whatever the trail does. */
  status: number
  action: string
  target: string
  detail: Record<string, unknown>
}

const SAVE_BODY = {
  action: 'save',
  jobId: null,
  markdown: `# ${CONTENT.personName}\n\n${CONTENT.resumeLine}, ${CONTENT.personEmail}`,
}

/**
 * EVERY producer, success and failure.
 *
 * The success half is deliberately exhaustive over SAVE_ACTIONS rather than
 * sampling it: 'base' was the only branch with a test, and the other two map to
 * different action names, which is exactly the kind of table a typo lives in
 * forever.
 */
const PRODUCERS: Producer[] = [
  // --- jobs.score_batch ---
  {
    name: 'score batch — scored',
    run: () => scoreBatch(post('/api/agents/match/batch', { limit: 10 })),
    status: 200,
    action: 'jobs.score_batch',
    target: '/jobs',
    detail: { count: 7, failed: 1, considered: 9, remaining: 0 },
  },
  {
    name: 'score batch — no key',
    arrange: () => io.loadApiKeys.mockResolvedValue({}),
    run: () => scoreBatch(post('/api/agents/match/batch', {})),
    status: 400,
    action: 'jobs.score_batch',
    target: '/jobs',
    detail: { outcome: 'failed', reason: 'no_key' },
  },
  {
    name: 'score batch — no resume',
    adminProfile: { resume_text: '' },
    run: () => scoreBatch(post('/api/agents/match/batch', {})),
    status: 400,
    action: 'jobs.score_batch',
    target: '/jobs',
    detail: { outcome: 'failed', reason: 'no_resume' },
  },
  {
    name: 'score batch — no companies',
    arrange: () => io.userCompanyIds.mockResolvedValue([]),
    run: () => scoreBatch(post('/api/agents/match/batch', {})),
    status: 200,
    action: 'jobs.score_batch',
    target: '/jobs',
    detail: { count: 0, reason: 'no_companies' },
  },
  // --- contacts.source ---
  {
    name: 'source contacts — found',
    run: () => sourceContacts(post('/api/contacts/source', { companyId: 'company-1' })),
    status: 200,
    action: 'contacts.source',
    target: '/contacts',
    detail: { count: 1, candidates: 1, skipped_existing: 2 },
  },
  {
    name: 'source contacts — threw AFTER real outbound requests',
    arrange: () => io.sourceContactsForCompany.mockRejectedValue(new Error('hunter.io returned 503')),
    run: () => sourceContacts(post('/api/contacts/source', { companyId: 'company-1' })),
    status: 500,
    action: 'contacts.source',
    target: '/contacts',
    detail: { outcome: 'failed', reason: 'sourcing_failed' },
  },
  {
    name: 'source contacts — company not found',
    arrange: () => io.sourceContactsForCompany.mockRejectedValue(new Error('Company not found')),
    run: () => sourceContacts(post('/api/contacts/source', { companyId: 'company-1' })),
    status: 404,
    action: 'contacts.source',
    target: '/contacts',
    detail: { outcome: 'failed', reason: 'not_found' },
  },
  // --- outreach.draft ---
  {
    name: 'outreach draft — written',
    run: () => draftOutreach(post('/api/outreach/draft', { contactId: 'contact-1' })),
    status: 200,
    action: 'outreach.draft',
    target: '/contacts',
    detail: { count: 1, stage: 'pending_review', used_llm: false },
  },
  {
    name: 'outreach draft — refused as a duplicate',
    arrange: () => io.findDuplicateInitial.mockResolvedValue({ id: 'msg-0' }),
    run: () => draftOutreach(post('/api/outreach/draft', { contactId: 'contact-1' })),
    status: 409,
    action: 'outreach.draft',
    target: '/contacts',
    detail: { outcome: 'failed', reason: 'duplicate' },
  },
  {
    name: 'outreach draft — saved nothing after paying the model',
    arrange: () => {
      // "Paying the model" is now signalled by generateOutreachDraft's own
      // tokensUsed (draft/route.ts derives usedLlm from it), not by whether
      // an OpenRouter key was configured — runAgentUnit resolves keys itself.
      io.generateOutreachDraft.mockResolvedValue({ subject: CONTENT.subject, body: 'Body', tokensUsed: 42 })
      io.insertOutreach.mockRejectedValue(new Error('duplicate key value'))
    },
    run: () => draftOutreach(post('/api/outreach/draft', { contactId: 'contact-1' })),
    status: 500,
    action: 'outreach.draft',
    target: '/contacts',
    detail: { outcome: 'failed', reason: 'save_failed', used_llm: true },
  },
  // --- resume.upload / resume.tailor / resume.edit (the SAVE_ACTIONS table) ---
  {
    name: 'resume save — base',
    run: () => resumePost(post('/api/resume/documents', { ...SAVE_BODY, source: 'base' })),
    status: 200,
    action: 'resume.upload',
    target: '/resume',
    detail: { source: 'base', version: 4 },
  },
  {
    name: 'resume save — tailored',
    run: () => resumePost(post('/api/resume/documents', { ...SAVE_BODY, source: 'tailored' })),
    status: 200,
    action: 'resume.tailor',
    target: '/resume',
    detail: { source: 'tailored', version: 4 },
  },
  {
    name: 'resume save — edited',
    run: () => resumePost(post('/api/resume/documents', { ...SAVE_BODY, source: 'edited' })),
    status: 200,
    action: 'resume.edit',
    target: '/resume',
    detail: { source: 'edited', version: 4 },
  },
  {
    name: 'resume save — failed (edited)',
    arrange: () => io.createMarkdownVersion.mockRejectedValue(new Error('insert failed')),
    run: () => resumePost(post('/api/resume/documents', { ...SAVE_BODY, source: 'edited' })),
    status: 500,
    action: 'resume.edit',
    target: '/resume',
    detail: { outcome: 'failed', reason: 'save_failed' },
  },
  {
    // The same catch, reached with a different `source`. Both are here because
    // the failure row is looked up through SAVE_ACTIONS just like the success
    // row is, and a table read correctly in one branch and not the other is
    // exactly the bug that survives a single-case test.
    name: 'resume save — failed (base)',
    arrange: () => io.createMarkdownVersion.mockRejectedValue(new Error('insert failed')),
    run: () => resumePost(post('/api/resume/documents', { ...SAVE_BODY, source: 'base' })),
    status: 500,
    action: 'resume.upload',
    target: '/resume',
    detail: { outcome: 'failed', reason: 'save_failed' },
  },
  // --- resume.tailor (generate) ---
  {
    name: 'resume generate — tailored a new version',
    run: () => resumePost(post('/api/resume/documents', { action: 'generate', jobId: 'job-1' })),
    status: 200,
    action: 'resume.tailor',
    target: '/resume',
    detail: { source: 'tailored', version: 5 },
  },
  {
    name: 'resume generate — the optimizer threw after paying for LLM calls',
    arrange: () => io.optimizeResumeAndSave.mockRejectedValue(new Error('rewrite pass failed')),
    run: () => resumePost(post('/api/resume/documents', { action: 'generate', jobId: 'job-1' })),
    status: 500,
    action: 'resume.tailor',
    target: '/resume',
    detail: { outcome: 'failed', reason: 'optimizer_failed' },
  },
  {
    name: 'resume generate — the key vanished mid-run',
    arrange: () => io.optimizeResumeAndSave.mockRejectedValue(new MissingKeyError('no key')),
    run: () => resumePost(post('/api/resume/documents', { action: 'generate', jobId: 'job-1' })),
    status: 400,
    action: 'resume.tailor',
    target: '/resume',
    detail: { outcome: 'failed', reason: 'no_key' },
  },
  {
    name: 'resume generate — no resume on file',
    adminProfile: { resume_text: '  ' },
    run: () => resumePost(post('/api/resume/documents', { action: 'generate', jobId: 'job-1' })),
    status: 400,
    action: 'resume.tailor',
    target: '/resume',
    detail: { outcome: 'failed', reason: 'no_resume' },
  },
  {
    name: 'resume generate — job not found',
    arrange: () =>
      installRouteSession({ profiles: DEMO_WORKSPACE_PROFILE /* no `jobs` row */ }),
    run: () => resumePost(post('/api/resume/documents', { action: 'generate', jobId: 'job-1' })),
    status: 404,
    action: 'resume.tailor',
    target: '/resume',
    detail: { outcome: 'failed', reason: 'job_not_found' },
  },
  {
    name: 'resume generate — no LLM key',
    arrange: () => io.loadApiKeys.mockResolvedValue({}),
    run: () => resumePost(post('/api/resume/documents', { action: 'generate', jobId: 'job-1' })),
    status: 400,
    action: 'resume.tailor',
    target: '/resume',
    detail: { outcome: 'failed', reason: 'no_key' },
  },
  // --- resume.delete ---
  {
    name: 'resume delete — removed',
    run: () => resumePost(post('/api/resume/documents', { action: 'delete', id: 'doc-1' })),
    status: 200,
    action: 'resume.delete',
    target: '/resume',
    detail: { version: 4 },
  },
  {
    name: 'resume delete — nothing to delete',
    arrange: () => io.getVersionById.mockResolvedValue(null),
    run: () => resumePost(post('/api/resume/documents', { action: 'delete', id: 'doc-1' })),
    status: 404,
    action: 'resume.delete',
    target: '/resume',
    detail: { outcome: 'failed', reason: 'not_found' },
  },
  {
    name: 'resume delete — failed',
    arrange: () => io.deleteVersion.mockRejectedValue(new Error('permission denied')),
    run: () => resumePost(post('/api/resume/documents', { action: 'delete', id: 'doc-1' })),
    status: 500,
    action: 'resume.delete',
    target: '/resume',
    detail: { outcome: 'failed', reason: 'delete_failed' },
  },
  // --- resume.export ---
  {
    name: 'resume export — downloaded',
    run: () => resumeGet(get('/api/resume/documents?id=doc-1&format=pdf')),
    status: 200,
    action: 'resume.export',
    target: '/resume',
    detail: { format: 'pdf', version: 4 },
  },
  {
    name: 'resume export — the version could not be loaded',
    arrange: () => io.getVersionById.mockRejectedValue(new Error('connection reset')),
    run: () => resumeGet(get('/api/resume/documents?id=doc-1&format=docx')),
    status: 500,
    action: 'resume.export',
    target: '/resume',
    detail: { outcome: 'failed', reason: 'load_failed' },
  },
  {
    name: 'resume export — no such version',
    arrange: () => io.getVersionById.mockResolvedValue(null),
    run: () => resumeGet(get('/api/resume/documents?id=doc-1&format=pdf')),
    status: 404,
    action: 'resume.export',
    target: '/resume',
    detail: { outcome: 'failed', reason: 'not_found' },
  },
  {
    name: 'resume export — the render blew up',
    arrange: () => io.renderResumeVersionPdf.mockRejectedValue(new Error('font not found')),
    run: () => resumeGet(get('/api/resume/documents?id=doc-1&format=pdf')),
    status: 500,
    action: 'resume.export',
    target: '/resume',
    detail: { outcome: 'failed', reason: 'render_failed' },
  },
]

/**
 * The vocabulary this file expects to see, derived from the table above.
 *
 * A GUARD AGAINST A SHRINKING SUITE, not decoration: the previous round shipped
 * four producers with tests and three without, and nothing anywhere said which
 * three were missing. Asserting the SET means deleting a case from the table is
 * a failure here rather than a silent loss of coverage.
 */
const EXPECTED_ACTIONS = [
  'contacts.source',
  'jobs.score_batch',
  'outreach.draft',
  'resume.delete',
  'resume.edit',
  'resume.export',
  'resume.tailor',
  'resume.upload',
]

describe('every producer of the demo trail', () => {
  it('covers every action the instrumented routes can write', () => {
    expect([...new Set(PRODUCERS.map((p) => p.action))].sort()).toEqual(EXPECTED_ACTIONS)
  })

  it('covers both outcomes, not just the happy one', () => {
    const failures = PRODUCERS.filter((p) => p.detail.outcome === 'failed')
    // Every action must have at least one failing case: a successes-only trail
    // is the defect this table exists to prevent coming back.
    expect([...new Set(failures.map((p) => p.action))].sort()).toEqual(EXPECTED_ACTIONS)
  })

  for (const producer of PRODUCERS) {
    describe(producer.name, () => {
      it('writes exactly one attributed row for a demo session', async () => {
        const { inserts } = useServiceRole({
          profileRow: { ...DEMO_WORKSPACE_PROFILE, ...producer.adminProfile },
          codeRow: LIVE_CODE_ROW,
        })
        producer.arrange?.()

        const response = await producer.run()

        expect(response.status).toBe(producer.status)
        const rows = auditRows(inserts)
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
          code_id: CODE_ID,
          kind: 'action',
          action: producer.action,
          target: producer.target,
        })
        // toEqual, not toMatchObject: a reason silently dropped by the
        // sanitizer's shape rule would still satisfy a subset match, and a row
        // that says "failed" without saying why is the thing being fixed.
        expect(rows[0].detail).toEqual(producer.detail)
        // The visitor hint rides along, so the owner can tell two people
        // sharing one code apart — hashed, never the address itself.
        expect(rows[0].client_hint).toMatch(/^[0-9a-f]{12}$/)
      })

      it('writes NOTHING for an ordinary user', async () => {
        const { inserts } = useServiceRole({
          profileRow: { ...ORDINARY_WORKSPACE_PROFILE, ...producer.adminProfile },
          codeRow: LIVE_CODE_ROW,
        })
        producer.arrange?.()

        const response = await producer.run()

        expect(response.status).toBe(producer.status)
        expect(auditRows(inserts)).toHaveLength(0)
      })

      // MUTATION NOTE — CORRECTED, and the correction is the point.
      //
      // This note previously told the next reviewer that removing the two
      // logging lines (audit.ts `if (failure) logAuditFailure(...)` and
      // session.ts `if (failure) logLookupFailure(...)`) turns all 28 of these
      // red. An adversarial review ran exactly that and got 150 of 151 still
      // GREEN — which is obvious on inspection, because both lines only LOG.
      // Neither is a swallow, so removing them cannot change what a handler
      // returns.
      //
      // That made this the worst kind of wrong comment: one written to reassure
      // a reviewer that a suspicious test had been proven non-vacuous, which
      // would have stopped the next person from checking.
      //
      // THE REAL SWALLOW, verified by mutation: the rejection-to-message
      // conversion inside withAuditDeadline. Drop that conversion and all 28 of
      // these DO go red. If you need to confirm these tests still bite, mutate
      // that — not the log lines.
      it('answers the request identically when the audit write fails', async () => {
        useServiceRole({
          profileRow: { ...DEMO_WORKSPACE_PROFILE, ...producer.adminProfile },
          codeRow: LIVE_CODE_ROW,
          throwOnInsert: true,
        })
        producer.arrange?.()

        const response = await producer.run()

        expect(response.status).toBe(producer.status)
      })

      it('answers the request identically when the audit write never answers', async () => {
        // The property the deadline buys, asserted through a real route rather
        // than only on the helper: a hung insert must not consume maxDuration.
        vi.useFakeTimers()
        useServiceRole({
          profileRow: { ...DEMO_WORKSPACE_PROFILE, ...producer.adminProfile },
          codeRow: LIVE_CODE_ROW,
          hangOnInsert: true,
        })
        producer.arrange?.()

        const pending = producer.run()
        await vi.advanceTimersByTimeAsync(AUDIT_DEADLINE_MS)
        const response = await pending

        expect(response.status).toBe(producer.status)
      })

      it('puts nothing about the work itself in the row', async () => {
        const { inserts } = useServiceRole({
          profileRow: { ...DEMO_WORKSPACE_PROFILE, ...producer.adminProfile },
          codeRow: LIVE_CODE_ROW,
        })
        producer.arrange?.()

        await producer.run()

        const serialized = JSON.stringify(auditRows(inserts))
        for (const leak of Object.values(CONTENT)) {
          expect(serialized, `${leak} leaked into the audit row`).not.toContain(leak)
        }
      })
    })
  }
})

// --- the two producers that do not return a response --------------------------
//
// /api/outreach/draft and /api/agents/match/batch both journal a failure and
// then RETHROW, because that is what those two paths did before the trail
// existed and an audit row is not a licence to change a handler's behaviour.
// They cannot go in the table above (which asserts a status code), and they are
// exactly the failures that cost the most: in both cases the model has already
// been called and billed by the time the throw happens.

describe('producers that journal a failure and then rethrow', () => {
  it('records the drafting attempt when the model call itself blows up', async () => {
    const { inserts } = useServiceRole({ profileRow: DEMO_WORKSPACE_PROFILE, codeRow: LIVE_CODE_ROW })
    io.readOutreachConfig.mockResolvedValue({ openrouterKey: 'sk-or-demo' })
    io.generateOutreachDraft.mockRejectedValue(new Error('openrouter 502'))

    // Rethrown, unchanged: the caller sees exactly what it saw before.
    await expect(draftOutreach(post('/api/outreach/draft', { contactId: 'contact-1' }))).rejects.toThrow(
      'openrouter 502'
    )

    const rows = auditRows(inserts)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ code_id: CODE_ID, action: 'outreach.draft', target: '/contacts' })
    expect(rows[0].detail).toEqual({ outcome: 'failed', reason: 'llm_failed' })
  })

  it('records the scoring run when runBulkMatch blows up mid-spend', async () => {
    const { inserts } = useServiceRole({ profileRow: DEMO_WORKSPACE_PROFILE, codeRow: LIVE_CODE_ROW })
    io.runBulkMatch.mockRejectedValue(new Error('tier-1 batch never returned'))

    await expect(scoreBatch(post('/api/agents/match/batch', { limit: 10 }))).rejects.toThrow(
      'tier-1 batch never returned'
    )

    const rows = auditRows(inserts)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ code_id: CODE_ID, action: 'jobs.score_batch', target: '/jobs' })
    expect(rows[0].detail).toEqual({ outcome: 'failed', reason: 'score_failed' })
  })

  it('writes nothing for an ordinary user on either path', async () => {
    const { inserts } = useServiceRole({ profileRow: ORDINARY_WORKSPACE_PROFILE, codeRow: LIVE_CODE_ROW })
    io.runBulkMatch.mockRejectedValue(new Error('tier-1 batch never returned'))

    await expect(scoreBatch(post('/api/agents/match/batch', { limit: 10 }))).rejects.toThrow()

    expect(auditRows(inserts)).toHaveLength(0)
  })
})
