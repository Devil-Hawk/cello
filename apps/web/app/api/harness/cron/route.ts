// POST /api/harness/cron — the harness's one scheduled tick: resume every
// checkpointed run that stalled, wipe ruling-5 user-data rows past their
// demo's expiry, create + run a daily-digest agent_run for each active user,
// then run lib/graph/distill.ts#distillInsights per active user (its own
// internal weekly gate makes this a cheap no-op on six of every seven ticks)
// (docs/superpowers/specs/2026-08-16-langgraph-port-design.md).
//
// Guarded by the CRON_SECRET env var: the caller must present it as either
// `Authorization: Bearer <secret>` or `X-Cron-Secret: <secret>`. Invoked by
// .github/workflows/harness-cron.yml on a daily schedule.
//
// maxDuration = 300 mirrors app/api/harness/run/route.ts — lib/graph/runs.ts's
// own MAX_RUN_MS is 240s per run, so CRON_MAX_USERS/CRON_CONCURRENCY batches of
// MULTIPLE runs, plus the resume pass below, can still exceed even a 300s route
// budget in the worst case (e.g. every run in a wave using its full deadline).
// That worst case already existed before this file's graph port — raising both
// ceilings together does not make it worse, it just matches the platform
// allowance. A run killed mid-request by a platform-level timeout (rather than
// its own internal deadline) is recovered by the RESUME PASS below on the next
// tick, exactly like a clean deadline pause — see that pass's own doc for why
// neither this route nor harnessRunGraph itself needs to tell the two apart.
//
// RESUME PASS replaces the pre-port continueIncompleteRuns() + reapStuckRuns():
// both of those existed to recover a run the bespoke executor couldn't recover
// on its own (a continuation counter plus a stuck-run reaper standing in for a
// durable checkpoint). The graph port's checkpoint IS that durable state, so
// this route's main job is re-entering the thread — see
// resumeCheckpointedRuns() below. That function still carries TWO backstops,
// because a thread can fail to make progress in two structurally different
// ways: CHECKPOINT_CEILING bounds a thread that keeps landing back on its OWN
// deadline interrupt() (real work happens, a checkpoint is written every
// time, it just never reaches a terminal state); RESUME_ATTEMPT_CEILING
// bounds a thread whose resume attempt fails BEFORE invokeGraphForUser ever
// gets far enough to produce a new checkpoint at all (a thread-ownership
// refusal, an expired demo thread, a checkpointer connectivity failure) —
// CHECKPOINT_CEILING structurally cannot see that case, since the checkpoint
// count never moves on it.
//
// DIGEST PASSES (unchanged shape, now graph-backed): for each active user (has
// a resume and/or an OpenRouter key) we create a "daily digest" agent_runs row
// and drive it through harnessRunGraph, THEN separately compose-and-store the
// preferences.digest.latest summary composeAndStoreDigest already produced
// before this port — that second pass has no LLM/agent-run in it and is
// untouched by the graph port. To stay within the serverless timeout both
// passes process a bounded batch with small concurrency; at scale this should
// enqueue runs (status 'queued') and drain them from a dedicated worker rather
// than executing inline.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { invokeGraphForUser, type CompiledGraphLike } from '@/lib/graph/invoke'
import { harnessRunGraph, markRunPausedOnInterrupt, type RunOutcome } from '@/lib/graph/runs'
import { countThreadCheckpoints } from '@/lib/graph/pg'
import { distillInsights } from '@/lib/graph/distill'
import { composeAndStoreDigest, type DigestOutcome } from '@/lib/harness/agents/digest'
import { wipeExpiredDemoData, type DemoWipeResult } from '@/lib/access/demo-wipe'
import { pruneOldTraceSpans } from '@/lib/trace/spans'
import type { AdminClient } from '@/lib/harness/types'
import { logApiError } from '@/lib/observability/log'
import { chunkedIn } from '@/lib/supabase/chunked-in'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// harnessRunGraph (a real compiled LangGraph Pregel graph) has a NARROWER
// `invoke` input type than CompiledGraphLike's own `unknown` — the same
// structural gap lib/graph/invoke.langgraph.test.ts already casts around for
// a real compiled graph. invokeGraphForUser only ever calls `.invoke`/
// `.stream`/`.getState` with the config it builds itself, so this is a
// type-only gap, not a behavioral one.
const RUN_GRAPH = harnessRunGraph as unknown as CompiledGraphLike

