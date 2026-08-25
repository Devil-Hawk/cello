// POST /api/harness/cron — scheduled daily-digest runs, one per active user.
//
// Guarded by the CRON_SECRET env var: the caller must present it as either
// `Authorization: Bearer <secret>` or `X-Cron-Secret: <secret>`. Invoked by
// .github/workflows/harness-cron.yml on a daily schedule.
//
// For each active user (has a resume and/or an OpenRouter key) we create a
// "daily digest" agent_runs row and execute it. To stay within the serverless
// timeout we process a bounded batch with small concurrency; at scale this
// should enqueue runs (status 'queued') and drain them from a dedicated worker
// rather than executing inline.
//
// maxDuration = 300 mirrors app/api/harness/run/route.ts — lib/harness/executor.ts's
// own MAX_RUN_MS is now 240s per run, so CRON_MAX_USERS/CRON_CONCURRENCY batches
// of MULTIPLE runs can still exceed even a 300s route budget in the worst case
// (e.g. every run in a wave using its full deadline). That worst case was
// already possible before this change (4 waves x the old 55s deadline > the old
// 60s route budget) — raising both ceilings together does not make it worse,
// it just matches the new platform allowance. A run killed mid-request by a
// platform-level timeout (rather than its own internal deadline) is recovered
// by reapStuckRuns below on the next tick, not left 'running' forever.
//
// Every tick ALSO reaps any agent_runs row stuck in a non-terminal status
// (queued/planning/running) past the stuck-run threshold — see
// lib/harness/executor.ts#reapStuckRuns. This is the recovery path for a run
// whose invocation was killed before it ever wrote a terminal status.
//
// Every tick ALSO continues any 'incomplete' run — one that paused at its own
// wall-clock deadline (lib/harness/executor.ts's MAX_RUN_MS) with agent_steps
// still pending, NOT one that ran out of token budget (that stays terminal on
// purpose — see the RunStatus['incomplete'] doc in lib/harness/types.ts). See
// continueIncompleteRuns() below: bounded by MAX_CONTINUATIONS per run so a
// pathological plan that always lands back on the deadline cannot loop
// forever re-attempting itself, and processed with a small per-tick cap
// (CRON_MAX_CONTINUATIONS) so this doesn't blow the route's own maxDuration —
// a run with more continuations left just gets picked up again next tick.
//
// REAP FREQUENCY: this route is only invoked once a day by
// .github/workflows/harness-cron.yml, which is too infrequent for a run
// stuck since (say) 2026-07-25 to surface promptly. The other candidate tick,
// app/api/harness/autopilot/route.ts (hourly), is explicitly out of scope for
// this change — see the note on reapStuckRuns's call site in
// app/api/harness/run/route.ts, which is why THAT route (owned here) also
// calls reapStuckRuns on every real user run submission instead.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { runAgentRun, reapStuckRuns } from '@/lib/harness/executor'
import { composeAndStoreDigest, type DigestOutcome } from '@/lib/harness/agents/digest'
import type { AdminClient } from '@/lib/harness/types'
import { logApiError } from '@/lib/observability/log'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const CRON_MAX_USERS = 10
const CRON_CONCURRENCY = 3
const DIGEST_GOAL =
  'Daily digest: source new jobs from my tracked companies, match them against my resume, and surface the top matches with explanations.'

/**
 * Cap on how many times a single run can be auto-continued after pausing on
 * 'incomplete'. Recorded durably on agent_runs.continuation_count (bumped
 * BEFORE each attempt — see continueIncompleteRuns), so this bound survives
 * across cron ticks and across a continuation attempt itself getting killed
 * mid-request.
 */
const MAX_CONTINUATIONS = 5
/**
 * How many distinct 'incomplete' runs get one continuation attempt per tick.
 * Each attempt can itself run up to MAX_RUN_MS (240s, see executor.ts) inside
 * this route's own maxDuration=300s — sequential, uncapped concurrency here
 * would risk this route hitting the SAME deadline problem this feature exists
 * to fix. A run that needs more than its share this tick is simply picked up
 * again on the next one; nothing about it is lost (that is the entire point
 * of 'incomplete' being resumable).
 */
const CRON_MAX_CONTINUATIONS = 2

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = request.headers.get('authorization')
  const bearer = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null
  const header = request.headers.get('x-cron-secret')
  return bearer === secret || header === secret
}

interface ActiveProfile {
  id: string
  resume_text: string | null
  preferences: Record<string, unknown> | null
}

