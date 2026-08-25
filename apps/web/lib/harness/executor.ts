// Harness runtime — DAG executor.
//
// runAgentRun() drives one agent_runs row from planning through completion:
//   - plans the goal (if no plan yet) and journals a planner step; if a plan
//     is already stored (this is a RESUMPTION, see below), planning is
//     skipped entirely — re-planning a resumed run would be both wasteful and
//     non-deterministic
//   - journals an agent_steps row per plan step — but see RESUMPTION: a step
//     that already has a `completed` row from a prior attempt at this same
//     run is adopted, not re-run
//   - runs steps in waves: everything whose deps are satisfied goes in parallel
//   - meters LLM tokens against agent_runs.budget_tokens and aborts cleanly when
//     the budget is exhausted (in-flight LLM calls are cancelled via AbortSignal)
//   - retries failed steps with exponential backoff + jitter
//   - cascades 'skipped' to any step whose dependency failed/was skipped
//   - drives per-step LOOPS (re-run until a condition holds) and FAN-OUT
//     (spawn N parallel children over a dependency's list output) — see
//     ./dynamic.ts for the pure control-flow those two delegate to
//   - honors a step's mid-run REPLAN request by validating + appending new
//     steps to the live graph — see ./replan.ts
//   - transitions agent_runs.status: planning -> running ->
//     completed | completed_with_errors | incomplete | failed
//
// RESUMPTION: a run that hits its wall-clock deadline (see MAX_RUN_MS) mid-DAG
// is PAUSED (status 'incomplete'), not failed — steps that hadn't started yet
// are left `pending` in agent_steps rather than being marked `skipped`.
// app/api/harness/cron/route.ts re-enters runAgentRun for 'incomplete' runs
// (bounded — see MAX_CONTINUATIONS there). On that re-entry, step 2 below
// matches every plan step to its agent_steps row BY LABEL:
//   - `completed`                                 -> adopted: its stored
//     output is fed into the deps map for downstream steps, no LLM call spent
//   - `pending` / `running` / a `failed` row whose error is an artifact of
//     the deadline gate itself (see isDeadlineArtifactFailure) -> re-run
//   - a genuinely `failed` row (a real error, not a deadline artifact)
//     -> stays failed; its dependents cascade to `skipped` exactly as they
//     would within one uninterrupted run
// Budget exhaustion is handled differently and is NEVER resumable this way —
// see the RunStatus['incomplete'] doc in ./types.ts for why.
//
// Concurrency model: this executes synchronously inside the caller's request.
// See app/api/harness/run/route.ts for the Vercel-serverless tradeoff notes.
//
// reapStuckRuns() is a separate, unrelated entry point: a run that never
// reached a terminal state (server crashed / was killed mid-request, so
// finalize() below never ran) is reaped by a cron tick — see
// app/api/harness/cron/route.ts.

import { getAgent } from './registry'
import { agentSchemas, stripUntrustedSubmit } from './schemas'
import { planGoal } from './planner'
import { callLlm } from './llm'
import { loadApiKeys } from './keys'
import { applyReplan } from './replan'
import { logHarnessError } from '../observability/log'
import {
  runLoop,
  runFanOut,
  resolveFanOutItems,
  autoFillStepInput,
  isSchemaError,
  firstEmptyUpstreamReason,
  type LoopIterationResult,
  type FanOutChildResult,
} from './dynamic'
import {
  BudgetExceededError,
  type AdminClient,
  type AgentRunRow,
  type LlmResult,
  type LlmRunOptions,
  type Plan,
  type PlanStep,
  type ReplanRequest,
  type StepContext,
  type StepStatus,
} from './types'

/** Max steps run in parallel within a wave (also used to bound fan-out concurrency). */
const STEP_CONCURRENCY = 4
/** Retry budget per step attempt (attempts = 1 + MAX_RETRIES). */
const MAX_RETRIES = 2
const RETRY_BASE_MS = 400
/**
 * Stop scheduling new work past this wall-clock budget, leaving room to
 * finalize. Routes that call runAgentRun synchronously set `maxDuration = 300`
 * (Vercel's ceiling for this plan) — 240s leaves a 60s buffer for the
 * in-flight step to wind down, the finalize() write, and response
 * serialization. Previously 55_000ms against a 60s route budget; multi-step
 * runs with loops/fan-out need far more headroom than that.
 */
const MAX_RUN_MS = 240_000
/** Hard cap on accepted mid-run replan events per run (see ./replan.ts). */
const MAX_REPLAN_EVENTS = 5

type StepState = StepStatus

interface StepRecord {
  step: PlanStep
  id: string | null
  state: StepState
  tokens: number
  error?: string
  loopMeta?: { iterations: number; stopReason: string }
  fanOutMeta?: { total: number; completed: number; failed: number }
}

interface ReplanEvent {
  fromLabel: string
  accepted: boolean
  reason: string
  addedLabels: string[]
}