const CRON_MAX_USERS = 10
const CRON_CONCURRENCY = 3
const DIGEST_GOAL =
  'Daily digest: source new jobs from my tracked companies, match them against my resume, and surface the top matches with explanations.'

/**
 * A 'running' agent_runs row whose thread has not been touched (graph_threads
 * .last_invoked_at, stamped by invokeGraphForUser on every attempt — see that
 * table's own migration comment: "distinguishable from an active one without
 * touching the checkpointer schema") in this long is treated as killed mid-
 * invocation rather than genuinely in flight, and becomes eligible for the
 * resume pass exactly like a cleanly 'paused' run.
 */
const STALE_RUNNING_MS = 10 * 60 * 1000

/**
 * First of two pathology backstops for the resume pass (see
 * RESUME_ATTEMPT_CEILING below for the second): a run whose thread has piled
 * up more than this many checkpoints without reaching a terminal state — a
 * plan that lands back on the deadline interrupt every single attempt,
 * legitimately making progress but never finishing — is closed out instead
 * of resumed. THE RESUME RULE (lib/graph/invoke.ts) treats every resume
 * identically regardless of history — no branching on why a thread
 * stopped — so this checkpoint count, not an attempt counter, is what
 * detects that pattern. See lib/graph/pg.ts#countThreadCheckpoints.
 */
const CHECKPOINT_CEILING = 200

/**
 * Second pathology backstop: bounds a run whose resume attempt fails before
 * invokeGraphForUser ever gets far enough to write a new checkpoint (a
 * ThreadOwnershipError, a DemoThreadExpiredError, a checkpointer/DB
 * connectivity failure, or any other throw — see resumeCheckpointedRuns'
 * header). CHECKPOINT_CEILING cannot bound this case: no checkpoint is ever
 * produced on this path, so the checkpoint count never climbs regardless of
 * how many times the thread is retried.
 *
 * Reuses agent_runs.continuation_count (added by
 * 20260728000009_run_incomplete_status.sql for the now-deleted pre-port
 * continuation mechanism, and otherwise unwritten by this graph port) as a
 * CONSECUTIVE-failure streak, not a lifetime attempt total: bumped BEFORE
 * every resume attempt in the batch below (durable against the attempt
 * itself getting killed mid-request, exactly like the pre-port mechanism it
 * reuses the column from), then reset to 0 the instant an attempt returns
 * WITHOUT throwing — whether that attempt paused again or reached a terminal
 * state. That reset is what keeps this from misfiring on a thread that
 * legitimately keeps landing back on its own deadline interrupt() (real
 * progress, no throw): CHECKPOINT_CEILING alone bounds that case, this
 * ceiling only ever fires on a run whose last RESUME_ATTEMPT_CEILING
 * attempts, in a row, never got past invokeGraphForUser.
 */
const RESUME_ATTEMPT_CEILING = 5

/**
 * How many distinct stalled runs (paused or stale-running) get one resume
 * attempt per tick. Each attempt can itself run up to MAX_RUN_MS (240s, see
 * lib/graph/runs.ts) inside this route's own maxDuration=300s — sequential,
 * uncapped concurrency here would risk this route hitting the SAME deadline
 * problem the resume pass exists to fix. A run that doesn't get a turn this
 * tick is simply picked up again on the next one; nothing about it is lost.
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

// --- resume pass -------------------------------------------------------------

interface ResumeCandidate {
  id: string
  user_id: string
  thread_id: string
  created_at: string
  /** Consecutive resume-attempt failure streak — see RESUME_ATTEMPT_CEILING's doc. `?? 0` at every read site: absent for any run this port's resume pass has never yet attempted. */
  continuation_count: number
}

interface ResumeResult {
  runId: string
  /** A terminal RunOutcome status, 'paused' (interrupted again), or 'error' (the attempt itself threw). */
  outcome: string
  error?: string
}

