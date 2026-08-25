// Harness runtime — mid-run replanning: bounded, validated graph extension.
//
// A running step's AgentResult may carry a `replanRequest` (see
// ./types.ts#AgentResult and ./schemas.ts#ReplanRequestSchema). applyReplan()
// is the ONLY way new steps get appended to a live run's graph — it re-applies
// every rule PlanSchema enforces on an initial plan (no cycles, no unknown
// deps, no duplicate labels) against the MERGED graph (existing steps + the
// proposed ones), plus the bounded-extension rules unique to a live run: the
// merged step count must stay under the plan cap, and there must be budget
// left to spend. It never mutates its inputs — the executor appends
// `addedSteps` to its own live plan/records only after this returns ok:true.
//
// Pure and DB-free by design so it can be unit-tested without a live run (see
// /tmp/cello-work/dynamic-test.ts).

import { PlanStepSchema, ReplanRequestSchema, MAX_PLAN_STEPS, detectCycle, stripUntrustedSubmit } from './schemas'
import type { PlanStep, ReplanRequest } from './types'

export interface ReplanOptions {
  /** Defaults to MAX_PLAN_STEPS (24). */
  maxSteps?: number
  /** Remaining token budget for the run. A replan is rejected outright once
   *  this is <= 0 — no point growing a graph with nothing left to spend. */
  remainingBudgetTokens?: number
}

export type ReplanOutcome =
  | { ok: true; addedSteps: PlanStep[] }
  | { ok: false; reason: string }

export function applyReplan(currentSteps: PlanStep[], request: ReplanRequest, opts: ReplanOptions = {}): ReplanOutcome {
  const maxSteps = opts.maxSteps ?? MAX_PLAN_STEPS

  if (opts.remainingBudgetTokens !== undefined && opts.remainingBudgetTokens <= 0) {
    return { ok: false, reason: 'no token budget remaining — cannot extend the graph' }
  }

  const parsedRequest = ReplanRequestSchema.safeParse(request)
  if (!parsedRequest.success) {
    return {
      ok: false,
      reason: `invalid replan request: ${parsedRequest.error.issues.map((i) => i.message).join('; ')}`,
    }
  }
  // Re-validated individually (defense in depth — ReplanRequestSchema already
  // runs PlanStepSchema per element, this just keeps the type narrow).
  // SAFETY: a replan request originates from a step's own AgentResult, which
  // may be built from that step's LLM call output — untrusted for the same
  // reason planGoal()'s plan is (see schemas.ts#stripUntrustedSubmit). Strip
  // any applier autoSubmit:true before these steps can ever join the live
  // graph; only lib/harness/chains.ts#compileChain's submit-confirmed chain
  // may produce a real submitting step, and it never goes through applyReplan.
  const proposed = stripUntrustedSubmit(parsedRequest.data.steps.map((s) => PlanStepSchema.parse(s))) as PlanStep[]

  if (currentSteps.length + proposed.length > maxSteps) {
    return {
      ok: false,
      reason: `replan would grow the plan to ${currentSteps.length + proposed.length} steps, over the ${maxSteps}-step cap`,
    }
  }

  const existingLabels = new Set(currentSteps.map((s) => s.label))
  const seenNew = new Set<string>()
  for (const step of proposed) {
    if (existingLabels.has(step.label)) {
      return { ok: false, reason: `replan step "${step.label}" duplicates an existing step label` }
    }
    if (seenNew.has(step.label)) {
      return { ok: false, reason: `replan step "${step.label}" is duplicated within the replan request` }
    }
    seenNew.add(step.label)
  }

  const mergedLabels = new Set<string>([...existingLabels, ...seenNew])
  for (const step of proposed) {
    for (const dep of step.dependsOn) {
      if (!mergedLabels.has(dep)) {
        return { ok: false, reason: `replan step "${step.label}" depends on unknown step "${dep}"` }
      }
    }
  }

  const merged = [...currentSteps, ...proposed].map((s) => ({ label: s.label, dependsOn: s.dependsOn }))
  const cycle = detectCycle(merged)
  if (cycle) {
    return { ok: false, reason: `replan would introduce a dependency cycle: ${cycle.join(' -> ')}` }
  }

  return { ok: true, addedSteps: proposed }
}