interface RunOutcome {
  runId: string
  status: AgentRunRow['status']
  spentTokens: number
  budgetTokens: number
  steps: {
    label: string
    agent_type: string
    status: StepState
    tokens_used: number
    error?: string
    loop?: { iterations: number; stopReason: string }
    fanOut?: { total: number; completed: number; failed: number }
  }[]
  outputs: Record<string, unknown>
  summary: { completed: number; failed: number; skipped: number }
  replanEvents: ReplanEvent[]
  aborted?: 'budget' | 'deadline'
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function isAbort(e: unknown): boolean {
  return e instanceof BudgetExceededError || (e instanceof Error && e.name === 'AbortError')
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Discriminated result of one full attempt (with retries) at running a step's
 *  agent_type once — used identically by the plain, loop-iteration, and
 *  fan-out-child dispatch paths below. */
type AttemptResult =
  | { status: 'completed'; output: unknown; tokens: number; replanRequest?: ReplanRequest }
  | { status: 'failed'; error: string; tokens: number }
  | { status: 'skipped'; reason: string; tokens: number }

/**
 * Execute the agent_runs row `runId` to completion. Idempotent-ish: expects a
 * queued/planning run; never throws for per-step failures (they are journaled).
 * Throws only for hard setup errors (run not found, DB unreachable).
 */
export async function runAgentRun(admin: AdminClient, runId: string): Promise<RunOutcome> {
  const { data: run, error } = await admin
    .from('agent_runs')
    .select('*')
    .eq('id', runId)
    .single()
  if (error || !run) throw new Error(`agent_run ${runId} not found: ${error?.message ?? 'no row'}`)

  const runRow = run as AgentRunRow
  const budget = runRow.budget_tokens ?? 200_000
  const apiKeys = await loadApiKeys(admin, runRow.user_id)

  const controller = new AbortController()
  const deadline = Date.now() + MAX_RUN_MS
  let spent = runRow.spent_tokens ?? 0
  let aborted: RunOutcome['aborted']
  const replanEvents: ReplanEvent[] = []
  let replanCounter = 0

  const updateRun = async (fields: Partial<AgentRunRow>) => {
    await admin.from('agent_runs').update(fields as Record<string, unknown>).eq('id', runId)
  }
  const bumpSpent = async () => {
    await updateRun({ spent_tokens: spent })
  }
  const isDeadlineHit = () => Date.now() >= deadline

  // 1) Planning ---------------------------------------------------------------
  await updateRun({ status: 'planning', started_at: runRow.started_at ?? new Date().toISOString() })

  let plan: Plan
  if (runRow.plan && Array.isArray(runRow.plan.steps) && runRow.plan.steps.length > 0) {
    plan = runRow.plan
  } else {
    const plannerStepId = await insertStep(admin, runId, 'planner', 'plan', { goal: runRow.goal })
    if (plannerStepId) await startStep(admin, plannerStepId)
    try {
      const result = await planGoal(runRow.goal, apiKeys, controller.signal)
      // SAFETY: planGoal() is an LLM turning free text into a JSON DAG.
      // PlanSchema's `input` field is deliberately untyped per agent_type (see
      // schemas.ts#stripUntrustedSubmit), so nothing else stops the model from
      // emitting an `applier` step with `autoSubmit:true`. This is the one
      // place an LLM-authored plan enters the executor — force-disable
      // autoSubmit on every applier step here, unconditionally, before the
      // plan is stored or a single step runs. The only path allowed to
      // produce a real submitting step is lib/harness/chains.ts#compileChain
      // (submit-confirmed), which writes agent_runs.plan directly and never
      // reaches this branch (see the "plan already present" check above).
      plan = { ...result.plan, steps: stripUntrustedSubmit(result.plan.steps) }
      spent += result.tokensUsed
      await updateRun({ plan: plan as unknown as AgentRunRow['plan'], spent_tokens: spent })
      if (plannerStepId) {
        await finishStep(admin, plannerStepId, 'completed', plan, result.tokensUsed)
      }
    } catch (e) {
      if (plannerStepId) await finishStep(admin, plannerStepId, 'failed', { error: errMsg(e) }, 0)
      logHarnessError({ runId, stepLabel: 'plan', agentType: 'planner', phase: 'plan', userId: runRow.user_id }, e)
      await updateRun({ status: 'failed', error: `planning failed: ${errMsg(e)}`, finished_at: new Date().toISOString() })
      throw e
    }
  }

  // 2) Journal every step, adopting any rows a PRIOR attempt at this run
  //    already left behind instead of blindly re-inserting (see the
  //    RESUMPTION note at the top of this file). On a run's first-ever
  //    attempt `existingSteps` is empty and every branch below falls through
  //    to the plain insertStep call — identical to the old unconditional
  //    behavior. -----------------------------------------------------------
  const outputs = new Map<string, unknown>()
  const existingSteps = await loadExistingSteps(admin, runId)

  const records: StepRecord[] = []
  const byLabel = new Map<string, StepRecord>()
  for (const step of plan.steps) {
    const existing = existingSteps.get(step.label)

    if (existing?.status === 'completed') {
      // Adopt: reuse the row untouched, feed its stored output to whatever
      // depends on it, spend nothing re-running it.
      const rec: StepRecord = { step, id: existing.id, state: 'completed', tokens: existing.tokens_used ?? 0 }
      records.push(rec)
      byLabel.set(step.label, rec)
      outputs.set(step.label, existing.output)
      continue
    }

    if (existing?.status === 'failed' && !isDeadlineArtifactFailure(extractErrorText(existing.output))) {
      // A genuine failure (not a deadline-gate artifact) from a prior
      // attempt: retrying it would fail the same way for the same reason, so
      // it stays terminal and its dependents cascade to 'skipped' below
      // exactly as they would have inside one uninterrupted run.
      const rec: StepRecord = {
        step,
        id: existing.id,
        state: 'failed',
        tokens: existing.tokens_used ?? 0,
        error: extractErrorText(existing.output),
      }
      records.push(rec)
      byLabel.set(step.label, rec)
      continue
    }

    // pending / running / a deadline-artifact failure / a cascade-skipped row
    // / no prior row at all: (re)run it. A `skipped` row is included here
    // deliberately, not treated as terminal like a genuine `failed` row is
    // above — cascade-skip (3a below) only means "this dependency hadn't
    // produced usable output AT THE TIME", which is exactly the situation a
    // deadline pause creates (e.g. build-drafts skipped because cv_tailor
    // hadn't finished yet). Resetting it to pending lets 3a/3c re-decide on
    // this attempt: if its dependency is retried and completes now, this step
    // finally runs for real instead of staying permanently skipped for a
    // reason that no longer applies.
    //
    // Reuse the existing row (reset to pending) rather than inserting a
    // fresh one, so a resumed run never leaves a duplicate agent_steps row
    // behind for the same label.
    const id = existing ? existing.id : await insertStep(admin, runId, step.agent_type, step.label, step.input ?? {})
    if (existing) await resetStepToPending(admin, existing.id)
    const rec: StepRecord = { step, id, state: 'pending', tokens: 0 }
    records.push(rec)
    byLabel.set(step.label, rec)
  }

  await updateRun({ status: 'running' })

  // 3) Wave scheduler ---------------------------------------------------------
  // Loop invariant: each pass either runs >=1 ready step, cascades >=1 skip, or
  // resolves the remaining pending steps (unsatisfiable/stuck) and breaks.
  // Steps appended mid-run by a replan (section 3e, below) simply join `records`
  // and get picked up by the very next pass like any other pending step.
  while (records.some((r) => r.state === 'pending')) {
    // 3a) Cascade skips: any pending step whose dep failed/was skipped/missing.
    let cascaded = false
    for (const rec of records) {
      if (rec.state !== 'pending') continue
      const blocked = rec.step.dependsOn.some((d) => {
        const dep = byLabel.get(d)
        return !dep || dep.state === 'failed' || dep.state === 'skipped'
      })
      if (blocked) {
        await markSkipped(admin, rec, 'dependency did not complete')
        cascaded = true
      }
    }

    // 3b) Budget / deadline gate. These two are handled DIFFERENTLY on
    // purpose — see the RunStatus['incomplete'] doc in ./types.ts:
    //   - budget exhausted: the user would have to spend more money to make
    //     progress, so there is no free "try again" — remaining pending
    //     steps are permanently 'skipped', same as always.
    //   - deadline hit: this is just a wall-clock ceiling on ONE HTTP
    //     request, not a real failure. Remaining pending steps are left
    //     exactly as they already are (agent_steps.status = 'pending') so
    //     app/api/harness/cron/route.ts can re-enter runAgentRun for this run
    //     later and actually finish them — see finalStatus below, which is
    //     what turns this into the resumable 'incomplete' status instead of
    //     'completed_with_errors'.
    if (spent >= budget || controller.signal.aborted) {
      aborted = aborted ?? 'budget'
    }
    if (isDeadlineHit()) {
      aborted = aborted ?? 'deadline'
    }
    if (aborted === 'budget') {
      for (const rec of records) {
        if (rec.state === 'pending') {
          await markSkipped(admin, rec, 'run stopped before this step could start (budget exhausted)')
        }
      }
      break
    }
    if (aborted === 'deadline') {
      break // leave remaining 'pending' steps untouched — see comment above
    }

    // 3c) Ready steps: pending with all deps completed.
    const ready = records.filter(
      (r) => r.state === 'pending' && r.step.dependsOn.every((d) => byLabel.get(d)?.state === 'completed')
    )

    if (ready.length === 0) {
      if (cascaded) continue // re-evaluate after cascading skips
      // No ready + no change: remaining pending steps are unsatisfiable (cycle).
      for (const rec of records) {
        if (rec.state === 'pending') await markSkipped(admin, rec, 'unsatisfiable dependencies (cycle?)')
      }
      break
    }

    // 3d) Run the ready wave with bounded concurrency.
    await mapWithConcurrency(ready, STEP_CONCURRENCY, (rec) => dispatchStep(rec))
  }

  // 4) Finalize ---------------------------------------------------------------
  const completed = records.filter((r) => r.state === 'completed').length
  const failed = records.filter((r) => r.state === 'failed').length
  const skipped = records.filter((r) => r.state === 'skipped').length
  const pendingRemaining = records.filter((r) => r.state === 'pending').length

  // HONEST STATUS: a run with ANY failed step, or one aborted on budget/deadline
  // before finishing its graph, must never report plain 'completed' just
  // because *something* succeeded. 'failed' is reserved for "nothing usable
  // came out of this run at all".
  //
  // DEADLINE MEANS PAUSED, NOT FAILED: `aborted === 'deadline'` can only be
  // true here when the 3b gate broke the wave scheduler with pending steps
  // still on the board (see that comment) — pendingRemaining is checked
  // anyway rather than assumed, so a deadline hit on the very last wave (no
  // work actually left undone) still reports 'completed'/'completed_with_errors'
  // like before instead of a pointless 'incomplete' with nothing to resume.
  let finalStatus: AgentRunRow['status']
  if (aborted === 'deadline' && pendingRemaining > 0) {
    finalStatus = 'incomplete'
  } else if (completed === 0) {
    finalStatus = 'failed'
  } else if (failed > 0 || aborted) {
    finalStatus = 'completed_with_errors'
  } else {
    finalStatus = 'completed'
  }

  const errorSummary =
    finalStatus === 'completed'
      ? null
      : finalStatus === 'failed'
        ? `run failed: 0 of ${records.length} step(s) completed (${failed} failed, ${skipped} skipped)`
        : finalStatus === 'incomplete'
          ? `run paused at the ${Math.round(MAX_RUN_MS / 1000)}s deadline: ${completed} of ${records.length} step(s) completed so far, ${pendingRemaining} still pending — will resume automatically`
          : `completed with errors: ${completed} completed, ${failed} failed, ${skipped} skipped` +
            (aborted ? ` (run aborted: ${aborted})` : '')

  const outcome: RunOutcome = {
    runId,
    status: finalStatus,
    spentTokens: spent,
    budgetTokens: budget,
    steps: records.map((r) => ({
      label: r.step.label,
      agent_type: r.step.agent_type,
      status: r.state,
      tokens_used: r.tokens,
      error: r.error,
      loop: r.loopMeta,
      fanOut: r.fanOutMeta,
    })),
    outputs: Object.fromEntries(outputs),
    summary: { completed, failed, skipped },
    replanEvents,
    aborted,
  }

  await updateRun({
    status: finalStatus,
    spent_tokens: spent,
    result: outcome as unknown as AgentRunRow['result'],
    error: errorSummary,
    finished_at: new Date().toISOString(),
  })

  return outcome

  // --- dispatch: plain step vs. loop vs. fan-out ----------------------------
  // (closures over admin/runId/controller/deadline/spent/budget/outputs/records)

  async function dispatchStep(rec: StepRecord): Promise<void> {
    const deps: Record<string, unknown> = {}
    for (const d of rec.step.dependsOn) deps[d] = outputs.get(d)

    if (rec.step.fanOut) return runFanOutStep(rec, deps)
    if (rec.step.loop) return runLoopStep(rec, deps)
    return runPlainStep(rec, deps)
  }

  async function runPlainStep(rec: StepRecord, deps: Record<string, unknown>): Promise<void> {
    rec.state = 'running'
    const result = await attemptOnce(rec.step, rec.id, deps)
    rec.tokens += result.tokens
    if (result.status === 'completed') {
      rec.state = 'completed'
      outputs.set(rec.step.label, result.output)
      if (result.replanRequest) await handleReplanRequest(rec.step.label, result.replanRequest)
    } else if (result.status === 'skipped') {
      rec.state = 'skipped'
      rec.error = result.reason
    } else {
      rec.state = 'failed'
      rec.error = result.error
    }
  }

  async function runLoopStep(rec: StepRecord, deps: Record<string, unknown>): Promise<void> {
    rec.state = 'running'
    const spec = rec.step.loop!
    // Plain object (not a bare `let`) so a mutation inside the runLoop callback
    // below is visible after `await runLoop(...)` returns — TS's control-flow
    // narrowing does not track reassignments of an outer `let` that happen only
    // inside a nested closure, but it does track property writes on an object.
    const last: { classification: StepState; error: string | undefined } = { classification: 'failed', error: undefined }

    const loopResult = await runLoop<unknown>(
      spec,
      async (iteration, previousOutput): Promise<LoopIterationResult<unknown>> => {
        if (controller.signal.aborted || isDeadlineHit()) {
          last.classification = 'failed'
          last.error = `run aborted (${aborted ?? 'deadline'})`
          return { status: 'failed', error: last.error }
        }
        const childLabel = `${rec.step.label}#${iteration}`
        const childId = await insertStep(admin, runId, rec.step.agent_type, childLabel, rec.step.input ?? {}, {
          parentStepId: rec.id,
          iteration,
        })
        const iterDeps = previousOutput !== null ? { ...deps, __previousIteration: previousOutput } : deps
        const attempt = await attemptOnce(rec.step, childId, iterDeps)
        last.classification = attempt.status
        if (attempt.status === 'completed') {
          return { status: 'completed', output: attempt.output, tokens: attempt.tokens }
        }
        last.error = attempt.status === 'skipped' ? attempt.reason : attempt.error
        return { status: 'failed', error: last.error, tokens: attempt.tokens }
      },
      { shouldAbort: () => controller.signal.aborted || isDeadlineHit() }
    )

    rec.tokens += loopResult.totalTokens
    rec.loopMeta = { iterations: loopResult.iterations, stopReason: loopResult.stopReason }

    if (loopResult.finalOutput !== null) {
      rec.state = 'completed'
      outputs.set(rec.step.label, loopResult.finalOutput)
      rec.error = loopResult.stopReason === 'condition-met' ? undefined : `loop stopped: ${loopResult.stopReason} after ${loopResult.iterations} iteration(s)`
    } else {
      rec.state = last.classification === 'skipped' ? 'skipped' : 'failed'
      rec.error = last.error ?? `loop failed on first iteration (${loopResult.stopReason})`
    }

    if (rec.id) {
      await finishStep(
        admin,
        rec.id,
        rec.state,
        rec.state === 'completed' ? loopResult.finalOutput : { error: rec.error, loop: rec.loopMeta },
        loopResult.totalTokens
      )
    }
    // A per-iteration retry-exhaustion already logged via attemptOnce's own
    // 'attempt' phase; this is the aggregate loop-level outcome, logged only
    // when it's a genuine failure (not 'skipped', which follows the same
    // empty-upstream contract as a plain step).
    if (rec.state === 'failed') {
      logHarnessError(
        { runId, stepLabel: rec.step.label, agentType: rec.step.agent_type, phase: 'loop', userId: runRow.user_id },
        new Error(rec.error ?? 'loop failed')
      )
    }
    await bumpSpent()
  }

  async function runFanOutStep(rec: StepRecord, deps: Record<string, unknown>): Promise<void> {
    rec.state = 'running'
    if (rec.id) await startStep(admin, rec.id)
    const spec = rec.step.fanOut!
    const { items, emptyReason } = resolveFanOutItems(spec, deps)

    if (emptyReason) {
      rec.state = 'skipped'
      rec.error = emptyReason
      rec.fanOutMeta = { total: 0, completed: 0, failed: 0 }
      if (rec.id) await finishStep(admin, rec.id, 'skipped', { skipped: emptyReason }, 0)
      return
    }

    const capped = items.slice(0, spec.maxChildren)
    const baseInput = (rec.step.input && typeof rec.step.input === 'object' ? rec.step.input : {}) as Record<string, unknown>

    const fanResult = await runFanOut<unknown>(capped, STEP_CONCURRENCY, async (item, index): Promise<FanOutChildResult<unknown>> => {
      if (controller.signal.aborted || isDeadlineHit()) {
        return { status: 'failed', error: `run aborted (${aborted ?? 'deadline'})` }
      }
      const iteration = index + 1
      const childLabel = `${rec.step.label}#${iteration}`
      const childInput = { ...baseInput, [spec.itemKey]: item }
      const childId = await insertStep(admin, runId, rec.step.agent_type, childLabel, childInput, {
        parentStepId: rec.id,
        iteration,
      })
      const attempt = await attemptOnce({ ...rec.step, input: childInput }, childId, deps)
      if (attempt.status === 'completed') return { status: 'completed', output: attempt.output, tokens: attempt.tokens }
      const childError = attempt.status === 'skipped' ? attempt.reason : attempt.error
      return { status: 'failed', error: childError, tokens: attempt.tokens }
    })

    rec.tokens += fanResult.totalTokens
    rec.fanOutMeta = { total: fanResult.total, completed: fanResult.completed, failed: fanResult.failed }

    const aggregateOutput = {
      fannedOut: fanResult.total,
      completed: fanResult.completed,
      failed: fanResult.failed,
      childLabels: capped.map((_, i) => `${rec.step.label}#${i + 1}`),
    }

    if (fanResult.completed > 0) {
      rec.state = 'completed'
      outputs.set(rec.step.label, aggregateOutput)
      rec.error = fanResult.failed > 0 ? `${fanResult.failed} of ${fanResult.total} fan-out children failed` : undefined
    } else {
      rec.state = 'failed'
      // Fold in an explicit "aborted" marker when every child died because
      // the run itself hit the deadline mid-flight (rather than a genuine
      // per-child failure) — RESUMPTION's isDeadlineArtifactFailure() checks
      // for exactly that word so a paused-then-continued run retries this
      // step instead of treating it as permanently broken. Checked directly
      // (not via the outer `aborted` closure var, which is only assigned
      // *between* waves — see 3b) since this wave may have started before
      // the deadline and only crossed it mid-dispatch.
      const deadlineHit = controller.signal.aborted || isDeadlineHit()
      rec.error = deadlineHit
        ? `all ${fanResult.total} fan-out children failed (run aborted: ${controller.signal.aborted ? 'budget' : 'deadline'})`
        : `all ${fanResult.total} fan-out children failed`
    }

    if (rec.id) {
      await finishStep(admin, rec.id, rec.state, rec.state === 'completed' ? aggregateOutput : { error: rec.error }, fanResult.totalTokens)
    }
    // Same "genuine failure only" filter as runLoopStep above — a
    // deadline/budget abort producing an all-children-failed aggregate is
    // expected control-flow, not a bug (RESUMPTION retries it), so it's
    // deliberately excluded from the noise.
    const deadlineArtifact = controller.signal.aborted || isDeadlineHit()
    if (rec.state === 'failed' && !deadlineArtifact) {
      logHarnessError(
        { runId, stepLabel: rec.step.label, agentType: rec.step.agent_type, phase: 'fan-out', userId: runRow.user_id },
        new Error(rec.error ?? 'fan-out failed')
      )
    }
    await bumpSpent()
  }

  // --- mid-run replan ---------------------------------------------------------

  async function handleReplanRequest(fromLabel: string, request: ReplanRequest): Promise<void> {
    if (replanCounter >= MAX_REPLAN_EVENTS) {
      await journalReplanEvent(fromLabel, false, `replan event cap reached (${MAX_REPLAN_EVENTS})`, [])
      return
    }
    const currentSteps = records.map((r) => r.step)
    const remainingBudgetTokens = budget - spent
    const outcome = applyReplan(currentSteps, request, { remainingBudgetTokens })
    if (!outcome.ok) {
      await journalReplanEvent(fromLabel, false, outcome.reason, [])
      return
    }
    for (const newStep of outcome.addedSteps) {
      const id = await insertStep(admin, runId, newStep.agent_type, newStep.label, newStep.input ?? {})
      const rec: StepRecord = { step: newStep, id, state: 'pending', tokens: 0 }
      records.push(rec)
      byLabel.set(newStep.label, rec)
    }
    plan.steps.push(...outcome.addedSteps)
    await updateRun({ plan: plan as unknown as AgentRunRow['plan'] })
    await journalReplanEvent(
      fromLabel,
      true,
      request.reason,
      outcome.addedSteps.map((s) => s.label)
    )
  }

  async function journalReplanEvent(fromLabel: string, accepted: boolean, reason: string, addedLabels: string[]): Promise<void> {
    replanCounter += 1
    replanEvents.push({ fromLabel, accepted, reason, addedLabels })
    const label = `__replan-${replanCounter}`
    const id = await insertStep(admin, runId, 'planner', label, { fromLabel, reason })
    if (id) {
      await startStep(admin, id)
      await finishStep(admin, id, accepted ? 'completed' : 'failed', { accepted, reason, addedLabels }, 0)
    }
  }

  // --- single-attempt agent execution (retries + empty-upstream guard) -----
  // Shared by the plain / loop-iteration / fan-out-child dispatch paths above.
  // Journals to `stepId` if given; never touches `outputs`/`records` — callers
  // decide what a completed/failed/skipped attempt means for their own state.

  async function attemptOnce(step: PlanStep, stepId: string | null, deps: Record<string, unknown>): Promise<AttemptResult> {
    if (stepId) await startStep(admin, stepId)

    const { input: assembledInput } = autoFillStepInput(step.agent_type, step.input, deps)
    const agent = getAgent(step.agent_type)
    let totalTokens = 0

    for (let attempt = 0; ; attempt++) {
      const meter = { used: 0 }
      const llm = async (opts: LlmRunOptions): Promise<LlmResult> => {
        if (controller.signal.aborted) throw new BudgetExceededError()
        const res = await callLlm(apiKeys, opts, controller.signal)
        meter.used += res.tokensUsed
        if (spent + totalTokens + meter.used > budget) {
          controller.abort()
          throw new BudgetExceededError()
        }
        return res
      }

      const ctx: StepContext = {
        userId: runRow.user_id,
        runId,
        stepLabel: step.label,
        agentType: step.agent_type,
        input: assembledInput,
        deps,
        admin,
        apiKeys,
        llm,
        signal: controller.signal,
      }

      try {
        if (controller.signal.aborted) throw new BudgetExceededError()
        const result = await agent(ctx)

        const schema = agentSchemas[step.agent_type].output
        const parsed = schema.safeParse(result.output)
        if (!parsed.success) {
          throw new Error(`output failed schema: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
        }

        const stepTokens = meter.used + (result.tokensUsed ?? 0)
        totalTokens += stepTokens
        spent += stepTokens
        if (stepId) await finishStep(admin, stepId, 'completed', parsed.data, totalTokens)
        await bumpSpent()
        return { status: 'completed', output: parsed.data, tokens: totalTokens, replanRequest: result.replanRequest }
      } catch (e) {
        totalTokens += meter.used
        spent += meter.used

        // EMPTY-INPUT CONTRACT: a schema-validation crash on this step's OWN
        // input, where a dependency legitimately produced nothing, is an
        // expected degrade — not a bug worth retrying (retrying can't fix a
        // permanently-empty upstream). Skip immediately with a clear reason
        // instead of exhausting retries on an unwinnable attempt.
        if (isSchemaError(e)) {
          const emptyDep = firstEmptyUpstreamReason(deps)
          if (emptyDep) {
            const reason = `upstream produced nothing: ${emptyDep}`
            if (stepId) await finishStep(admin, stepId, 'skipped', { skipped: reason }, totalTokens)
            await bumpSpent()
            return { status: 'skipped', reason, tokens: totalTokens }
          }
        }

        // Budget/abort: terminal, no retry, propagate abort to the scheduler.
        if (isAbort(e)) {
          const errorText = 'aborted (budget/cancelled)'
          if (stepId) await finishStep(admin, stepId, 'failed', { error: errorText }, totalTokens)
          await bumpSpent()
          return { status: 'failed', error: errorText, tokens: totalTokens }
        }
        if (attempt >= MAX_RETRIES) {
          const errorText = errMsg(e)
          if (stepId) await finishStep(admin, stepId, 'failed', { error: errorText }, totalTokens)
          // Only this branch is a genuine failure worth surfacing — the
          // isAbort() and deadline branches above/below are expected
          // control-flow (budget cap reached, run cancelled/paused), not
          // bugs, so they deliberately don't log here.
          logHarnessError(
            { runId, stepLabel: step.label, agentType: step.agent_type, phase: 'attempt', userId: runRow.user_id },
            e
          )
          await bumpSpent()
          return { status: 'failed', error: errorText, tokens: totalTokens }
        }
        // Exponential backoff + jitter before the next attempt.
        const backoff = RETRY_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 200)
        await sleep(backoff)
        if (controller.signal.aborted || isDeadlineHit()) {
          const errorText = 'aborted before retry'
          if (stepId) await finishStep(admin, stepId, 'failed', { error: errorText }, totalTokens)
          await bumpSpent()
          return { status: 'failed', error: errorText, tokens: totalTokens }
        }
      }
    }
  }
}

// --- stuck-run reaper --------------------------------------------------------

export interface ReapResult {
  reapedRunIds: string[]
  reapedStepIds: string[]
}

/**
 * Mark agent_runs rows stuck in a non-terminal status ('queued' | 'planning' |
 * 'running') for longer than `thresholdMs` as 'failed' with a clear timeout
 * reason, and skip any of their agent_steps rows still 'pending'/'running' so
 * the per-step journal stays consistent. This is the recovery path for a run
 * whose serverless invocation was killed mid-request (crash / cold OOM /
 * platform timeout) before runAgentRun's own finalize() ever got to write a
 * terminal status — runAgentRun's own MAX_RUN_MS deadline only protects runs
 * that are still alive to observe it.
 *
 * Callable from a cron tick (see app/api/harness/cron/route.ts) — cheap
 * (bounded row scan) and safe to call on every tick.
 */
export async function reapStuckRuns(admin: AdminClient, opts?: { thresholdMs?: number }): Promise<ReapResult> {
  const thresholdMs = opts?.thresholdMs ?? 15 * 60 * 1000
  const cutoff = new Date(Date.now() - thresholdMs).toISOString()

  const { data: stuckRuns, error } = await admin
    .from('agent_runs')
    .select('id, status, started_at, created_at')
    .in('status', ['queued', 'planning', 'running'])
    .lt('created_at', cutoff)
  if (error) {
    console.error('[harness] reapStuckRuns: query failed', error)
    return { reapedRunIds: [], reapedStepIds: [] }
  }

  const rows = (stuckRuns ?? []) as { id: string; status: string; started_at: string | null; created_at: string }[]
  // created_at < cutoff is the fetch filter (works for 'queued' rows too,
  // which have no started_at); for planning/running rows that DID start,
  // require started_at itself to be past the threshold too, so a run that was
  // created long ago but only just started (e.g. it sat in a batch queue) is
  // not reaped out from under an in-flight attempt.
  const reapable = rows.filter((r) => !r.started_at || r.started_at < cutoff)

  const reapedRunIds: string[] = []
  const reapedStepIds: string[] = []

  for (const run of reapable) {
    const { error: updErr } = await admin
      .from('agent_runs')
      .update({
        status: 'failed',
        error: `reaped: run stayed '${run.status}' past ${Math.round(thresholdMs / 60000)}m without reaching a terminal state (likely the serverless invocation was killed mid-run)`,
        finished_at: new Date().toISOString(),
      })
      .eq('id', run.id)
      .in('status', ['queued', 'planning', 'running']) // don't clobber a run that finished between our select and update
    if (updErr) {
      console.error(`[harness] reapStuckRuns: failed to fail run ${run.id}`, updErr)
      continue
    }
    reapedRunIds.push(run.id)

    const { data: staleSteps } = await admin
      .from('agent_steps')
      .select('id')
      .eq('run_id', run.id)
      .in('status', ['pending', 'running'])
    const staleIds = ((staleSteps ?? []) as { id: string }[]).map((s) => s.id)
    if (staleIds.length > 0) {
      await admin
        .from('agent_steps')
        .update({ status: 'skipped', output: { skipped: 'deadline: parent run was reaped as stuck' }, finished_at: new Date().toISOString() })
        .in('id', staleIds)
      reapedStepIds.push(...staleIds)
    }
  }

  return { reapedRunIds, reapedStepIds }
}

// --- agent_steps journaling helpers -----------------------------------------

async function insertStep(
  admin: AdminClient,
  runId: string,
  agentType: string,
  label: string,
  input: unknown,
  opts?: { parentStepId?: string | null; iteration?: number | null }
): Promise<string | null> {
  const row: Record<string, unknown> = { run_id: runId, agent_type: agentType, label, status: 'pending', input }
  if (opts?.parentStepId) row.parent_step_id = opts.parentStepId
  if (opts?.iteration !== undefined && opts.iteration !== null) row.iteration = opts.iteration
  const { data, error } = await admin.from('agent_steps').insert(row).select('id').single()
  if (error) {
    console.error(`[harness] failed to insert step ${label}: ${error.message}`)
    return null
  }
  return (data as { id: string }).id
}

/**
 * Row shape read back for RESUMPTION matching — see step 2 of runAgentRun.
 * Deliberately a small projection (not the full AgentStepRow): resumption
 * only ever needs to decide adopt-vs-rerun, never anything else about a row.
 */
interface ExistingStepRow {
  id: string
  status: StepStatus
  output: unknown
  tokens_used: number | null
}

/**
 * Every top-level plan-step row (parent_step_id IS NULL — loop iterations and
 * fan-out children are never matched by a plan step's own label, so they're
 * excluded outright) already journaled for `runId`, keyed by label. Empty on
 * a run's first attempt; populated on a resumption re-entry. PlanSchema
 * rejects duplicate labels (see schemas.ts), so this is a safe 1:1 map.
 */
async function loadExistingSteps(admin: AdminClient, runId: string): Promise<Map<string, ExistingStepRow>> {
  const { data, error } = await admin
    .from('agent_steps')
    .select('id, label, status, output, tokens_used')
    .eq('run_id', runId)
    .is('parent_step_id', null)
  if (error) {
    console.error(`[harness] loadExistingSteps: query failed for run ${runId}`, error)
    return new Map()
  }
  const map = new Map<string, ExistingStepRow>()
  for (const row of (data ?? []) as (ExistingStepRow & { label: string })[]) {
    map.set(row.label, { id: row.id, status: row.status, output: row.output, tokens_used: row.tokens_used })
  }
  return map
}

/** Every finishStep('failed', ...) call in this file journals `{ error: string }`. */
function extractErrorText(output: unknown): string | undefined {
  if (output && typeof output === 'object' && 'error' in output) {
    const e = (output as { error?: unknown }).error
    return typeof e === 'string' ? e : undefined
  }
  return undefined
}

/**
 * True when a `failed` step's error was produced by the deadline gate itself
 * — attemptOnce bailing mid-backoff-wait ('aborted before retry'), a loop
 * iteration or fan-out child declining to even start ('run aborted
 * (deadline)'), or the fan-out aggregate's explicit marker (see
 * runFanOutStep) — rather than a genuine failure in the agent's own logic.
 * RESUMPTION (step 2 of runAgentRun) only re-runs THIS kind of failure on a
 * continuation; a real error (bad output schema, thrown exception, exhausted
 * MAX_RETRIES well before the deadline) would fail again for the identical
 * reason, so it is left `failed` and its dependents keep cascading to
 * `skipped`, same as inside one uninterrupted run.
 */
function isDeadlineArtifactFailure(error: string | undefined): boolean {
  if (!error) return false
  return /\baborted\b/i.test(error)
}

/**
 * Reset a step's row to a clean 'pending' state so RESUMPTION can re-run it
 * without leaving a duplicate agent_steps row behind for the same label.
 */
async function resetStepToPending(admin: AdminClient, stepId: string): Promise<void> {
  await admin
    .from('agent_steps')
    .update({ status: 'pending', output: null, tokens_used: 0, started_at: null, finished_at: null })
    .eq('id', stepId)
}

async function startStep(admin: AdminClient, stepId: string): Promise<void> {
  await admin
    .from('agent_steps')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', stepId)
}

async function finishStep(
  admin: AdminClient,
  stepId: string,
  status: StepStatus,
  output: unknown,
  tokensUsed: number
): Promise<void> {
  await admin
    .from('agent_steps')
    .update({ status, output, tokens_used: tokensUsed, finished_at: new Date().toISOString() })
    .eq('id', stepId)
}

async function markSkipped(admin: AdminClient, rec: StepRecord, reason: string): Promise<void> {
  rec.state = 'skipped'
  rec.error = reason
  if (rec.id) {
    await admin
      .from('agent_steps')
      .update({ status: 'skipped', output: { skipped: reason }, finished_at: new Date().toISOString() })
      .eq('id', rec.id)
  }
}

/** Bounded-concurrency map, order-preserving (mirrors lib/ats mapWithConcurrency). */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}