function hasOpenrouter(profile: ActiveProfile): boolean {
  const keys = (profile.preferences?.api_keys ?? {}) as Record<string, unknown>
  return typeof keys.openrouter === 'string' && keys.openrouter.length > 0
}

interface MatcherRunSummary {
  status: string
  scored?: number
  candidatesConsidered?: number
  skippedReason?: string
}

/**
 * Pull the matcher step's own diagnostics out of a completed run so a no-op
 * ("scored 0 jobs") is visible right in this route's JSON response instead of
 * only in the agent_steps journal — the planner picks the step's label, so we
 * find it by agent_type rather than assuming the default plan's 'score-jobs'.
 */
function extractMatcherSummary(outcome: {
  steps: { label: string; agent_type: string; status: string }[]
  outputs: Record<string, unknown>
}): MatcherRunSummary | undefined {
  const step = outcome.steps.find((s) => s.agent_type === 'matcher')
  if (!step) return undefined
  const output = outcome.outputs[step.label] as
    | { matches?: unknown[]; skippedReason?: string; candidatesConsidered?: number }
    | undefined
  return {
    status: step.status,
    scored: Array.isArray(output?.matches) ? output.matches.length : undefined,
    candidatesConsidered: output?.candidatesConsidered,
    skippedReason: output?.skippedReason,
  }
}

interface ContinuationResult {
  runId: string
  continuationCount: number
  status?: string
  error?: string
}

interface ContinuationBatch {
  /** Runs re-entered via runAgentRun this tick. */
  continued: ContinuationResult[]
  /** Runs that hit MAX_CONTINUATIONS while still incomplete and were given up on (moved to a terminal status). */
  exhausted: string[]
  /** Runs eligible but left for a later tick — see CRON_MAX_CONTINUATIONS. */
  deferred: number
}

/**
 * Pick up every agent_runs row paused with status 'incomplete' (deadline hit
 * mid-DAG, NOT budget exhaustion — see the RunStatus doc in
 * lib/harness/types.ts) and re-enter runAgentRun for a bounded batch of them.
 *
 * runAgentRun itself does the actual resumption work (adopting completed
 * steps' stored output, only executing what's left — see executor.ts step 2);
 * this function's job is purely the bookkeeping around WHICH runs get another
 * attempt and how many they have left.
 */