interface ResumeBatch {
  /** Runs actually attempted this tick, in order. */
  resumed: ResumeResult[]
  /** Eligible runs left for a later tick — see CRON_MAX_CONTINUATIONS. */
  deferred: number
}

/** Raw shape a `select('id, user_id, thread_id, created_at, continuation_count')` returns — continuation_count is nullable at the DB layer (pre-existing rows, see the column's own migration). */
type RawResumeRow = Omit<ResumeCandidate, 'continuation_count'> & { continuation_count: number | null }

function normalizeCandidate(row: RawResumeRow): ResumeCandidate {
  return { ...row, continuation_count: row.continuation_count ?? 0 }
}

/**
 * Every agent_runs row eligible for a resume attempt: 'paused' (a clean
 * deadline interrupt) OR 'running' with its thread stale past
 * STALE_RUNNING_MS (a killed invocation — see that constant's doc). Both
 * require a thread_id — a 'running' row that never got far enough to acquire
 * one has nothing for invokeGraphForUser to resume and is left alone (it
 * will show up here once it DOES have one, or never really started at all).
 * Ordered oldest-first, matching the pre-port continueIncompleteRuns.
 */
async function collectResumeCandidates(admin: AdminClient): Promise<ResumeCandidate[]> {
  const { data: pausedRows, error: pausedErr } = await admin
    .from('agent_runs')
    .select('id, user_id, thread_id, created_at, continuation_count')
    .eq('status', 'paused')
    .not('thread_id', 'is', null)
  if (pausedErr) console.error('[harness cron] resume: paused query failed', pausedErr)

  const { data: runningRows, error: runningErr } = await admin
    .from('agent_runs')
    .select('id, user_id, thread_id, created_at, continuation_count')
    .eq('status', 'running')
    .not('thread_id', 'is', null)
  if (runningErr) console.error('[harness cron] resume: running query failed', runningErr)

  const running = ((runningRows ?? []) as RawResumeRow[]).map(normalizeCandidate)
  let staleRunning: ResumeCandidate[] = []
  if (running.length > 0) {
    const threadIds = running.map((r) => r.thread_id)
    // System-wide scan (every user's running runs), not a per-user ownership
    // fence — no FK join scopes it, so it's chunked instead: a normal-sized
    // .in() would break past a few hundred concurrently-running threads.
    const threadRows = await chunkedIn(threadIds, async (chunk) => {
      const { data, error } = await admin.from('graph_threads').select('thread_id, last_invoked_at').in('thread_id', chunk)
      if (error) console.error('[harness cron] resume: graph_threads query failed', error)
      return (data ?? []) as { thread_id: string; last_invoked_at: string | null }[]
    })
    const lastInvoked = new Map(threadRows.map((t) => [t.thread_id, t.last_invoked_at]))
    const cutoff = Date.now() - STALE_RUNNING_MS
    // No stamp at all (a thread row that exists but was never touched by an
    // invoke attempt — should not happen once markRunRunning always writes
    // thread_id, but a stray/legacy row is treated as stale rather than
    // trusted) counts as stale too.
    staleRunning = running.filter((r) => {
      const ts = lastInvoked.get(r.thread_id)
      return !ts || new Date(ts).getTime() < cutoff
    })
  }

  const eligible = [...((pausedRows ?? []) as RawResumeRow[]).map(normalizeCandidate), ...staleRunning]
  eligible.sort((a, b) => a.created_at.localeCompare(b.created_at))
  return eligible
}

/**
 * Resume every checkpointed run that paused at its deadline interrupt, plus
 * any run whose 'running' status has gone stale (its thread hasn't been
 * touched in STALE_RUNNING_MS — the signature of an invocation that was
 * killed mid-request rather than one that returned cleanly). THE RESUME RULE
 * (lib/graph/invoke.ts) applies uniformly to both: invokeGraphForUser is
 * called with no input and no resume value, which is safe and correct for a
 * killed-mid-task thread, a cleanly-parked interrupt, or (harmlessly) an
 * already-completed one alike — there is no branch here on WHY a thread
 * stopped, only on what state it is in now.
 *
 * A run already at RESUME_ATTEMPT_CEILING consecutive failures is closed out
 * unconditionally, BEFORE batching or ordering — see that constant's doc: it
 * must never consume one of the CRON_MAX_CONTINUATIONS slots a healthy run
 * needs. What's left is bounded to CRON_MAX_CONTINUATIONS sequential attempts
 * per tick, oldest first — mirrors the pre-port continueIncompleteRuns' own
 * batching. THE RESUME RULE still makes every attempt free of history in how
 * it resumes; RESUME_ATTEMPT_CEILING only tracks whether recent attempts got
 * far enough to produce a checkpoint at all, which is orthogonal.
 */
