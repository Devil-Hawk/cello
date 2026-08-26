// POST /api/agents/match/batch  { limit?: number, model?: string, effort?: string }
//
// BULK scoring: drains the unscored-jobs backlog using bulk_matcher's
// two-tier design (lib/harness/agents/bulk_matcher.ts) instead of one LLM
// call per job — see that file's header for the tier-1/tier-2 rationale. One
// call here triages up to `limit` (default 200, hard cap 500) of the user's
// unscored jobs and is safe to call again immediately: it always selects the
// next unscored page (match_score is null), so a client can poll this in a
// loop until `remainingInTargeting` hits 0.
//
// Reuses the SAME candidate selection as the harness cron digest, autopilot,
// and the on-demand single-job route (matcher.ts's selectCandidateJobs /
// userCompanyIds / toScorable) so ownership + quality + targeting filtering,
// and the persisted match_details shape, are consistent regardless of which
// path scored a given job.
//
// REMAINING-COUNT FIX: `remaining` (kept in the response for back-compat with
// existing callers — see dashboard/page.tsx) and the new `remainingInTargeting`
// are now the SAME number: match_score-null rows that ALSO pass the quality +
// targeting predicate the scorer itself applies (countRemainingInTargeting
// below). Before this fix `remaining` counted every match_score-null row with
// NO targeting/quality filter at all, while the scorer can only ever select
// rows that pass targeting — so on an account where targeting/quality reject
// almost everything (observed: 11,370 unscored, 189 actually in-targeting)
// the counter reported ~11,275 while the true reachable backlog was 189.
// Every click past that point returned `scored: 0` while the toast still said
// "N left to score", and `allScored`/"All jobs scored" (jobs/page.tsx) was
// permanently unreachable. The match_score-null rows that targeting/quality
// exclude are now reported separately as `excludedByTargeting` — they are not
// "left to score", they will never be scored under the account's current
// filters.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { loadApiKeys } from '@/lib/harness/keys'
import { canRunLlm, missingOpenRouterMessage } from '@/lib/harness/llm-key-message'
import type { AdminClient } from '@/lib/harness/types'
import { userCompanyIds, ownedJobsQuery } from '@/lib/harness/agents/matcher'
import { runUnitOnce } from '@/lib/graph/oneshot'
import { resolveTargetTitles } from '@/lib/targeting/titles'
import { resolveTargeting, type Targeting } from '@/lib/targeting'
import { REASONING_EFFORTS, type ReasoningEffort } from '@/lib/harness/types'
import { BulkMatcherOutput } from '@/lib/harness/schemas'
import type { z } from 'zod'
import { isAllowedModel } from '@/lib/models'
import { QUALITY_REJECT_THRESHOLD } from '@/lib/jobs/classify'
import { recordDemoEvent } from '@/lib/access/session'

/** Unit output, typed off the same zod schema runAgentUnit validated it
 *  against (agentSchemas.bulk_matcher.output) — see lib/harness/schemas.ts. */
type BulkMatcherResult = z.infer<typeof BulkMatcherOutput>

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const DEFAULT_LIMIT = 200
const HARD_CAP = 500

/**
 * One trail row for a bulk-scoring attempt — what it scored, or why it scored
 * nothing.
 *
 * "We should be able to see what someone did with a particular access code",
 * and bulk scoring is the single most expensive thing a demo visitor can do, so
 * it is exactly what the owner needs to see. Counts and enums only:
 * `detail.count` is what the timeline renders as "Scored 40 jobs"
 * (app/api/access-codes/contract.ts).
 *
 * WHAT AWAITING THIS COSTS, STATED HONESTLY. recordDemoEvent writes nothing for
 * an ordinary user, but it is NOT a no-op for one — it pays an auth round trip
 * and a service-role profile read before it can know that. It never throws AND
 * never takes longer than AUDIT_DEADLINE_MS (lib/access/audit.ts): the second
 * of those is what makes awaiting it safe here, because without a deadline an
 * unanswered insert would spend whatever is left of this route's 300s
 * maxDuration and turn a run that had already scored the jobs into a gateway
 * timeout. It is awaited rather than backgrounded because a Next 14 handler has
 * no after()/waitUntil, so a floating promise is an event lost whenever the
 * process is torn down after the response — the same reason the redemption
 * route awaits its write.
 */
async function recordScoringOutcome(
  supabase: Awaited<ReturnType<typeof createClient>>,
  detail: Record<string, unknown>,
  headers: Headers
): Promise<void> {
  await recordDemoEvent(supabase, {
    kind: 'action',
    action: 'jobs.score_batch',
    target: '/jobs',
    detail,
    headers,
  })
}

function clampLimit(v: unknown): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(n), HARD_CAP)
}

