// POST /api/contacts/source — source PLAUSIBLE contacts for a tracked company
// (optionally scoped to one job posting) and persist them to public.contacts
// with full provenance (source/confidence/verified/basis on every candidate).
//
// FREE PATH WORKS WITH NO KEYS: the company's own public pages (SSRF
// host-allowlisted to that company's domain), the job-posting text, the stored
// company dossier, and this user's own already-known contacts at that domain
// (used only to learn an email-address pattern, never fabricated from
// nothing). Hunter.io / Apollo.io are pure opt-in BYOK enhancements read from
// profiles.preferences.api_keys — with no key configured they are silently
// skipped, never an error. See lib/contacts/sources.ts for the full design.
//
// THE RESPONSE ALWAYS EXPLAINS ITSELF. `search` (a SearchReport) names every
// source consulted, how much of it was actually read, and why it came up
// empty — `search.headline` is a full sentence a UI can render verbatim. The
// panel used to say "No new contacts found — nothing usable in the job posting
// or company research yet", which was indistinguishable from a broken button
// and, as it turned out, was hiding the fact that almost nothing was being
// searched. Clients should render `search.headline` (and optionally
// `search.steps`) instead of any hard-coded empty-state string.
//
// GET on the same path answers a different question: "which of these people
// are worth this user's time on THIS role?" It returns the RoleContext that
// lib/contacts/relevance.ts needs (job function, job title, and the company's
// open-role count as a size proxy) so the client can rank contacts it already
// has on file — including ones sourced on an earlier run — without re-running
// the whole sourcing pipeline. POST returns the same object alongside its
// results, so a client that just sourced never needs a second round trip.
//
// SAFETY: this route only ever creates/reads `contacts` rows. It NEVER sends
// an email and exposes no send path — turning a sourced contact into an
// actual outreach message stays a separate, human-gated flow (see
// app/api/outreach/*, owned by another workstream; sending itself requires an
// explicit approve step there).

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { sourceContactsForCompany } from '@/lib/contacts/sources'
import { readContactProviderKeys } from '@/lib/contacts/keys'
import { JOB_FUNCTIONS, type JobFunction } from '@/lib/jobs/classify'
import type { RoleContext } from '@/lib/contacts/relevance'
import { recordDemoEvent } from '@/lib/access/session'
import { resolveCompanyId } from '@/lib/entities/companies'

export const dynamic = 'force-dynamic'
// The free path now makes real outbound requests (the company's own public
// pages, six in parallel at a 6s timeout each) on top of the DB reads and any
// BYOK provider calls. 30s still comfortably covers the worst case; it is
// stated here so the budget is a decision rather than a default.
export const maxDuration = 30

const BodySchema = z.object({
  companyId: z.string().min(1),
  jobId: z.string().min(1).optional(),
  limit: z.number().int().positive().max(25).optional(),
})

// --- Role context (the ranking's inputs) ----------------------------------

export interface RoleContextPayload {
  role: RoleContext
  /**
   * Where `role.openRoleCount` came from, in words — shown to the user so the
   * size proxy that decides whether a founder ranks first or last is never an
   * unexplained number. Never blank, including when the count is unknown.
   */
  roleBasis: string
}

/** Same probe app/api/jobs/provenance/route.ts uses: an unapplied additive migration. */
function isMissingColumnError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  return error.code === '42703' || /column .* does not exist/i.test(error.message ?? '')
}

/**
 * `jobs.still_open` is NULL for every row discovered before a reverification
 * pass ran, and 20260728000008_job_provenance.sql is explicit that NULL means
 * "never checked", NOT "closed" — so only an explicit `false` is excluded.
 */
const OPEN_ROLE_FILTER = 'still_open.is.null,still_open.eq.true'

/**
 * How many roles this company has open, as far as this database knows.
 *
 * `head: true` with an exact count: Postgres does the counting and not one row
 * crosses the wire. This runs on every panel mount, so cheap is the whole
 * point — the alternative (fetching rows to call `.length`) would move
 * thousands of job descriptions to count them.
 */
