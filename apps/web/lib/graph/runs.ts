// The harness run entrypoint — LangGraph Functional API port of
// lib/harness/executor.ts#runAgentRun (docs/superpowers/specs/2026-08-16-
// langgraph-port-design.md, Stage 1's "harnessRun" build brief). Read
// lib/harness/executor.ts IN FULL before touching this file — the wave loop,
// cascade-skip, budget/deadline gate, RESUMPTION and dispatch below are a
// direct behavioral port of that file's §1-4, adapted to a checkpointed graph.
//
// INPUT IS JUST {runId}. Exactly like runAgentRun(admin, runId), goal, plan
// (already compiled, for a chain), budget_tokens and user_id all come from
// the agent_runs row itself — re-read FRESH at the top of every invocation
// attempt (including a resumed one). Nothing about that row is threaded
// through the checkpoint: the row is the single source of truth, so a fresh
// read can never drift from what the route already wrote before calling
// invokeGraphForUser. A chain-compiled plan (lib/harness/chains.ts#
// compileChain) enters this graph exactly like it entered runAgentRun: by
// already being present on agent_runs.plan when this graph is invoked, which
// makes the "1) Planning" section below skip plannerTask entirely.
//
// TASK IDENTITY / DETERMINISM (verified against @langchain/langgraph 1.4.10's
// dist — see node_modules/.../pregel/algo.js#_prepareSingleTask and
// pregel/runner.js#call): a task call's checkpoint id is
// uuid5([checkpointNamespace, step, call.name, PUSH, cnt, call], checkpoint.id)
// where `cnt` is a per-entrypoint-execution call COUNTER (scratchpad.
// callCounter++), not a hash of the call's arguments. So two things make a
// task call's identity stable across a killed-and-resumed run: (a) `call.name`
// — this is why makeUnitTask() below builds one task PER STEP LABEL
// (`unit:${label}`, and `unit:${label}#${n}` per loop iteration / fan-out
// child) rather than one shared "unit" task reused for every step — and
// (b) call ORDER, which only stays stable if the entrypoint body is a
// deterministic function of prior task results. It is: every branch below
// (cascade-skip, the ready-set, budget/deadline, dispatch order) is computed
// purely from `records`/`byLabel`, which are themselves rebuilt each
// execution purely from `plan` (fixed, read once from the DB row) and
// `unitTask`/`plannerTask` RESULTS (memoized — a killed-and-resumed run
// replays this whole function from the top, and every task call for an
// already-completed step resolves instantly from the checkpoint instead of
// re-executing, which is exactly what reconstructs `records`' state on
// resume — there is no separate "recover state from the DB" step here, the
// replay IS the recovery). Nothing here reads Date.now()/Math.random() to
// decide CONTROL FLOW (only to decide the outer deadline/backoff, and both of
// those are read fresh every attempt on purpose — see RESUME below), so two
// executions given the same task results always make the same calls in the
// same order.
//
// RESUME: budget vs. deadline, structurally (no error-string sniffing).
//   BUDGET exhausted -> a terminal return. `spent` is recomputed from 0 on
//   EVERY execution (deliberately never seeded from agent_runs.spent_tokens —
//   see "1) Planning" below for why: seeding from the DB and then re-adding
//   memoized steps' tokens on replay would double-count them). Once spent
//   reaches budget, every remaining pending step is marked 'skipped' and the
//   function returns a terminal RunOutcome — the thread ends, there is
//   nothing to resume, exactly like runAgentRun's budget path.
//
//   DEADLINE hit -> interrupt({kind:'deadline', ...}). `deadline` is
//   Date.now() + MAX_RUN_MS computed ONCE at the top of THIS execution
//   attempt — fresh every time, never persisted. interrupt() throws
//   (GraphInterrupt) when no resume value is available, which is always true
//   here: this design never expects or consumes interrupt()'s return value —
//   see THE RESUME RULE below. Verified against a real MemorySaver
//   (node ./lg-experiment*.mjs during development, not committed): calling
//   invoke(null, config) against a thread parked at this interrupt() re-runs
//   this function from the top; already-completed steps resolve instantly
//   (memoized); `deadline` is recomputed fresh, so the SAME `if
//   (Date.now() >= deadline)` check that fired last time is now false (unless
//   real time has ALSO elapsed past the fresh deadline, which just means the
//   run pauses again — a legitimate second pause, not a bug); the loop
//   proceeds to dispatch whatever is left. THE RESUME RULE (verified on real
//   Supabase, lib/graph/invoke.ts's SPIKE_FINDINGS): invoke(null) for any
//   existing thread without a human value — safe for killed-mid-task,
//   parked-at-interrupt, and completed threads alike; Command({resume}) only
//   delivers a HUMAN answer, and a deadline pause has no human waiting on it,
//   so invoke(null) is the only correct way to resume one.
//
// JOURNAL WRITES: through lib/graph/journal.ts upserts only (idempotent under
// replay — see journal.ts's own header). agent_runs status transitions:
// running is written here (markRunRunning, idempotent, redone harmlessly on
// every replay), which is ALSO where agent_runs.thread_id gets persisted (same
// call, same update) — see markRunRunning's own doc for why this is the one
// place that reliably captures it instead of a write attempted by the calling
// route after invokeGraphForUser resolves. Terminal states are written here
// too (markRunTerminal).
// 'paused' is NOT written here: interrupt() throws, unwinding this function
// before any code after it could run, so nothing sequential inside this body
// can ever observe "I just paused" to write that transition. It has to be
// written by whoever CATCHES the interrupt outside the graph — see
// markRunPausedOnInterrupt() at the bottom of this file, which inspects
// exactly what invokeGraphForUser's `result` looks like on that path
// (`{ __interrupt__: Interrupt[] }`, verified against the same real
// MemorySaver experiment above) and is meant to be called by the future
// route/invoke-layer caller right after invokeGraphForUser resolves.
//
// LOOP / FAN-OUT: reuses lib/harness/dynamic.ts's PURE helpers
// (evalLoopCondition, resolveFanOutItems, firstEmptyUpstreamReason,
// autoFillStepInput, isSchemaError, sameValue) — the runLoop/runFanOut
// DRIVERS are gone (deleted from dynamic.ts, unused since this entrypoint
// landed); the while-loop and bounded fan-out below are plain TypeScript in
// this entrypoint body instead, per the build brief.
import { entrypoint, interrupt, task } from '@langchain/langgraph'
import type { BaseCheckpointSaver, LangGraphRunnableConfig } from '@langchain/langgraph'

