// POST /api/harness/run — create an agent_runs row and execute it. Accepts
// EITHER shape (exactly one, never both):
//   { goal: string, budgetTokens?: number }
//     — free-text goal; harnessRunGraph's own plannerTask (lib/graph/runs.ts,
//       wrapping lib/harness/planner.ts#planGoal) turns it into a DAG at run
//       start (unchanged from before this file's chain support).
//   { chain: ChainName, params: object, budgetTokens?: number }
//     — a named template from lib/harness/chains.ts compiled to a Plan HERE,
//       before the row is even inserted (see CHAINS in that file for the five
//       templates: apply-to-role, submit-confirmed, tailor-for-role,
//       warm-intro, source-until). The compiled Plan is written straight to
//       agent_runs.plan, so harnessRunGraph's own "plan already present"
//       branch (lib/graph/runs.ts, step 1) skips the LLM planner entirely —
//       cheaper and deterministic, and the only way submit-confirmed's safety
//       gate (confirmed:true) can be enforced: an LLM-authored plan can never
//       produce a submitting step, only compileChain() can, and only for that
//       one chain, and only when the caller passed the literal confirmed:true.
// GET  /api/harness/run — list the caller's recent runs (with their steps).
//
// EXECUTION MODEL / VERCEL TRADEOFF:
// We drive the DAG *synchronously inside this request*, through the ONE graph
// call site (lib/graph/invoke.ts#invokeGraphForUser — spec binding ruling 7),
// and return the finished run. This is the simplest model that is correct on
// Vercel serverless: no dropped background work, no dependence on `waitUntil`
// (which Next 14 route handlers don't expose without @vercel/functions), and
// the client gets the result in one round-trip when the run fits inside the
// function timeout. The cost is the same as before the graph port: a run must
// fit inside MAX_RUN_MS (lib/graph/runs.ts) — but hitting that deadline is no
// longer this route's problem to recover. harnessRunGraph itself PAUSES at a
// typed interrupt({kind:'deadline'}), LangGraph's checkpointer durably records
// exactly where, and app/api/harness/cron/route.ts's resume pass re-enters
// the SAME thread later via THE RESUME RULE — no continuation counter, no
// reaper: a killed-mid-invocation thread and a cleanly-paused one resume the
// identical way (invoke(null) against the checkpoint), so nothing here has to
// tell them apart. Budget exhaustion is unaffected: harnessRunGraph still
// marks remaining steps 'skipped' and returns a terminal outcome
// ('completed_with_errors'/'failed'), because there is no free "try again"
// for spent money.
//
// maxDuration = 300 matches lib/graph/runs.ts's MAX_RUN_MS (240s) plus
// headroom for the in-flight step to wind down, the graph's own finalize()
// write, and response serialization — graphs with loops/fan-out/replans need
// far more wall-clock than a single short deadline would allow.
//
// HONEST STATUS: on a terminal outcome, the JSON this handler returns is
// whatever harnessRunGraph's own finalize() computed — 'completed' is
// reserved for a run where nothing broke; any failed/skipped step or a budget
// abort reports 'completed_with_errors'/'failed' instead. On a deadline
// pause, there IS no outcome yet (the graph interrupted before reaching
// finalize()) — this handler reports `paused: true` honestly rather than
// inventing one. Neither path waters the truth down.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { invokeGraphForUser, type CompiledGraphLike } from '@/lib/graph/invoke'
import { harnessRunGraph, markRunPausedOnInterrupt, type RunOutcome } from '@/lib/graph/runs'
import { CHAIN_NAMES, compileChain, describeChains, isChainName, type ChainName } from '@/lib/harness/chains'
import type { Plan } from '@/lib/harness/types'
import { logApiError } from '@/lib/observability/log'
import { isJournaledStepRow, stepRowToAgentStepRow, type JournaledSpanRow } from '@/lib/graph/journal'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// harnessRunGraph (a real compiled LangGraph Pregel graph) has a NARROWER
// `invoke` input type than CompiledGraphLike's own `unknown` — the same
// structural gap lib/graph/invoke.langgraph.test.ts already casts around for
// a real compiled graph. invokeGraphForUser only ever calls `.invoke`/
// `.stream`/`.getState` with the config it builds itself, so this is a
// type-only gap, not a behavioral one.
const RUN_GRAPH = harnessRunGraph as unknown as CompiledGraphLike

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
    // No `threadId` — this always mints a fresh thread (invokeGraphForUser's
    // own "Omit to mint a fresh thread" contract); harnessRunGraph persists
    // it onto agent_runs.thread_id itself, at the top of its first pass (see
    // lib/graph/journal.ts#markRunRunning's doc for why that is the one
    // reliable place to do it, not here).
    const { result } = await invokeGraphForUser({
      admin,
      userId: user.id,
      surface: 'run',
      graph: RUN_GRAPH,
      input: { runId },
    })

    // A deadline interrupt: harnessRunGraph parked mid-DAG instead of
    // reaching finalize(), so there is no RunOutcome to report — `paused` is
    // an ADDITIVE field on the same {ok, runId, chain} shape the client
    // already reads (components/copilot/runs-panel.tsx polls the run row's
    // own `status` for the live picture; this response only needs to not
    // claim a finished run that isn't one).
    if (await markRunPausedOnInterrupt(admin, runId, result)) {
      return NextResponse.json({ ok: true, runId, chain: chainName, paused: true })
    }

    return NextResponse.json({ ok: true, runId, chain: chainName, run: result as RunOutcome })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // harnessRunGraph already journals per-step failures (and reports them via
    // lib/observability/log.ts#logHarnessError through runAgentUnit); this
    // catches hard setup failures that never made it into a step at all —
    // thread-ownership refusals, a bad connection to the checkpointer, etc.
    // Best-effort mark the run failed so it isn't left 'running'.
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
    // trace_spans, not agent_steps (binding ruling 1's endgame — see
    // lib/graph/journal.ts's header for why a kind='node' row here can
    // belong to EITHER this run's step ledger or lib/trace/spans.ts's own
    // observability span for the same unit call, and why isJournaledStepRow
    // is what tells them apart before mapping back to the pre-port shape
    // this route's callers (RunsPanel, GraphView) already read.
    const { data: spanRows } = await admin
      .from('trace_spans')
      .select('span_id, run_id, parent_span_id, name, kind, start_time, end_time, attributes')
      .eq('run_id', runId)
      .eq('kind', 'node')
      .order('start_time', { ascending: true })
    const steps = ((spanRows ?? []) as JournaledSpanRow[]).filter(isJournaledStepRow).map(stepRowToAgentStepRow)
    return NextResponse.json({ run, steps })
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