async function countOpenRoles(
  jobs: SupabaseClient,
  companyId: string
): Promise<{ count: number | null; basis: string }> {
  // A duplicate id gets chased to its survivor first (lib/entities/companies.ts)
  // — otherwise a company that has since been merged away would always count
  // as zero postings, mislabeling a real company as "size unknown".
  const resolvedCompanyId = await resolveCompanyId(jobs, companyId)
  const build = (filtered: boolean) => {
    const query = jobs.from('jobs').select('id', { count: 'exact', head: true }).eq('company_id', resolvedCompanyId)
    return filtered ? query.or(OPEN_ROLE_FILTER) : query
  }

  let { count, error } = await build(true)
  if (error && isMissingColumnError(error)) {
    // still_open isn't there yet. Every row then reads as "never checked",
    // which is what the filter would have kept anyway — so an unfiltered
    // count is the same number, not a degraded one.
    ;({ count, error } = await build(false))
  }

  if (error || count === null) {
    return { count: null, basis: "couldn't count this company's postings, so its size is unknown" }
  }
  if (count === 0) {
    // 0 is not "a company with no jobs" — it is "we have no postings on file",
    // which is an absence of evidence about size. Reporting it as a real count
    // of zero would state a fact we do not have.
    return { count: null, basis: 'no postings from this company on file, so its size is unknown' }
  }
  return {
    count,
    basis: `${count} posting${count === 1 ? '' : 's'} from this company on file — the size proxy for ranking`,
  }
}

/** The specific posting being pursued, when the caller named one. */
async function readPosting(
  jobs: SupabaseClient,
  companyId: string,
  jobId: string
): Promise<{ title: string | null; jobFunction: JobFunction | null } | null> {
  const build = (columns: string) =>
    jobs.from('jobs').select(columns).eq('id', jobId).eq('company_id', companyId).maybeSingle()

  let { data, error } = await build('title, job_function')
  if (error && isMissingColumnError(error)) {
    // 20260724000001_job_classification.sql not applied — a title-only match
    // still ranks usefully via relevance.ts's token overlap.
    ;({ data, error } = await build('title'))
  }
  if (error || !data) return null

  const row = data as { title?: string | null; job_function?: string | null }
  const fn = row.job_function ?? null
  return {
    title: row.title?.trim() || null,
    // Anything outside the classifier's taxonomy is treated as unclassified
    // rather than passed through — relevance.ts indexes its keyword table by
    // JobFunction and an unknown key would silently match nothing.
    jobFunction: fn && (JOB_FUNCTIONS as readonly string[]).includes(fn) ? (fn as JobFunction) : null,
  }
}

async function readRoleContext(
  supabase: Awaited<ReturnType<typeof createClient>>,
  companyId: string,
  jobId: string | null
): Promise<RoleContextPayload> {
  // jobs.job_function/still_open aren't in @cello/shared's generated Database
  // type (additive columns the codegen hasn't picked up), so they're read
  // through an untyped view of the SAME cookie-scoped, RLS-enforcing client —
  // the pattern app/(app)/jobs/page.tsx already uses. RLS ("Users can view
  // jobs for own companies") is what scopes these reads, not the type.
  const jobs = supabase as unknown as SupabaseClient

  try {
    const [openRoles, posting] = await Promise.all([
      countOpenRoles(jobs, companyId),
      jobId ? readPosting(jobs, companyId, jobId) : Promise.resolve(null),
    ])

    return {
      role: {
        jobFunction: posting?.jobFunction ?? null,
        jobTitle: posting?.title ?? null,
        openRoleCount: openRoles.count,
      },
      roleBasis: openRoles.basis,
    }
  } catch {
    // Never throw: on POST this runs AFTER contacts were already inserted, so
    // a failed size lookup must not turn a successful sourcing run into a 500
    // the client reads as "nothing happened". Unknown size is a supported
    // state everywhere downstream — relevance.ts says so in every reason.
    return {
      role: { jobFunction: null, jobTitle: null, openRoleCount: null },
      roleBasis: "couldn't read this company's size, so ranking assumes a small one",
    }
  }
}

/**
 * One trail row for a sourcing attempt — success or failure.
 *
 * WHAT AWAITING THIS COSTS, STATED HONESTLY: recordDemoEvent writes nothing for
 * an ordinary user, but it is NOT a no-op for one — it pays an auth round trip
 * and a service-role profile read before it can know that. It never throws AND
 * never takes longer than AUDIT_DEADLINE_MS (lib/access/audit.ts), which
 * together are what make it safe to await on a response path: without the
 * deadline an unanswered insert would spend this route's whole 30s maxDuration
 * and turn a completed sourcing run into a gateway timeout. It is awaited
 * rather than backgrounded because a Next 14 handler has no after()/waitUntil,
 * so a floating promise is an event lost when the process is torn down.
 */