import { mapWithConcurrency } from '../ats/concurrency'
import {
  autoFillStepInput,
  evalLoopCondition,
  firstEmptyUpstreamReason,
  getByPath,
  isSchemaError,
  resolveFanOutItems,
  sameValue,
} from '../harness/dynamic'
import { loadApiKeys } from '../harness/keys'
import { planGoal } from '../harness/planner'
import { applyReplan } from '../harness/replan'
import { stripUntrustedSubmit } from '../harness/schemas'
import { BudgetCapError } from '../harness/spend'
import { createAdminClient } from '../harness/supabase-admin'
import { BudgetExceededError } from '../harness/types'
import type { AdminClient, AgentRunRow, Plan, PlanStep, ReplanRequest, StepStatus, UnitType } from '../harness/types'
import { journalStepFinish, journalStepOutput, journalStepStart, markRunRunning, markRunTerminal } from './journal'
import { runAgentUnit, type UnitConfig } from './unit'

// Mirrors lib/harness/executor.ts's own constants exactly. Not imported from
// there — lib/graph/journal.ts set the precedent (see its header) of keeping
// the graph port's own small, fresh copies rather than a dependency on a file
// stage 1C deletes.
const STEP_CONCURRENCY = 4
const MAX_RETRIES = 2
const RETRY_BASE_MS = 400
/** Same soft wall-clock ceiling as executor.ts's MAX_RUN_MS — see this file's
 *  header RESUME section for why it is recomputed fresh every attempt. */
const MAX_RUN_MS = 240_000
const MAX_REPLAN_EVENTS = 5

export class RunOwnershipError extends Error {
  readonly runId: string
  constructor(runId: string) {
    super(`agent_run ${runId} does not belong to the requesting user.`)
    this.name = 'RunOwnershipError'
    this.runId = runId
  }
}

export interface HarnessRunInput {
  /** The agent_runs.id row to execute. See this file's header for why this
   *  is the ONLY input field. */
  runId: string
}

export interface RunStepSummary {
  label: string
  agent_type: string
  status: StepStatus
  tokens_used: number
  error?: string
  loop?: { iterations: number; stopReason: string }
  fanOut?: { total: number; completed: number; failed: number }
}

export interface ReplanEventSummary {
  fromLabel: string
  accepted: boolean
  reason: string
  addedLabels: string[]
}

