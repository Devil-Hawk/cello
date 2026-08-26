// POST /api/jobs/refresh — refresh jobs from public ATS APIs (Greenhouse,
// Lever, Ashby) for one company ({ companyId }) or all of the caller's
// companies (empty body).
//
// Frozen contract (fields keep their name and type across the graph port —
// only `threadId` is additive):
//   request:  { companyId?: string, threadId?: string }
//   200:      { ok, threadId, results: [{ companyId, companyName, provider,
//               found, inserted, errors[] }], totals: { found, inserted,
//               companiesWithAts }, cursor: number | null, total: number,
//               done: boolean }
// provider:null means no ATS board was detected (UI may fall back to
// POST /api/scraper/trigger). Per-company failures land in errors[] — one
// failing company never fails the run.
//
// WHY THIS ROUTE IS A THREAD HANDOFF, NOT A CLIENT-DRIVEN CURSOR LOOP
//   It used to refresh EVERY company of the caller's in a single request. At
//   436 companies — each needing provider detection (several probes, each
//   with its own timeout and retry) before a single job is read — the work
//   is minutes long, against a 60s maxDuration. It could not finish: on
//   Vercel the function was killed and returned 504; locally the request
//   simply never came back. Measured: no response after 120s.
//
//   The pre-port fix was a raw integer `cursor` the client sent back each
//   round, paired with app/api/jobs/refresh/bounded-run.ts's own proof that
//   the work done was always a contiguous prefix of the input (otherwise a
//   cursor would silently skip companies). The graph port replaces that with
//   lib/graph/refresh.ts#refreshJobsGraph: a LangGraph thread durably records
//   which companies are done (task memoization, not a client-supplied
//   integer), so a killed-mid-request invocation and a cleanly time-budgeted
//   one resume identically — see lib/graph/invoke.ts's THE RESUME RULE.
//
//   No threadId -> mint one and run the first round. With threadId -> resume
//   the SAME thread (invoke(null), never fresh input — see THE RESUME RULE).
//   A round that hits refreshJobsGraph's own soft time budget interrupts
//   with {processed, total}; this route reports that as `cursor`/`done:false`
//   with empty results/totals (the graph never reached its own return, so
//   there is nothing to report yet — see HONEST STATUS below). `done:true`
//   carries the run's real, complete results/totals.
//
// RULING 9 — this route's own RLS-scoped `supabase` client (not an admin
// client) is what actually reads/writes companies and jobs, exactly as
// before the port: it rides invokeGraphForUser's `extraConfigurable`, so
// company/job access stays governed by Postgres RLS under the caller's own
// session on every round, resumed or fresh. `admin` (service-role) is used
// ONLY for invokeGraphForUser's own thread bookkeeping (graph_threads) —
// see lib/graph/invoke.ts's header on why that table needs it regardless of
// which surface is calling.
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import {
  DemoThreadExpiredError,
  invokeGraphForUser,
  ThreadOwnershipError,
  type CompiledGraphLike,
} from '@/lib/graph/invoke'
import {
  getRefreshDeadlineInterrupt,
  refreshJobsGraph,
  type RefreshCompanyOptions,
  type RefreshJobsInput,
  type RefreshJobsOutcome,
} from '@/lib/graph/refresh'
import { logApiError } from '@/lib/observability/log'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// refreshJobsGraph (a real compiled LangGraph Pregel graph) has a NARROWER
// `invoke` input type than CompiledGraphLike's own `unknown` — the same
// structural gap app/api/harness/run/route.ts already casts around for its
// own compiled graph.
const REFRESH_GRAPH = refreshJobsGraph as unknown as CompiledGraphLike

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let companyId: string | undefined
  let threadId: string | undefined
  try {
    const body = await request.json()
    if (body && typeof body === 'object' && typeof body.companyId === 'string' && body.companyId) {
      companyId = body.companyId
    }
    if (body && typeof body === 'object' && typeof body.threadId === 'string' && body.threadId) {
      threadId = body.threadId
    }
  } catch {
    // Empty/absent body → refresh all companies from the start.
  }

  const admin = createAdminClient()

  try {
    let input: RefreshJobsInput | undefined
    let total: number | undefined

    if (!threadId) {
      // select('*') (not an explicit column list) so this works whether or
      // not the additive companies.metadata migration has been applied yet.
      let query = supabase.from('companies').select('*').eq('user_id', user.id)
      if (companyId) {
        query = query.eq('id', companyId)
      }
      const { data: companies, error: companiesError } = await query

      if (companiesError) {
        return NextResponse.json({ error: companiesError.message }, { status: 500 })
      }
      if (companyId && (!companies || companies.length === 0)) {
        return NextResponse.json({ error: 'Company not found' }, { status: 404 })
      }

      const companyIds = (companies ?? []).map((c) => c.id)
      const perCompanyOptions: Record<string, RefreshCompanyOptions> = {}
      for (const c of companies ?? []) {
        perCompanyOptions[c.id] = {
          name: c.name,
          domain: c.domain,
          career_url: c.career_url,
          metadata: (c as { metadata?: unknown }).metadata,
        }
      }
      input = { companyIds, perCompanyOptions }
      total = companyIds.length
    }

    const { threadId: tid, result } = await invokeGraphForUser({
      admin,
      userId: user.id,
      surface: 'refresh',
      graph: REFRESH_GRAPH,
      threadId,
      input,
      extraConfigurable: { dbClient: supabase },
    })

    const interrupted = getRefreshDeadlineInterrupt(result)
    if (interrupted) {
      // HONEST STATUS: refreshJobsGraph interrupted before reaching its own
      // `return` — there is no RefreshJobsOutcome to report yet, only the
      // {processed, total} the interrupt payload itself carries. Reporting
      // invented per-round results/totals here would be worse than reporting
      // none; `done:true` on a later round carries the real, complete ones.
      return NextResponse.json({
        ok: true,
        threadId: tid,
        results: [],
        totals: { found: 0, inserted: 0, companiesWithAts: 0 },
        cursor: interrupted.processed,
        total: interrupted.total,
        done: false,
      })
    }

    const outcome = result as RefreshJobsOutcome
    return NextResponse.json({
      ok: true,
      threadId: tid,
      results: outcome.results,
      totals: outcome.totals,
      cursor: null,
      total: total ?? outcome.total,
      done: true,
    })
  } catch (e) {
    // Anti-IDOR (see lib/graph/invoke.ts#loadOwnedThread): a threadId that
    // does not exist and one that belongs to someone else fail the SAME way.
    if (e instanceof ThreadOwnershipError) {
      return NextResponse.json({ error: 'Thread not found' }, { status: 404 })
    }
    if (e instanceof DemoThreadExpiredError) {
      return NextResponse.json({ error: 'This refresh session has expired' }, { status: 410 })
    }
    const message = e instanceof Error ? e.message : String(e)
    logApiError('jobs/refresh', e, { companyId, threadId })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
