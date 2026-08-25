// POST /api/harness/run — create an agent_runs row and execute it. Accepts
// EITHER shape (exactly one, never both):
//   { goal: string, budgetTokens?: number }
//     — free-text goal; the executor's own planGoal() LLM call turns it into a
//       DAG at run start (unchanged from before this file's chain support).
//   { chain: ChainName, params: object, budgetTokens?: number }
//     — a named template from lib/harness/chains.ts compiled to a Plan HERE,
//       before the row is even inserted (see CHAINS in that file for the five
//       templates: apply-to-role, submit-confirmed, tailor-for-role,
//       warm-intro, source-until). The compiled Plan is written straight to
//       agent_runs.plan, so runAgentRun's own "plan already present" branch
//       (lib/harness/executor.ts, step 1) skips the LLM planner entirely —
//       cheaper and deterministic, and the only way submit-confirmed's safety
//       gate (confirmed:true) can be enforced: an LLM-authored plan can never
//       produce a submitting step, only compileChain() can, and only for that
//       one chain, and only when the caller passed the literal confirmed:true.
// GET  /api/harness/run — list the caller's recent runs (with their steps).
//
// EXECUTION MODEL / VERCEL TRADEOFF:
// We execute the DAG *synchronously inside this request* and return the finished
// run. This is the simplest model that is correct on Vercel serverless: no
// dropped background work, no dependence on `waitUntil` (which Next 14 route
// handlers don't expose without @vercel/functions), and the client gets the
// result in one round-trip. The cost is that a run must fit inside the function
// timeout — so the executor self-imposes a wall-clock deadline (MAX_RUN_MS) and a
// token budget, aborting cleanly rather than being hard-killed mid-write: hitting
// the token budget skips every remaining step (unrecoverable — the user would
// have to spend more to proceed), while hitting the wall-clock deadline instead
// PAUSES the run ('incomplete') so a later continuation can finish it — see the
// maxDuration note below. For goals that need minutes of work,
// the right evolution is to enqueue the run (status 'queued') here and drain it
// from a background worker / the cron route; the executor is already
// queue-driven (runAgentRun just needs a runId), so that swap is localized to
// this handler.
//
// maxDuration = 300 matches lib/harness/executor.ts's MAX_RUN_MS (240s) plus
// headroom for the in-flight step to wind down, the finalize() write, and
// response serialization — graphs with loops/fan-out/replans need far more
// wall-clock than the original 55s-vs-60s budget allowed. If a run's own
// deadline fires with steps still to do, the executor PAUSES it instead of
// failing it: pending steps are left 'pending' (not marked 'skipped') and the
// run is written as 'incomplete' — see the RunStatus doc in
// lib/harness/types.ts — so app/api/harness/cron/route.ts's
// continueIncompleteRuns() can re-enter it later and finish the DAG, adopting
// every already-completed step's output instead of redoing it. Budget
// exhaustion is unaffected by any of this: it still marks remaining steps
// 'skipped' and the run terminal ('completed_with_errors'/'failed'), because
// there is no free "try again" there. A platform-level kill of the function
// itself (rare, but possible right at the 300s edge, and the one case the
// executor's own graceful deadline stop can't protect against) is recovered
// by lib/harness/executor.ts#reapStuckRuns — see the call below.
//
// HONEST STATUS: the JSON this handler returns is whatever runAgentRun's own
// finalize() computed (see lib/harness/executor.ts) — 'completed' is reserved
// for a run where nothing broke; any failed/skipped step, a budget abort, or
// a deadline pause reports 'completed_with_errors'/'failed'/'incomplete'
// instead. This handler never overrides or waters that down.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { runAgentRun, reapStuckRuns } from '@/lib/harness/executor'
import { CHAIN_NAMES, compileChain, describeChains, isChainName, type ChainName } from '@/lib/harness/chains'
import type { Plan } from '@/lib/harness/types'
import { logApiError } from '@/lib/observability/log'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const MIN_BUDGET = 1_000
const MAX_BUDGET = 1_000_000
const DEFAULT_BUDGET = 200_000

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  // REAP SOONER: app/api/harness/cron/route.ts's own reapStuckRuns call only
  // fires once a day (see .github/workflows/harness-cron.yml) — far too
  // infrequent for a run stuck since (say) 2026-07-25 to surface promptly.
  // app/api/harness/autopilot/route.ts ticks hourly and would be the more
  // frequent home for this, but it is explicitly out of scope for this
  // change (owned elsewhere) — so instead this route, which fires on every
  // real "start a new run" click from the Copilot UI (far more often per
  // active user than either cron), also reaps on the way in. reapStuckRuns is
  // a cheap, bounded, indexed scan that is a no-op on the common case (no
  // stuck rows), so this does not meaningfully slow down starting a run;
  // failures here must never block the run this request is actually here to
  // create.
  await reapStuckRuns(admin).catch((e) => {
    console.error('[harness run] reapStuckRuns failed', e)
  })

  let body: Record<string, unknown>
  try {
    body = ((await request.json()) ?? {}) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  let budgetTokens = DEFAULT_BUDGET
  if (typeof body.budgetTokens === 'number' && Number.isFinite(body.budgetTokens)) {
    budgetTokens = Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, Math.floor(body.budgetTokens)))
  }

  const hasGoal = typeof body.goal === 'string' && body.goal.trim().length > 0
  const hasChain = typeof body.chain === 'string' && body.chain.trim().length > 0
  if (hasGoal === hasChain) {
    return NextResponse.json(
      { error: 'Request must include exactly one of { goal } or { chain, params }' },
      { status: 400 }
    )
  }

  let goal: string
  let plan: Plan | null = null
  let chainName: ChainName | null = null

  if (hasChain) {
    const rawChain = (body.chain as string).trim()
    if (!isChainName(rawChain)) {
      return NextResponse.json(
        { error: `unknown chain "${rawChain}" — valid: ${CHAIN_NAMES.join(', ')}` },
        { status: 400 }
      )
    }
    try {
      plan = compileChain(rawChain, body.params ?? {})
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return NextResponse.json({ error: `invalid params for chain "${rawChain}": ${message}` }, { status: 400 })
    }
    chainName = rawChain
    goal = plan.goal
  } else {
    goal = (body.goal as string).trim()
    if (goal.length > 2000) return NextResponse.json({ error: 'goal too long (max 2000 chars)' }, { status: 400 })
  }

  const insertRow: Record<string, unknown> = { user_id: user.id, goal, status: 'queued', budget_tokens: budgetTokens }
  if (plan) insertRow.plan = plan

  const { data: run, error } = await admin.from('agent_runs').insert(insertRow).select('id').single()
  if (error || !run) {
    return NextResponse.json({ error: error?.message ?? 'Failed to create run' }, { status: 500 })
  }

  const runId = (run as { id: string }).id

  try {
    const outcome = await runAgentRun(admin, runId)
    return NextResponse.json({ ok: true, runId, chain: chainName, run: outcome })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // The executor already journals per-step failures (and reports them via
    // lib/observability/log.ts#logHarnessError); this catches hard setup
    // failures that never made it into a step at all. Best-effort mark the
    // run failed so it isn't left 'running'.
    logApiError('harness/run', e, { runId, chain: chainName })
    await admin
      .from('agent_runs')
      .update({ status: 'failed', error: message, finished_at: new Date().toISOString() })
      .eq('id', runId)
    return NextResponse.json({ ok: false, runId, chain: chainName, error: message }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)

  // ?chains=1 — introspection for whatever UI builds the "run a chain" form;
  // static metadata (no DB access needed), kept behind the same auth check as
  // everything else in this route for consistency, not because it's secret.
  if (searchParams.has('chains')) {
    return NextResponse.json({ chains: describeChains() })
  }

  const limit = Math.min(50, Math.max(1, Number(searchParams.get('limit')) || 20))
  const runId = searchParams.get('runId')

  const admin = createAdminClient()

  if (runId) {
    const { data: run } = await admin
      .from('agent_runs')
      .select('*')
      .eq('id', runId)
      .eq('user_id', user.id)
      .single()
    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 })
    const { data: steps } = await admin
      .from('agent_steps')
      .select('*')
      .eq('run_id', runId)
      .order('created_at', { ascending: true })
    return NextResponse.json({ run, steps: steps ?? [] })
  }

  const { data: runs, error } = await admin
    .from('agent_runs')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ runs: runs ?? [] })
}
