// How a harness run shows up as the output of its Langfuse root observation.
// Its own module (not lib/graph/runs.ts) so a route or test that mocks runs.ts
// still gets the real summary.

import type { RunOutcome } from './runs'

/** What the Langfuse root observation of a run shows as its output: status,
 *  step count, spend and totals, never the step outputs (resume text, drafts).
 *  A run parked at its deadline has no outcome yet. */
export function summarizeRunOutcome(result: unknown): Record<string, unknown> {
  const o = result as Partial<RunOutcome> | null
  if (!o || typeof o !== 'object' || typeof o.status !== 'string') return { status: 'paused' }
  return { status: o.status, steps: o.steps?.length ?? 0, spentTokens: o.spentTokens, summary: o.summary, aborted: o.aborted }
}