/**
 * Record the outcome on the demo trail. STRUCTURALLY INCAPABLE OF FAILING THE
 * REQUEST IT DESCRIBES.
 *
 * WHY THE try/catch IS HERE AND NOT SOMEWHERE TIDIER
 *   recordDemoEvent is careful, but "it does not throw today" is a property of
 *   another module, and the success write on this route USED TO SIT INSIDE the
 *   try that wraps sourcing. A throw from it therefore landed in the catch
 *   below, which records {outcome:'failed'} and returns 500 — so a run that had
 *   genuinely inserted contacts, after real outbound HTTP on the owner's
 *   account and possibly a paid Hunter/Apollo call, would be journalled as a
 *   FAILURE and reported to the user as one. An adversarial review reproduced
 *   exactly that by making recordDemoEvent throw.
 *
 *   Moving the call out of the try was not enough on its own: a rejected
 *   promise from a trail write still rejects the handler. The only way the
 *   comments on this route can honestly claim the trail cannot change what the
 *   request returns is for the call to be unable to propagate at all. Hence
 *   this catch, which is the whole guarantee.
 *
 *   The audit write is still AWAITED (recordDemoEvent carries its own deadline)
 *   so ordering stays deterministic for tests; what is swallowed is only the
 *   failure, and it is logged rather than lost.
 */
async function recordSourcingOutcome(
  supabase: Awaited<ReturnType<typeof createClient>>,
  detail: Record<string, unknown>,
  headers: Headers
): Promise<void> {
  try {
    await recordDemoEvent(supabase, {
      kind: 'action',
      action: 'contacts.source',
      target: '/contacts',
      detail,
      headers,
    })
  } catch (err) {
    // A missing trail row is a worse audit, not a worse outcome for the user.
    console.error(
      '[contacts/source] demo trail write failed; the request is unaffected:',
      err instanceof Error ? err.message : String(err)
    )
  }
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const companyId = searchParams.get('companyId')
  const jobId = searchParams.get('jobId')
  if (!companyId) return NextResponse.json({ error: 'companyId is required' }, { status: 400 })

  // Ownership is checked explicitly rather than inferred from an empty count:
  // a company this user cannot see would otherwise come back as "no postings
  // on file", which reads as a fact about the company instead of a 404.
  const { count: ownedCompany } = await supabase
    .from('companies')
    .select('id', { count: 'exact', head: true })
    .eq('id', companyId)
    .eq('user_id', user.id)
  if (!ownedCompany) {
    return NextResponse.json({ error: 'Company not found (or not owned by this user)' }, { status: 404 })
  }

  const payload = await readRoleContext(supabase, companyId, jobId)
  return NextResponse.json({ ok: true, ...payload })
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: z.infer<typeof BodySchema>
  try {
    body = BodySchema.parse(await request.json())
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Invalid JSON body' }, { status: 400 })
  }

  const admin = createAdminClient()
  const providerKeys = await readContactProviderKeys(admin, user.id)

  try {
    const result = await sourceContactsForCompany({
      client: admin,
      userId: user.id,
      companyId: body.companyId,
      jobId: body.jobId ?? null,
      hunterKey: providerKeys.hunter,
      apolloKey: providerKeys.apollo,
      limit: body.limit,
    })
    // Sourcing and ranking answer different questions ("who exists here?" vs
    // "who is worth writing to?"), but a caller that just sourced needs both
    // at once — so the role context rides along instead of costing a second
    // request. Read after sourcing, on the same RLS-scoped client.
    const roleContext = await readRoleContext(supabase, body.companyId, body.jobId ?? null)

    // THE DEMO TRAIL — "we should be able to see what someone did with a
    // particular access code". See recordSourcingOutcome above for what this
    // costs and why both outcomes are recorded.
    //
    // COUNTS ONLY. Not a name, not an email address, not a company: the people
    // this route just found are the one thing on this page that must never
    // reach a table the owner exports. `detail.count` renders as "Found 3
    // contacts" (app/api/access-codes/contract.ts).
    await recordSourcingOutcome(
      supabase,
      {
        count: result.inserted.length,
        candidates: result.candidates.length,
        skipped_existing: result.skippedExisting,
      },
      request.headers
    )

    return NextResponse.json({ ok: true, ...result, ...roleContext })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Contact sourcing failed'
    const status = /not found/i.test(message) ? 404 : 500
    // THE FAILURE THIS FEATURE EXISTS TO MAKE VISIBLE. sourceContactsForCompany
    // fetches the company's own pages and, with a BYOK key, Hunter/Apollo —
    // real outbound requests, on the owner's account, made before anything
    // here could throw. Recording successes only left the owner unable to tell
    // a visitor who did nothing from one who drove fifty failing runs through
    // this exact path, which is precisely the question the access-code trail
    // was built to answer. The reason is an ENUM chosen here, never `message`:
    // a message is prose that can quote a company name or a URL back at us.
    await recordSourcingOutcome(
      supabase,
      { outcome: 'failed', reason: status === 404 ? 'not_found' : 'sourcing_failed' },
      request.headers
    )
    return NextResponse.json({ error: message }, { status })
  }
}