export interface RunOutcome {
  runId: string
  status: AgentRunRow['status']
  spentTokens: number
  budgetTokens: number
  steps: RunStepSummary[]
  outputs: Record<string, unknown>
  summary: { completed: number; failed: number; skipped: number }
  replanEvents: ReplanEventSummary[]
  /** Only 'budget' ever appears in a TERMINAL outcome — a deadline abort
   *  always interrupts (resumable) instead of reaching finalize(). */
  aborted?: 'budget'
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function isBudgetError(e: unknown): boolean {
  return e instanceof BudgetExceededError || e instanceof BudgetCapError
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

type StepState = StepStatus

interface StepRecord {
  step: PlanStep
  state: StepState
  tokens: number
  error?: string
  loopMeta?: { iterations: number; stopReason: string }
  fanOutMeta?: { total: number; completed: number; failed: number }
}

/** Discriminated result of one full attempt (with retries) at a step's
 *  agent_type — the graph-port analog of executor.ts's AttemptResult. */
type AttemptResult =
  | { status: 'completed'; output: unknown; tokens: number; replanRequest?: ReplanRequest }
  | { status: 'failed'; error: string; tokens: number }
  | { status: 'skipped'; reason: string; tokens: number }

// --- planner task ------------------------------------------------------------
//
// One shared task (module scope, fixed name 'planner') — a run plans at most
// once, so there is no per-label naming need the way unit steps have.

interface PlannerTaskArgs {
  domainRunId: string
  goal: string
  userId: string
}

const plannerTask = task('planner', async (args: PlannerTaskArgs): Promise<{ plan: Plan; tokensUsed: number }> => {
  const admin = createAdminClient()
  const { domainRunId, goal, userId } = args
  await journalStepStart(admin, { runId: domainRunId, label: 'planner', agentType: 'planner', input: { goal } })
  try {
    const apiKeys = await loadApiKeys(admin, userId)
    const result = await planGoal(goal, apiKeys)
    // SAFETY (spec invariant 2 / lib/harness/schemas.ts#stripUntrustedSubmit's
    // own header): this is the ONE place an LLM-authored plan enters this
    // graph. Runs IMMEDIATELY on planGoal's output, before the plan is
    // returned to the entrypoint body (let alone persisted or executed) —
    // pinned by lib/graph/graph-chokepoints.test.ts's source-adjacency scan.
    const plan: Plan = { ...result.plan, steps: stripUntrustedSubmit(result.plan.steps) }
    await journalStepFinish(admin, {
      runId: domainRunId,
      label: 'planner',
      agentType: 'planner',
      status: 'completed',
      output: plan,
      tokensUsed: result.tokensUsed,
    })
    return { plan, tokensUsed: result.tokensUsed }
  } catch (err) {
    await journalStepFinish(admin, {
      runId: domainRunId,
      label: 'planner',
      agentType: 'planner',
      status: 'failed',
      output: { error: errMsg(err) },
      tokensUsed: 0,
    })
    throw err
  }
})

// --- unit task -----------------------------------------------------------
//
// One task PER STEP LABEL (see this file's header on why) — makeUnitTask is
// a factory called fresh inside the entrypoint body for each label a wave
// dispatches, not a single module-level task. Retries (MAX_RETRIES, backoff)
// live INSIDE the task, mirroring executor.ts#attemptOnce's own retry loop:
// each retry attempt is a plain in-task loop iteration, not a separate task
// call, so a step's retry cycle is atomic within one invocation attempt
// rather than resumable mid-backoff — a deliberate simplification (deadline
// enforcement is a WAVE-boundary concern here, not a per-retry one; see the
// header). ponytail: if a step's own retry cycle ever needs to survive a
// mid-backoff deadline pause, the upgrade path is threading a soft-deadline
// argument into this task and returning 'skipped'/'failed' early instead of
// sleeping through it.

interface UnitTaskArgs {
  unitType: UnitType
  input: unknown
  unitConfig: UnitConfig
  deps: Record<string, unknown>
}

function makeUnitTask(taskLabel: string) {
  return task({ name: `unit:${taskLabel}` }, async (args: UnitTaskArgs): Promise<AttemptResult> => {
    const admin = createAdminClient()
    const { unitType, input, unitConfig, deps } = args
    const domainRunId = unitConfig.configurable.runId

    for (let attempt = 0; ; attempt++) {
      try {
        const result = await runAgentUnit(unitType, { input, admin, config: unitConfig, deps, label: taskLabel })
        return { status: 'completed', output: result.output, tokens: result.tokensUsed, replanRequest: result.replanRequest }
      } catch (err) {
        // Budget/cap errors: terminal for this step, never retried.
        if (isBudgetError(err)) {
          return { status: 'failed', error: errMsg(err), tokens: 0 }
        }

        // EMPTY-INPUT CONTRACT (mirrors executor.ts#attemptOnce exactly): a
        // schema-validation crash on this step's OWN input, where a
        // dependency legitimately produced nothing, is an expected degrade —
        // skip immediately with a clear reason rather than exhaust retries on
        // an unwinnable attempt. unit.ts's OWN input-parse throws BEFORE it
        // ever calls journalStepStart for this attempt (see unit.ts's
        // header), so this attempt has no row yet; journalStepFinish upserts
        // (insert-if-absent), so writing here still leaves a complete,
        // queryable row instead of a silent gap. A ZodError NOT correlated
        // with an empty upstream falls through to the generic retry/fail path
        // below instead — unit.ts's own catch already journaled the common
        // case (its output.parse also throws ZodError, but AFTER
        // journalStepStart ran).
        if (isSchemaError(err)) {
          const emptyDep = firstEmptyUpstreamReason(deps)
          if (emptyDep) {
            const reason = `upstream produced nothing: ${emptyDep}`
            await journalStepFinish(admin, {
              runId: domainRunId,
              label: taskLabel,
              agentType: unitType,
              status: 'skipped',
              output: { skipped: reason },
              tokensUsed: 0,
            })
            return { status: 'skipped', reason, tokens: 0 }
          }
        }

        if (attempt >= MAX_RETRIES) {
          return { status: 'failed', error: errMsg(err), tokens: 0 }
        }
        await sleep(RETRY_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 200))
      }
    }
  })
}

// --- the entrypoint ------------------------------------------------------

export const harnessRunGraph = entrypoint(
  {
    name: 'harnessRun',
    // `true` defers the checkpointer to a per-call override — invoke.ts's
    // module-singleton design (see lib/graph/invoke.ts's PREGEL_CHECKPOINTER_KEY
    // comment). EntrypointOptions.checkpointer is typed BaseCheckpointSaver
    // only (narrower than Pregel's own `BaseCheckpointSaver | boolean`, which
    // is what actually executes this at runtime — entrypoint() just forwards
    // it straight to `new Pregel({checkpointer, ...})`, verified via
    // node_modules/.../func/index.cjs and .../pregel/index.js — so the cast
    // is a type-only gap, not a behavioral one; the same `checkpointer: true`
    // + per-call configurable override was verified end-to-end against a real
    // MemorySaver during development (see this file's header RESUME note).
    checkpointer: true as unknown as BaseCheckpointSaver,
  },
  async (input: HarnessRunInput, config: LangGraphRunnableConfig): Promise<RunOutcome> => {
    const domainRunId = input.runId
    const invokerUserId = config.configurable?.userId
    const threadId = config.configurable?.threadId
    if (typeof invokerUserId !== 'string' || !invokerUserId) {
      throw new Error('harnessRun: config.configurable.userId is required — see lib/graph/invoke.ts#invokeGraphForUser')
    }
    if (typeof threadId !== 'string' || !threadId) {
      throw new Error('harnessRun: config.configurable.threadId is required — see lib/graph/invoke.ts#invokeGraphForUser')
    }

    const admin: AdminClient = createAdminClient()

    const { data: runRowRaw, error: runFetchError } = await admin
      .from('agent_runs')
      .select('*')
      .eq('id', domainRunId)
      .single()
    if (runFetchError || !runRowRaw) {
      throw new Error(`harnessRun: agent_run ${domainRunId} not found: ${runFetchError?.message ?? 'no row'}`)
    }
    const runRow = runRowRaw as AgentRunRow

    // Anti-IDOR, defense-in-depth: invokeGraphForUser already verified the
    // CALLING user owns the graph THREAD (graph_threads.user_id) — a
    // different row from the domain agent_runs row this input names. Nothing
    // enforces those two match structurally, so check it explicitly rather
    // than trust a caller-supplied runId.
    if (runRow.user_id !== invokerUserId) {
      throw new RunOwnershipError(domainRunId)
    }

    await markRunRunning(admin, domainRunId, runRow.started_at ?? new Date().toISOString(), threadId)

    const budget = runRow.budget_tokens ?? 200_000
    // Recomputed from 0 every execution attempt — NEVER seeded from
    // runRow.spent_tokens. See this file's header ("TASK IDENTITY /
    // DETERMINISM") on why replay reconstructs `records` state by re-walking
    // the DAG and letting memoized task calls resolve instantly: that same
    // replay would double-count an already-completed step's tokens if `spent`
    // started from a DB value that already includes them. Every step's real
    // cost is recoverable from its (memoized-or-fresh) task result, so
    // summing fresh here is both simpler and immune to double-counting.
    let spent = 0
    let aborted: RunOutcome['aborted']
    const replanEvents: ReplanEventSummary[] = []
    let replanCounter = 0
    // Fresh every invocation attempt — see header RESUME.
    const deadline = Date.now() + MAX_RUN_MS

    // 1) Planning ------------------------------------------------------------
    let plan: Plan
    if (runRow.plan && Array.isArray(runRow.plan.steps) && runRow.plan.steps.length > 0) {
      // Chain-compiled (or already-planned on a resumed run): BYPASSES
      // plannerTask entirely, exactly like runAgentRun's own "plan already
      // present" branch.
      plan = runRow.plan
    } else {
      const planResult = await plannerTask({ domainRunId, goal: runRow.goal, userId: runRow.user_id })
      plan = planResult.plan
      spent += planResult.tokensUsed
      await admin.from('agent_runs').update({ plan: plan as unknown as AgentRunRow['plan'] }).eq('id', domainRunId)
    }

    // 2) records ---------------------------------------------------------------
    const outputs = new Map<string, unknown>()
    const records: StepRecord[] = plan.steps.map((step) => ({ step, state: 'pending' as StepState, tokens: 0 }))
    const byLabel = new Map(records.map((r) => [r.step.label, r]))

    const unitConfigBase: UnitConfig = {
      configurable: { userId: runRow.user_id, runId: domainRunId, threadId },
    }

    const isDeadlineHit = (): boolean => Date.now() >= deadline

    async function markSkipped(rec: StepRecord, reason: string): Promise<void> {
      rec.state = 'skipped'
      rec.error = reason
      await journalStepFinish(admin, {
        runId: domainRunId,
        label: rec.step.label,
        agentType: rec.step.agent_type,
        status: 'skipped',
        output: { skipped: reason },
        tokensUsed: 0,
      })
    }

    function depsFor(step: PlanStep): Record<string, unknown> {
      const deps: Record<string, unknown> = {}
      for (const d of step.dependsOn) deps[d] = outputs.get(d)
      return deps
    }

    // --- dispatch: plain step vs. loop vs. fan-out ---------------------------

    async function dispatchStep(rec: StepRecord): Promise<void> {
      if (rec.step.fanOut) return runFanOutStep(rec)
      if (rec.step.loop) return runLoopStep(rec)
      return runPlainStep(rec)
    }

    async function runPlainStep(rec: StepRecord): Promise<void> {
      const deps = depsFor(rec.step)
      const { input: assembledInput } = autoFillStepInput(rec.step.agent_type, rec.step.input, deps)
      const unitTaskFn = makeUnitTask(rec.step.label)
      const result = await unitTaskFn({ unitType: rec.step.agent_type, input: assembledInput, unitConfig: unitConfigBase, deps })
      rec.tokens += result.tokens
      spent += result.tokens
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

    async function runLoopStep(rec: StepRecord): Promise<void> {
      const deps = depsFor(rec.step)
      const spec = rec.step.loop!

      // Own label journaled up front (status:'running', the step's declared
      // input) so the row exists — and carries `input` — the instant this
      // step is dispatched, matching what runPlainStep gets for free via
      // runAgentUnit's own journalStepStart call for its (single) label.
      // Mirrors executor.ts's insertStep, which wrote `step.input ?? {}` for
      // every plan step, loop/fan-out parents included, before any wave ran.
      await journalStepStart(admin, {
        runId: domainRunId,
        label: rec.step.label,
        agentType: rec.step.agent_type,
        input: rec.step.input ?? {},
      })

      let iteration = 0
      let finalOutput: unknown = null
      let totalTokens = 0
      let lastClassification: 'completed' | 'skipped' | 'failed' = 'failed'
      let lastError: string | undefined
      let stopReason: 'condition-met' | 'max-iterations' | 'no-forward-progress' | 'iteration-failed' = 'max-iterations'
      let prevProgressValue: unknown = undefined
      let sawProgressValue = false

      while (iteration < spec.maxIterations) {
        if (spent >= budget || isDeadlineHit()) {
          // Deliberately do NOT finalize (no rec.state, no journalStepFinish)
          // here. This aggregate write is NOT task-memoized — unlike each
          // iteration's childUnitTask call — so on a killed-and-resumed run
          // this whole function replays from the top and can reach a
          // completely different outcome (different iteration count /
          // stopReason) than whatever this branch would have written. A
          // direct write here would race the outer wave-boundary gate (§3b)
          // that fires on the VERY NEXT pass of the wave loop: budget ->
          // markSkipped there; deadline -> interrupt() there. Returning with
          // `rec.state` still 'pending' leaves §3b as the single writer for
          // this "didn't finish" outcome, so replay can never observe (or
          // silently overwrite) a terminal status this run never actually
          // reached.
          return
        }
        iteration += 1
        const { input: assembledInput } = autoFillStepInput(rec.step.agent_type, rec.step.input, deps)
        // Loop iterations feed the previous iteration's output back through
        // ctx.deps under a synthetic key — mirrors executor.ts#runLoopStep's
        // own `{...deps, __previousIteration: previousOutput}`.
        const iterDeps = finalOutput !== null ? { ...deps, __previousIteration: finalOutput } : deps
        const childLabel = `${rec.step.label}#${iteration}`
        const childUnitTask = makeUnitTask(childLabel)
        const attempt = await childUnitTask({
          unitType: rec.step.agent_type,
          input: assembledInput,
          unitConfig: unitConfigBase,
          deps: iterDeps,
        })
        totalTokens += attempt.tokens
        spent += attempt.tokens
        lastClassification = attempt.status

        if (attempt.status !== 'completed') {
          lastError = attempt.status === 'skipped' ? attempt.reason : attempt.error
          stopReason = 'iteration-failed'
          break
        }

        finalOutput = attempt.output
        if (evalLoopCondition(attempt.output, spec.until)) {
          stopReason = 'condition-met'
          break
        }
        const currentValue = getByPath(attempt.output, spec.until.key)
        if (sawProgressValue && sameValue(currentValue, prevProgressValue)) {
          stopReason = 'no-forward-progress'
          break
        }
        prevProgressValue = currentValue
        sawProgressValue = true
      }

      rec.tokens += totalTokens
      rec.loopMeta = { iterations: iteration, stopReason }

      if (finalOutput !== null) {
        rec.state = 'completed'
        outputs.set(rec.step.label, finalOutput)
        rec.error = stopReason === 'condition-met' ? undefined : `loop stopped: ${stopReason} after ${iteration} iteration(s)`
      } else {
        rec.state = lastClassification === 'skipped' ? 'skipped' : 'failed'
        rec.error = lastError ?? `loop failed on first iteration (${stopReason})`
      }

      await journalStepFinish(admin, {
        runId: domainRunId,
        label: rec.step.label,
        agentType: rec.step.agent_type,
        status: rec.state,
        output: rec.state === 'completed' ? finalOutput : { error: rec.error, loop: rec.loopMeta },
        tokensUsed: totalTokens,
      })
    }

    async function runFanOutStep(rec: StepRecord): Promise<void> {
      const deps = depsFor(rec.step)
      const spec = rec.step.fanOut!

      // Own label journaled up front — see runLoopStep's identical comment;
      // same "input otherwise permanently unset" gap for a fan-out parent.
      await journalStepStart(admin, {
        runId: domainRunId,
        label: rec.step.label,
        agentType: rec.step.agent_type,
        input: rec.step.input ?? {},
      })

      const { items, emptyReason } = resolveFanOutItems(spec, deps)

      if (emptyReason) {
        rec.state = 'skipped'
        rec.error = emptyReason
        rec.fanOutMeta = { total: 0, completed: 0, failed: 0 }
        await journalStepFinish(admin, {
          runId: domainRunId,
          label: rec.step.label,
          agentType: rec.step.agent_type,
          status: 'skipped',
          output: { skipped: emptyReason },
          tokensUsed: 0,
        })
        return
      }

      const capped = items.slice(0, spec.maxChildren)
      const baseInput = (rec.step.input && typeof rec.step.input === 'object' ? rec.step.input : {}) as Record<string, unknown>

      const dispatched = await mapWithConcurrency(
        capped.map((item, i) => ({ item, index: i })),
        STEP_CONCURRENCY,
        async ({ item, index }): Promise<AttemptResult> => {
          const iteration = index + 1
          const childLabel = `${rec.step.label}#${iteration}`
          const childInput = { ...baseInput, [spec.itemKey]: item }
          const childUnitTask = makeUnitTask(childLabel)
          return childUnitTask({ unitType: rec.step.agent_type, input: childInput, unitConfig: unitConfigBase, deps })
        }
      )

      let totalTokens = 0
      let completed = 0
      let failed = 0
      for (const r of dispatched) {
        totalTokens += r.tokens
        if (r.status === 'completed') completed += 1
        else failed += 1
      }
      spent += totalTokens
      rec.tokens += totalTokens
      rec.fanOutMeta = { total: dispatched.length, completed, failed }

      const aggregateOutput = {
        fannedOut: dispatched.length,
        completed,
        failed,
        childLabels: capped.map((_, i) => `${rec.step.label}#${i + 1}`),
      }

      if (completed > 0) {
        rec.state = 'completed'
        outputs.set(rec.step.label, aggregateOutput)
        rec.error = failed > 0 ? `${failed} of ${dispatched.length} fan-out children failed` : undefined
      } else {
        rec.state = 'failed'
        rec.error = `all ${dispatched.length} fan-out children failed`
      }

      await journalStepFinish(admin, {
        runId: domainRunId,
        label: rec.step.label,
        agentType: rec.step.agent_type,
        status: rec.state,
        output: rec.state === 'completed' ? aggregateOutput : { error: rec.error },
        tokensUsed: totalTokens,
      })
    }

    // --- mid-run replan -------------------------------------------------------
    //
    // IDEMPOTENCY UNDER REPLAY: this whole section is plain code that reruns
    // on every attempt (fresh or resumed) — unlike a unit step, whose journal
    // write lives inside a memoized task() and so only ever truly executes
    // once. Wrapping the ACCEPT/REJECT decision itself in a task was tried
    // and rejected: task identity here is (call.name, a per-entrypoint-
    // execution GLOBAL call counter) — see this file's header — so a replan
    // task call's position in that global sequence shifts the instant an
    // added step with no dependency on its requester becomes ready in an
    // EARLIER wave on replay than it did on the original attempt (it can:
    // once accepted, the added step is persisted straight onto
    // agent_runs.plan, so a replay's `records` contains it — and therefore
    // makes it wave-1-ready — from the very start, whereas the original
    // attempt only added it mid-wave, after its requester finished). That
    // reorders which OTHER task calls (the added step's own unitTask
    // included) land on which global cnt, breaking memoization for
    // unrelated, already-passing steps — worse than the bug being fixed.
    //
    // The guard actually used instead needs no task and survives that
    // reordering: an accepted replan is only ever detectable, after the fact,
    // by its added steps already being present in `byLabel` (persisted plan
    // reload) AND by this replan's own generated label already having an
    // accepted row in the step ledger — checking BOTH (not just byLabel) is
    // what keeps this from misfiring on a genuinely fresh request whose
    // steps happen to collide with an EXISTING plan label (that must still
    // reach applyReplan and be rejected as a real duplicate, not short-
    // circuited). `alreadyAcceptedReplan` is a plain, idempotent read via
    // journalStepOutput (lib/graph/journal.ts) — reading the SAME row this
    // section itself wrote is always safe under replay.
    async function alreadyAcceptedReplan(replanLabel: string): Promise<{ reason: string; addedLabels: string[] } | null> {
      const output = await journalStepOutput(admin, { runId: domainRunId, label: replanLabel })
      const parsed = output as { accepted?: boolean; reason?: string; addedLabels?: string[] } | null
      if (!parsed || parsed.accepted !== true) return null
      return { reason: parsed.reason ?? '', addedLabels: parsed.addedLabels ?? [] }
    }

    async function handleReplanRequest(fromLabel: string, request: ReplanRequest): Promise<void> {
      if (replanCounter >= MAX_REPLAN_EVENTS) {
        await journalReplanEvent(fromLabel, false, `replan event cap reached (${MAX_REPLAN_EVENTS})`, [])
        return
      }
      // Reserve this replan's ordinal (and therefore its label) up front,
      // deterministically by call order, same as the rest of this section —
      // needed BEFORE the short-circuit lookup below so the label it checks
      // matches whatever the ORIGINAL accepting attempt wrote for this exact
      // replan event, not a later one.
      replanCounter += 1
      const replanLabel = `__replan-${replanCounter}`

      const requestedLabels = request.steps.map((s) => s.label)
      const already = requestedLabels.length > 0 && requestedLabels.every((l) => byLabel.has(l)) ? await alreadyAcceptedReplan(replanLabel) : null
      if (already) {
        replanEvents.push({ fromLabel, accepted: true, reason: already.reason, addedLabels: already.addedLabels })
        return // added steps are already in records/plan.steps/DB from a prior attempt — nothing left to apply
      }

      const currentSteps = records.map((r) => r.step)
      const remainingBudgetTokens = budget - spent
      const outcome = applyReplan(currentSteps, request, { remainingBudgetTokens })
      if (!outcome.ok) {
        await journalReplanEvent(fromLabel, false, outcome.reason, [], replanLabel)
        return
      }
      for (const newStep of outcome.addedSteps) {
        const rec: StepRecord = { step: newStep, state: 'pending', tokens: 0 }
        records.push(rec)
        byLabel.set(newStep.label, rec)
      }
      plan.steps.push(...outcome.addedSteps)
      await admin.from('agent_runs').update({ plan: plan as unknown as AgentRunRow['plan'] }).eq('id', domainRunId)
      await journalReplanEvent(
        fromLabel,
        true,
        request.reason,
        outcome.addedSteps.map((s) => s.label),
        replanLabel
      )
    }

    // Reached by: the deterministic cap-rejection branch above, a genuine
    // applyReplan rejection, or a genuine acceptance. All three write content
    // that is stable across replay — see this section's header — so a direct
    // write is safe here without task-wrapping. `replanLabel`, when supplied,
    // is the ordinal `handleReplanRequest` already reserved (keeps the label
    // in sync with the short-circuit lookup above); the cap-rejection branch
    // has no caller-reserved ordinal, so it keeps reserving its own here.
    async function journalReplanEvent(
      fromLabel: string,
      accepted: boolean,
      reason: string,
      addedLabels: string[],
      replanLabel?: string
    ): Promise<void> {
      let label = replanLabel
      if (!label) {
        replanCounter += 1
        label = `__replan-${replanCounter}`
      }
      replanEvents.push({ fromLabel, accepted, reason, addedLabels })
      await journalStepStart(admin, { runId: domainRunId, label, agentType: 'planner', input: { fromLabel, reason } })
      await journalStepFinish(admin, {
        runId: domainRunId,
        label,
        agentType: 'planner',
        status: accepted ? 'completed' : 'failed',
        output: { accepted, reason, addedLabels },
        tokensUsed: 0,
      })
    }

    // 3) Wave scheduler ---------------------------------------------------------
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
          await markSkipped(rec, 'dependency did not complete')
          cascaded = true
        }
      }

      // 3b) Budget / deadline gate — see header for why these are handled
      // structurally differently (budget: terminal return; deadline: interrupt).
      if (spent >= budget) {
        aborted = 'budget'
      }
      if (aborted === 'budget') {
        for (const rec of records) {
          if (rec.state === 'pending') {
            await markSkipped(rec, 'run stopped before this step could start (budget exhausted)')
          }
        }
        break
      }
      if (isDeadlineHit()) {
        interrupt({
          kind: 'deadline',
          completedLabels: records.filter((r) => r.state === 'completed').map((r) => r.step.label),
          pendingLabels: records.filter((r) => r.state === 'pending').map((r) => r.step.label),
        })
        // interrupt() always throws here (no resume value is ever delivered
        // to a deadline pause — see header); this line only exists so a
        // future reader does not mistake the block above for dead code that
        // needs a `return`.
        continue
      }

      // 3c) Ready steps: pending with all deps completed.
      const ready = records.filter(
        (r) => r.state === 'pending' && r.step.dependsOn.every((d) => byLabel.get(d)?.state === 'completed')
      )

      if (ready.length === 0) {
        if (cascaded) continue
        for (const rec of records) {
          if (rec.state === 'pending') await markSkipped(rec, 'unsatisfiable dependencies (cycle?)')
        }
        break
      }

      // 3d) Run the ready wave with bounded concurrency. The `spent >= budget`
      // guard immediately below narrows (does not eliminate — see ponytail
      // note) the window in which a wave can overspend the run budget: once
      // any concurrently-dispatched step's result pushes `spent` over budget,
      // every step in this same wave still WAITING for a free concurrency
      // slot is skipped from starting rather than dispatched anyway; §3b
      // picks the (still 'pending') skipped ones up as 'budget exhausted' on
      // the wave loop's next pass, same as it already does for steps that
      // never got a turn. ponytail: this cannot stop the up-to-
      // (STEP_CONCURRENCY - 1) OTHER steps that already started in the very
      // same burst from running to completion — executor.ts's shared
      // AbortController could cancel those mid-flight because callLlm() there
      // shares one signal across the whole run; lib/graph/unit.ts's
      // runAgentUnit builds a fresh per-call AbortController with no run-
      // budget awareness (see its header) and lib/graph/runs.ts is not the
      // file that owns that decision. Upgrade path: thread an external
      // AbortSignal (or a live spent/budget accessor) through UnitConfig into
      // runAgentUnit's controller, in a change scoped to lib/graph/unit.ts.
      await mapWithConcurrency(ready, STEP_CONCURRENCY, (rec) => {
        if (spent >= budget) return Promise.resolve() // §3b marks this (still-pending) step skipped next pass
        return dispatchStep(rec)
      })
    }