function parseEffort(v: unknown): ReasoningEffort | undefined {
  return typeof v === 'string' && (REASONING_EFFORTS as readonly string[]).includes(v) ? (v as ReasoningEffort) : undefined
}

// ---------------------------------------------------------------------------
// SYNC WARNING: quoteFilterValue / facetOrFilter below are a DELIBERATE
// duplicate of lib/harness/agents/matcher.ts's quoteFilterValue (:425-437)
// and facetOrFilter (:439-448), and the query they build mirrors that file's
// fetchDefaultCandidatePool (:494-525) — the exact SQL predicate
// selectCandidateJobs uses to pick the default candidate pool that
// runBulkMatch actually scores. matcher.ts does not export these (nor
// passesQualityAndTargeting, :281-305), and this route does not own that
// file, so they cannot be imported. If matcher.ts's predicate changes, THIS
// must change too or the "remaining to score" count will drift from what the
// scorer can actually reach again — the exact bug this file was rewritten to
// fix. Like fetchDefaultCandidatePool, this is SQL-only: it deliberately
// omits targeting.excludedCompanies/excludedKeywords (matcher.ts keeps those
// JS-only — they need the joined company name / description text — and
// they're rare/optional prefs, not the always-on case that caused the
// starvation this fix addresses), so remainingInTargeting can be a hair
// higher than what a full JS passesQualityAndTargeting pass would report for
// an account that has set those two prefs.
function quoteFilterValue(v: string): string {
  return /[,()"]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v
}
function facetOrFilter(column: string, values: string[]): string {
  const list = values.map(quoteFilterValue).join(',')
  return `${column}.is.null,${column}.eq.unknown,${column}.in.(${list})`
}

/** Raw match_score-null count, no targeting/quality filter — this is what
 *  `remaining` used to mean (the bug). Kept only to derive `excludedByTargeting`
 *  (= this minus countRemainingInTargeting) — never returned to the client on
 *  its own, so a caller can no longer mistake it for "left to score". */
async function countUnscoredNoFilter(admin: AdminClient, userId: string, companyIds: string[]): Promise<number> {
  if (companyIds.length === 0) return 0
  // Ownership via the companies FK join (ownedJobsQuery), not an
  // .in('company_id', companyIds) array — that breaks past ~600 companies.
  const { count, error } = await ownedJobsQuery(admin, userId, 'id, companies!inner(user_id)', {
    count: 'exact',
    head: true,
  }).is('match_score', null)
  if (error) {
    console.error('[agents/match/batch] unscored-count query failed', error)
    return 0
  }
  return count ?? 0
}

/** match_score-null rows that ALSO pass the quality + targeting predicate —
 *  see the SYNC WARNING above. This is the number the "Score unscored jobs"
 *  button can actually drive to zero. */
async function countRemainingInTargeting(
  admin: AdminClient,
  userId: string,
  companyIds: string[],
  targeting: Targeting
): Promise<number> {
  if (companyIds.length === 0) return 0
  let query = ownedJobsQuery(admin, userId, 'id, companies!inner(user_id)', { count: 'exact', head: true }).is(
    'match_score',
    null
  )
    .or(`quality_score.is.null,quality_score.gte.${QUALITY_REJECT_THRESHOLD}`)

  if (targeting.functions.length > 0) query = query.or(facetOrFilter('job_function', targeting.functions))
  if (targeting.seniority.length > 0) query = query.or(facetOrFilter('seniority', targeting.seniority))
  if (targeting.languages.length > 0) query = query.or(facetOrFilter('language', targeting.languages))
  if (targeting.countries.length > 0) query = query.or(facetOrFilter('country', targeting.countries))
  if (targeting.remoteOnly) query = query.or('is_remote.is.null,is_remote.eq.true')

  const { count, error } = await query
  if (error) {
    console.error('[agents/match/batch] remaining-in-targeting count query failed', error)
    return 0
  }
  return count ?? 0
}
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const limit = clampLimit((body as { limit?: unknown })?.limit)

  const rawModel = (body as { model?: unknown })?.model
  const modelProvided = typeof rawModel === 'string' && rawModel.trim().length > 0
  const model = modelProvided && isAllowedModel(rawModel) ? rawModel : undefined
  if (modelProvided && !model) {
    return NextResponse.json({ error: `Unsupported model "${rawModel as string}".` }, { status: 400 })
  }
  const effort = parseEffort((body as { effort?: unknown })?.effort)

  const admin = createAdminClient()

  // PROVIDER GATE ALIGNMENT: fail fast, before any queries, with the same
  // actionable message the other LLM routes use — never a bare "missing key".
  const apiKeys = await loadApiKeys(admin, user.id)
  if (!canRunLlm(apiKeys)) {
    // Journalled: "the visitor tried to score and the workspace had no key" is
    // a fact about the demo the owner set up, not a non-event.
    await recordScoringOutcome(
      supabase,
      { outcome: 'failed', reason: 'no_key' },
      request.headers
    )
    return NextResponse.json(
      { error: missingOpenRouterMessage(apiKeys), skippedReason: 'no-llm-key' },
      { status: 400 }
    )
  }

  const { data: profile } = await admin
    .from('profiles')
    .select('resume_text, preferences')
    .eq('id', user.id)
    .single()
  const resume = String((profile?.resume_text as string | null) ?? '').trim()
  if (!resume) {
    await recordScoringOutcome(
      supabase,
      { outcome: 'failed', reason: 'no_resume' },
      request.headers
    )
    return NextResponse.json(
      { error: 'No resume uploaded — add one in Settings before matching jobs.', skippedReason: 'no-resume' },
      { status: 400 }
    )
  }
  const prefs = (profile?.preferences as Record<string, unknown> | null) ?? {}
  const targeting = resolveTargeting(prefs)

  const companyIds = await userCompanyIds(admin, user.id)

  if (companyIds.length === 0) {
    // A 200 that scored nothing. Not a failure — nothing was wrong — but it is
    // still a click the owner should see, and "Scored 0 jobs · reason: no
    // companies" is a far better answer than an empty timeline.
    await recordScoringOutcome(supabase, { count: 0, reason: 'no_companies' }, request.headers)
    return NextResponse.json({
      scored: 0,
      failed: 0,
      remaining: 0,
      remainingInTargeting: 0,
      excludedByTargeting: 0,
      candidatesConsidered: 0,
      skippedReasons: { 'no-companies': 1 },
      batches: 0,
      tokensUsed: 0,
    })
  }

  let result: BulkMatcherResult
  try {
    // internals now run under runAgentUnit('bulk_matcher') — metered/demo-
    // gated/journaled the same as every other unit — instead of calling
    // runBulkMatch directly. No checkpoint thread: the DB's match_score IS
    // NULL set is already the cursor (see this file's own header), so a
    // thread would only duplicate that truth. companyIds/targetTitles are
    // passed explicitly (already resolved above, for the no-resume/
    // no-companies checks and the post-run stats below) so the unit's own
    // internal resolution — see lib/harness/registry.ts's bulk_matcher
    // wrapper, which exists precisely so a caller does NOT have to know
    // this — is simply handed what this route already has.
    const unitResult = await runUnitOnce('bulk_matcher', {
      admin,
      userId: user.id,
      goal: 'Score unscored jobs',
      input: {
        companyIds,
        limit,
        model,
        effort,
        // Spend on the most on-target jobs first. Ordering only — nothing is
        // excluded, so an unusually-titled role is still scored, just later.
        targetTitles: resolveTargetTitles(prefs),
      },
    })
    result = unitResult.output as BulkMatcherResult
  } catch (e) {
    // The unit issues tier-1 and tier-2 LLM calls before it can throw, so
    // this is money already spent with nothing persisted to show for it — the
    // single most expensive thing a successes-only trail would have hidden.
    // Journalled and RETHROWN: what this request returns is exactly what it
    // returned before, because an audit row is not a licence to change a
    // handler's behaviour.
    await recordScoringOutcome(
      supabase,
      { outcome: 'failed', reason: 'score_failed' },
      request.headers
    )
    throw e
  }

  // Both counts reflect POST-run state (scoring above may have just cleared
  // some of these rows), computed in parallel — two head-count queries, no
  // LLM spend. See the SYNC WARNING above for what remainingInTargeting must
  // stay aligned with.
  const [remainingInTargeting, totalUnscored] = await Promise.all([
    countRemainingInTargeting(admin, user.id, companyIds, targeting),
    countUnscoredNoFilter(admin, user.id, companyIds),
  ])
  const excludedByTargeting = Math.max(0, totalUnscored - remainingInTargeting)

  // THE DEMO TRAIL — see recordScoringOutcome above for what goes in a row and
  // what awaiting it costs.
  await recordScoringOutcome(
    supabase,
    {
      count: result.scored,
      failed: result.failed,
      considered: result.candidatesConsidered,
      remaining: remainingInTargeting,
    },
    request.headers
  )

  return NextResponse.json({
    scored: result.scored,
    failed: result.failed,
    // Back-compat field — see the REMAINING-COUNT FIX comment at the top of
    // this file: this now means the same thing as remainingInTargeting, not
    // the old ungated match_score-null count.
    remaining: remainingInTargeting,
    remainingInTargeting,
    excludedByTargeting,
    candidatesConsidered: result.candidatesConsidered,
    skippedReasons: result.skippedReasons,
    batches: result.batches,
    tokensUsed: result.tokensUsed,
  })
}
