// POST /api/agents/match/batch  { limit?: number, model?: string }
//
// Assesses the person's roles that have not been assessed yet, a bounded page at
// a time (default 200, hard cap 500), through lib/scoring: roles that break a fact
// they stated are filtered with the reason, the rest are judged on what they want
// and on their chance against the resume. Safe to call again immediately: it
// always takes the next unassessed page, so a client can poll this in a loop until
// `remainingInTargeting` reaches 0.
//
// `scored` keeps its old name in the response for existing callers; it now means
// "roles with a recorded verdict". `remaining` and `remainingInTargeting` are the
// roles still waiting among those worth assessing (inside the function and level
// the person asked for); the rest, which stay unassessed on purpose, are reported
// as `excludedByTargeting`.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { loadApiKeys } from '@/lib/harness/keys'
import { canRunLlm, missingOpenRouterMessage } from '@/lib/harness/llm-key-message'
import { userCompanyIds } from '@/lib/jobs/owned-query'
import { countUnassessed } from '@/lib/scoring/inputs'
import { runUnitOnce } from '@/lib/graph/oneshot'
import { resolveTargeting } from '@/lib/targeting'
import { BulkMatcherOutput } from '@/lib/harness/schemas'
import type { z } from 'zod'
import { isAllowedModel } from '@/lib/models'
import { recordDemoEvent } from '@/lib/access/session'
import { setTraceInput, setTraceOutput, withTrace } from '@/lib/trace/spans'

/** Unit output, typed off the same zod schema runAgentUnit validated it
 *  against (agentSchemas.bulk_matcher.output) — see lib/harness/schemas.ts. */
type BulkMatcherResult = z.infer<typeof BulkMatcherOutput>

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const DEFAULT_LIMIT = 200
const HARD_CAP = 500

/**
 * One trail row for a bulk assessment attempt: what it assessed, or why it
 * assessed nothing.
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

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return withTrace(createAdminClient(), user.id, { name: 'match-jobs' }, async () => {

    const body = await request.json().catch(() => ({}))
    const limit = clampLimit((body as { limit?: unknown })?.limit)

    const rawModel = (body as { model?: unknown })?.model
    const modelProvided = typeof rawModel === 'string' && rawModel.trim().length > 0
    const model = modelProvided && isAllowedModel(rawModel) ? rawModel : undefined
    if (modelProvided && !model) {
      return NextResponse.json({ error: `Unsupported model "${rawModel as string}".` }, { status: 400 })
    }

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
      // Runs under runAgentUnit('bulk_matcher'), so it is metered, demo-gated and
      // journaled like every other unit. No checkpoint thread: the roles that have
      // no assessment yet are the cursor, so a thread would only duplicate that.
      const unitResult = await runUnitOnce('bulk_matcher', {
        admin,
        userId: user.id,
        goal: 'Assess unassessed roles',
        input: { companyIds, limit, model },
      })
      result = unitResult.output as BulkMatcherResult
      setTraceInput({ companies: companyIds.length, limit })
    } catch (e) {
      // The unit may have made model calls before it throws, so this is spend with
      // nothing to show for it, which a trail of successes alone would hide.
      // Journalled and rethrown: an audit row does not change what the request returns.
      await recordScoringOutcome(
        supabase,
        { outcome: 'failed', reason: 'score_failed' },
        request.headers
      )
      throw e
    }

    // The counts reflect the state after this run: two head-count queries, no model spend.
    const { inRecall: remainingInTargeting, total: totalUnassessed } = await countUnassessed(admin, user.id, targeting)
    const excludedByTargeting = Math.max(0, totalUnassessed - remainingInTargeting)

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

    setTraceOutput({ scored: result.scored, failed: result.failed, remaining: remainingInTargeting, tokensUsed: result.tokensUsed })
    return NextResponse.json({
      scored: result.scored,
      failed: result.failed,
      // Same number as remainingInTargeting; kept under its old name for existing callers.
      remaining: remainingInTargeting,
      remainingInTargeting,
      excludedByTargeting,
      candidatesConsidered: result.candidatesConsidered,
      skippedReasons: result.skippedReasons,
      batches: result.batches,
      tokensUsed: result.tokensUsed,
    })
  })
}