    // 4) Finalize -----------------------------------------------------------
    const completed = records.filter((r) => r.state === 'completed').length
    const failed = records.filter((r) => r.state === 'failed').length
    const skipped = records.filter((r) => r.state === 'skipped').length

    let finalStatus: AgentRunRow['status']
    if (completed === 0) {
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
          : `completed with errors: ${completed} completed, ${failed} failed, ${skipped} skipped` +
            (aborted ? ` (run aborted: ${aborted})` : '')

    const outcome: RunOutcome = {
      runId: domainRunId,
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

    await markRunTerminal(admin, domainRunId, finalStatus as 'completed' | 'completed_with_errors' | 'failed' | 'cancelled', {
      error: errorSummary,
      result: outcome,
    })

    return outcome
  }
)

/**
 * Helper for the future route/invoke-layer caller — see this file's header
 * ("JOURNAL WRITES") on why the 'paused' transition cannot be written from
 * inside the entrypoint body itself. Call this right after
 * lib/graph/invoke.ts#invokeGraphForUser resolves for the 'run' surface:
 * `invokeResult.result` is the raw value LangGraph's own `.invoke()`/
 * `.stream()` returned, which is `{ __interrupt__: Interrupt[] }` (verified
 * against a real MemorySaver, not `{...state, __interrupt__}` — this
 * entrypoint's own return value is only ever reached via a normal `return`,
 * never merged with an interrupt payload) exactly when this graph paused at
 * the deadline interrupt() above instead of finishing.
 */
export async function markRunPausedOnInterrupt(admin: AdminClient, runId: string, invokeResult: unknown): Promise<boolean> {
  const interrupted =
    typeof invokeResult === 'object' &&
    invokeResult !== null &&
    Array.isArray((invokeResult as { __interrupt__?: unknown }).__interrupt__) &&
    ((invokeResult as { __interrupt__: unknown[] }).__interrupt__.length > 0)
  if (!interrupted) return false
  const { markRunPaused } = await import('./journal')
  await markRunPaused(admin, runId)
  return true
}