async function resumeCheckpointedRuns(admin: AdminClient): Promise<ResumeBatch> {
  const eligible = await collectResumeCandidates(admin)
  const exhausted = eligible.filter((r) => r.continuation_count >= RESUME_ATTEMPT_CEILING)
  const runnable = eligible.filter((r) => r.continuation_count < RESUME_ATTEMPT_CEILING)

  const resumed: ResumeResult[] = []

  for (const run of exhausted) {
    const closeoutError =
      `gave up auto-resuming after ${RESUME_ATTEMPT_CEILING} consecutive failed attempt(s) ` +
      `(thread ${run.thread_id} never produced a new checkpoint) — see agent_runs.error on the last attempt`
    const { error: updErr } = await admin
      .from('agent_runs')
      .update({ status: 'completed_with_errors', error: closeoutError, finished_at: new Date().toISOString() })
      .eq('id', run.id)
    if (updErr) console.error(`[harness cron] resume: failed to close out ${run.id} past the resume-attempt ceiling`, updErr)
    resumed.push({ runId: run.id, outcome: 'completed_with_errors', error: closeoutError })
  }

  const batch = runnable.slice(0, CRON_MAX_CONTINUATIONS)

  // Sequential, not concurrent — see CRON_MAX_CONTINUATIONS's doc: each
  // resume can itself take up to MAX_RUN_MS, and this route only has
  // maxDuration=300s total (shared with the digest passes below), so running
  // these in parallel would reintroduce the exact "everything competes for
  // one request's deadline" problem this pass exists to fix.
  for (const run of batch) {
    // Bumped BEFORE the attempt, durably — see RESUME_ATTEMPT_CEILING's doc:
    // an attempt that throws, or is killed mid-request before the catch
    // below even runs, still counts against the ceiling on the next tick.
    const nextCount = run.continuation_count + 1
    await admin.from('agent_runs').update({ continuation_count: nextCount }).eq('id', run.id)

    try {
      const checkpointCount = await countThreadCheckpoints(run.thread_id, CHECKPOINT_CEILING)
      if (checkpointCount > CHECKPOINT_CEILING) {
        const closeoutError = `closed out: thread ${run.thread_id} passed ${CHECKPOINT_CEILING} checkpoints without reaching a terminal state`
        const { error: updErr } = await admin
          .from('agent_runs')
          .update({ status: 'completed_with_errors', error: closeoutError, finished_at: new Date().toISOString() })
          .eq('id', run.id)
        if (updErr) console.error(`[harness cron] resume: failed to close out ${run.id} past the checkpoint ceiling`, updErr)
        resumed.push({ runId: run.id, outcome: 'completed_with_errors', error: closeoutError })
        continue
      }

      const { result } = await invokeGraphForUser({
        admin,
        userId: run.user_id,
        surface: 'run',
        graph: RUN_GRAPH,
        threadId: run.thread_id,
      })

      // Reached invokeGraphForUser's return without throwing: this attempt
      // produced a checkpoint (or a terminal write), so the failure streak
      // resets — see RESUME_ATTEMPT_CEILING's doc on why this must reset on
      // ANY clean attempt, not just a terminal one, so a thread that
      // legitimately keeps re-pausing is never penalized by this ceiling.
      const { error: resetErr } = await admin.from('agent_runs').update({ continuation_count: 0 }).eq('id', run.id)
      if (resetErr) console.error(`[harness cron] resume: failed to reset continuation_count for ${run.id}`, resetErr)

      if (await markRunPausedOnInterrupt(admin, run.id, result)) {
        resumed.push({ runId: run.id, outcome: 'paused' })
      } else {
        resumed.push({ runId: run.id, outcome: (result as RunOutcome).status })
      }
    } catch (e) {
      logApiError('harness/cron:resume', e, { runId: run.id })
      resumed.push({ runId: run.id, outcome: 'error', error: e instanceof Error ? e.message : String(e) })
    }
  }

  return { resumed, deferred: runnable.length - batch.length }
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()

  // Resume pass first, independent of the digest passes below — a resume
  // failure must never block new digest runs from starting.
  const resume = await resumeCheckpointedRuns(admin).catch((e) => {
    logApiError('harness/cron:resume', e)
    return { resumed: [], deferred: 0 } as ResumeBatch
  })

  // Ruling 5 wipe-at-expiry pass — see lib/access/demo-wipe.ts's header for
  // why this rides the existing tick instead of its own scheduled path.
  // Independent of every other pass for the same reason resume is: a wipe
  // failure must never block digests, and a digest failure must never block
  // the wipe.
  const demoWipe = await wipeExpiredDemoData(admin).catch((e) => {
    logApiError('harness/cron:demo-wipe', e)
    return [] as DemoWipeResult[]
  })

  // trace_spans retention — rides the same tick as the demo wipe just above,
  // for the same reason (see lib/trace/spans.ts#pruneOldTraceSpans and the
  // trace_spans migration's own header): independent of every other pass, a
  // prune failure must never block resume/digest/distill and vice versa.
  const traceSpansPruned = await pruneOldTraceSpans(admin).catch((e) => {
    logApiError('harness/cron:trace-prune', e)
    return 0
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

  // Bounded-concurrency execution over the batch: one fresh agent_runs row
  // (and therefore one fresh graph thread — invokeGraphForUser mints a new
  // one whenever no threadId is passed) per active user.
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
        const { result } = await invokeGraphForUser({
          admin,
          userId: profile.id,
          surface: 'run',
          graph: RUN_GRAPH,
          input: { runId },
        })
        if (await markRunPausedOnInterrupt(admin, runId, result)) {
          // A digest run that hits its own deadline is not lost — it now sits
          // 'paused' with a thread_id, so the RESUME PASS above picks it up
          // on a later tick exactly like any other stalled run.
          results.push({ userId: profile.id, runId, status: 'paused' })
        } else {
          const outcome = result as RunOutcome
          results.push({
            userId: profile.id,
            runId,
            status: outcome.status,
            matcher: extractMatcherSummary(outcome),
          })
        }
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
  // intentional and must not block the feature. Unrelated to the graph port —
  // no LLM call, no agent_run — untouched by it.
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

  // --- Weekly insight distillation pass (Step 6) ------------------------------
  // distillInsights carries its OWN weekly gate (agent_runs.created_at for
  // goal=DISTILL_GOAL) — most ticks this is one cheap SELECT per user that
  // returns { ran: false } immediately, so riding the existing per-user batch
  // here (same active-user set, same bounded concurrency) costs nothing extra
  // on the six days out of seven it does not actually distill. A failure for
  // one user must never block another's digest/resume/distillation, same
  // independence discipline as every other pass in this route.
  const distillResults: { userId: string; ran: boolean; reason?: string; insightsWritten?: number; refusals?: number }[] = []
  let xNext = 0
  const distillWorker = async () => {
    while (true) {
      const i = xNext++
      if (i >= batch.length) return
      const profile = batch[i]
      try {
        const r = await distillInsights(admin, profile.id)
        distillResults.push({ userId: profile.id, ran: r.ran, reason: r.reason, insightsWritten: r.insightsWritten, refusals: r.refusals })
      } catch (e) {
        logApiError('harness/cron:distill', e, { userId: profile.id })
        distillResults.push({ userId: profile.id, ran: false, reason: e instanceof Error ? e.message : String(e) })
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(CRON_CONCURRENCY, batch.length)) }, distillWorker)
  )

  return NextResponse.json({
    ok: true,
    activeUsers: active.length,
    processed: batch.length,
    skippedForCapacity: Math.max(0, active.length - batch.length),
    results,
    digest: digestResults,
    distill: distillResults,
    demoWipe,
    traceSpansPruned,
    resumed: {
      count: resume.resumed.length,
      deferredToNextTick: resume.deferred,
      runs: resume.resumed,
    },
  })
}
