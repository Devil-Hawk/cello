// A run started from a Copilot turn never reaches the aggregator feeds: the
// sourcer agent is the only agent that calls them, so such a run plans and
// replans without it. The marker rides on agent_runs.result (written at
// creation, replaced only when the run finishes) so a resumed run still has it.
import type { Plan } from './types'

export const COPILOT_RUN_MARKER = { origin: 'copilot' }

export function isCopilotRun(result: unknown): boolean {
  return (result as { origin?: unknown } | null)?.origin === 'copilot'
}

export function withoutSourcer(plan: Plan): Plan {
  const dropped = new Set(plan.steps.filter((s) => s.agent_type === 'sourcer').map((s) => s.label))
  if (dropped.size === 0) return plan
  return {
    ...plan,
    steps: plan.steps
      .filter((s) => !dropped.has(s.label))
      .map((s) => ({ ...s, dependsOn: s.dependsOn.filter((d) => !dropped.has(d)) })),
  }
}
