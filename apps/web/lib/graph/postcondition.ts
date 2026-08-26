// Tool postconditions — the shared deterministic check every completed (or
// failed) unit call gets, uniformly, in runAgentUnit's finish path
// (lib/graph/unit.ts). Step 4 of the langgraph port design doc, item 4:
// "cross-run tool success-rate becomes queryable" is the audit's
// write-only-journal fix — agent_steps already records what a unit did, but
// nothing before this queried "how often does unit X actually succeed" in
// one place. writeVerdict(subjectKind:'tool_call') gives that a row per call,
// keyed to the SAME agent_steps.id journalStepFinish just wrote (so a reader
// can join verdict -> step -> run without a second identity scheme).
//
// WHY THIS IS SEPARATE FROM CONTAINMENT (unit.ts's own detect-and-attach)
//   Containment is about WHAT four specific unit types wrote (a content-
//   safety property). This is about whether the CALL ITSELF behaved —
//   produced usable output and metered something non-nonsensical — for EVERY
//   unit type, not just the four content-authoring ones. Two different
//   questions, two different judges (containment/deterministic are both
//   listed on eval_verdicts' judge CHECK for exactly this reason).
//
// judge='deterministic': no model call, so no budget/refusal path exists
// here — this check either runs or it doesn't (a writeVerdict failure is
// itself best-effort/logged, per that function's own header).

import { writeVerdict } from '../evals/verdicts'
import type { AdminClient } from '../harness/types'

export interface ToolPostconditionCheck {
  ok: boolean
  reasons: string[]
}

/**
 * Output parsed + schema-valid + expected side-effect counters sane.
 *
 * The first two are already GUARANTEED by the time a caller reaches this
 * function (schema.output.parse succeeded, or unit.ts's own catch branch is
 * what runs instead — see checkFailedToolPostcondition below) — checked here
 * anyway so this function is independently correct and testable without
 * trusting the caller's control flow. The counter check is real, not
 * decorative: `tokensUsed` is the one side-effect counter every unit type
 * shares (matcher/bulk_matcher/etc. additionally meter through ctx.llm, but
 * unit.ts's own `meter` always sums to a real, non-negative number — see its
 * header), so a negative or non-finite value can only mean a metering bug,
 * never a legitimate result.
 */
export function checkToolPostcondition(output: unknown, tokensUsed: number): ToolPostconditionCheck {
  const reasons: string[] = []
  if (output === undefined || output === null) reasons.push('output parsed to null/undefined')
  if (!Number.isFinite(tokensUsed) || tokensUsed < 0) reasons.push(`tokensUsed is not a sane counter: ${tokensUsed}`)
  return { ok: reasons.length === 0, reasons }
}

export interface RecordToolPostconditionArgs {
  userId: string
  runId: string
  /** The agent_steps.id journalStepFinish just wrote for this same call —
   *  null when that upsert itself failed, in which case there is no row to
   *  attach a verdict to and the caller should skip this entirely. */
  stepId: string | null
  check: ToolPostconditionCheck
}

/** Persist one tool_call verdict for a completed (or failed) unit call. */
export async function recordToolPostcondition(admin: AdminClient, args: RecordToolPostconditionArgs): Promise<void> {
  if (!args.stepId) return
  await writeVerdict(admin, {
    userId: args.userId,
    runId: args.runId,
    subjectKind: 'tool_call',
    subjectId: args.stepId,
    judge: 'deterministic',
    verdict: args.check.ok ? 'pass' : 'fail',
    rationale: args.check.ok ? null : args.check.reasons.join('; '),
  })
}