async function continueIncompleteRuns(admin: AdminClient): Promise<ContinuationBatch> {
  const { data: rows, error } = await admin
    .from('agent_runs')
    .select('id, continuation_count')
    .eq('status', 'incomplete')
    .order('created_at', { ascending: true })
  if (error) {
    console.error('[harness cron] continueIncompleteRuns: query failed', error)
    return { continued: [], exhausted: [], deferred: 0 }
  }

  const incomplete = (rows ?? []) as { id: string; continuation_count: number | null }[]
  const exhausted = incomplete.filter((r) => (r.continuation_count ?? 0) >= MAX_CONTINUATIONS)
  const runnable = incomplete.filter((r) => (r.continuation_count ?? 0) < MAX_CONTINUATIONS)

  // A run that used up every continuation and is STILL incomplete is not left
  // behind silently forever (it would otherwise never be selected by the
  // `status = 'incomplete'` filter above again in any useful way) — move it
  // to the same terminal status any other run aborted-with-partial-progress
  // gets, so it stops being polled and its partial results are still visible.
  const exhaustedIds: string[] = []
  for (const run of exhausted) {
    const { error: updErr } = await admin
      .from('agent_runs')
      .update({
        status: 'completed_with_errors',
        error: `gave up auto-resuming after ${MAX_CONTINUATIONS} continuation(s): still had pending steps at the deadline every time`,
        finished_at: new Date().toISOString(),
      })
      .eq('id', run.id)
      .eq('status', 'incomplete') // don't clobber a run that progressed between our select and this update
    if (!updErr) exhaustedIds.push(run.id)
    else console.error(`[harness cron] continueIncompleteRuns: failed to close out exhausted run ${run.id}`, updErr)
  }

  const batch = runnable.slice(0, CRON_MAX_CONTINUATIONS)
  const continued: ContinuationResult[] = []

  // Sequential, not concurrent — see CRON_MAX_CONTINUATIONS's comment: each
  // continuation can itself take up to MAX_RUN_MS, and this route only has
  // maxDuration=300s total (shared with the reap above and the digest batch
  // below), so running these in parallel would reintroduce the exact
  // "everything competes for one request's deadline" problem this feature
  // exists to fix.
  for (const run of batch) {
    const nextCount = (run.continuation_count ?? 0) + 1
    // Bump BEFORE running, durably, so a continuation that itself gets killed
    // mid-request (platform-level timeout, not the executor's own graceful
    // deadline stop) still counts against MAX_CONTINUATIONS on the next tick.
    await admin.from('agent_runs').update({ continuation_count: nextCount }).eq('id', run.id)
    try {
      const outcome = await runAgentRun(admin, run.id)
      continued.push({ runId: run.id, continuationCount: nextCount, status: outcome.status })
    } catch (e) {
      logApiError('harness/cron:continue', e, { runId: run.id, continuationCount: nextCount })
      continued.push({ runId: run.id, continuationCount: nextCount, error: e instanceof Error ? e.message : String(e) })
    }
  }

  return { continued, exhausted: exhaustedIds, deferred: runnable.length - batch.length }
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()

  // Reap any run stuck in a non-terminal status before doing anything else —
  // cheap (a bounded, indexed row scan) and independent of the rest of this
  // tick, so a reaping failure never blocks the digest batch below.
  const reaped = await reapStuckRuns(admin).catch((e) => {
    logApiError('harness/cron:reap', e)
    return { reapedRunIds: [], reapedStepIds: [] }
  })

  // Auto-continue any run paused on 'incomplete' (deadline hit mid-DAG, never
  // budget — see continueIncompleteRuns's own doc). Independent of the digest
  // batch below for the same reason as the reap above: a continuation failure
  // must not block new digest runs from starting.
  const continuation = await continueIncompleteRuns(admin).catch((e) => {
    logApiError('harness/cron:continueIncompleteRuns', e)
    return { continued: [], exhausted: [], deferred: 0 } as ContinuationBatch
  })

  const { data: profiles, error } = await admin
    .from('profiles')
    .select('id, resume_text, preferences')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const active = ((profiles ?? []) as ActiveProfile[]).filter(
    (p) => (p.resume_text && p.resume_text.trim().length > 0) || hasOpenrouter(p)
  )
  const batch = active.slice(0, CRON_MAX_USERS)

  const results: {
    userId: string
    runId?: string
    status?: string
    error?: string
    matcher?: MatcherRunSummary
  }[] = []

  // Bounded-concurrency execution over the batch.
  let next = 0
  const worker = async () => {
    while (true) {
      const i = next++
      if (i >= batch.length) return
      const profile = batch[i]
      try {
        const { data: run, error: insErr } = await admin
          .from('agent_runs')
          .insert({ user_id: profile.id, goal: DIGEST_GOAL, status: 'queued' })
          .select('id')
          .single()
        if (insErr || !run) throw new Error(insErr?.message ?? 'insert failed')
        const runId = (run as { id: string }).id
        const outcome = await runAgentRun(admin, runId)
        results.push({
          userId: profile.id,
          runId,
          status: outcome.status,
          matcher: extractMatcherSummary(outcome),
        })
      } catch (e) {
        logApiError('harness/cron:digest', e, { userId: profile.id })
        results.push({ userId: profile.id, error: e instanceof Error ? e.message : String(e) })
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(CRON_CONCURRENCY, batch.length)) }, worker)
  )

  // --- Daily digest pass -----------------------------------------------------
  // For each active user, compose their digest and store it under
  // preferences.digest.latest. composeAndStoreDigest enforces the opt-in flag
  // (default OFF) and once-per-day (lastSentDate), so non-opted-in users are
  // skipped cleanly. Cron has NO session.provider_token, so we do NOT attempt a
  // real Gmail send here — the digest is composed-and-stored, and an actual send
  // happens later via /api/digest/send (request context). This degradation is
  // intentional and must not block the feature.
  const digestResults: { userId: string; outcome: DigestOutcome; reason?: string }[] = []
  let dNext = 0
  const digestWorker = async () => {
    while (true) {
      const i = dNext++
      if (i >= batch.length) return
      const profile = batch[i]
      const r = await composeAndStoreDigest(admin, profile.id)
      digestResults.push({ userId: r.userId, outcome: r.outcome, reason: r.reason })
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(CRON_CONCURRENCY, batch.length)) }, digestWorker)
  )

  return NextResponse.json({
    ok: true,
    activeUsers: active.length,
    processed: batch.length,
    skippedForCapacity: Math.max(0, active.length - batch.length),
    results,
    digest: digestResults,
    reaped: { runs: reaped.reapedRunIds.length, steps: reaped.reapedStepIds.length, runIds: reaped.reapedRunIds },
    continued: {
      count: continuation.continued.length,
      exhausted: continuation.exhausted.length,
      deferredToNextTick: continuation.deferred,
      runs: continuation.continued,
      exhaustedRunIds: continuation.exhausted,
    },
  })
}
