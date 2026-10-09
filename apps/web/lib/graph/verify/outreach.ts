// Review of an outreach draft: the deterministic checks (length, banned phrases,
// one ask, greeting, sign-off, invented history, company named), then the claims
// judge against the numbered resume, job, research and history lines, and the
// specificity judge against the job and research lines.
//
// A failing draft gets ONE regeneration with a numbered list of exactly what to
// fix, built here in code. Either way this returns content for the caller to
// store as 'pending_review': the human approve queue is already the send gate,
// so review attaches verdicts and never blocks.
//
// The template is a legitimate starting point but it makes no claims, so it is
// checked by code only and never regenerated over a model draft.
//
// reviewOutreachDraft is pure over its two dependencies (generate, judges) so
// the evals and tests drive it without a database; verifyOutreachDraft wires
// them to the unit runner and the user's keys.


import { runUnitOnce } from '../oneshot'
import { judgeRunner } from '../../evals/claims-judge'
import { loadApiKeys } from '../../harness/keys'
import { logHarnessError } from '../../observability/log'
import { reviewOutreachDraft, type OutreachReview } from './outreach-review'
import type { OutreachDraftInput, OutreachDraftResult } from '../../harness/agents/outreach'
import type { AdminClient, LlmRunner } from '../../harness/types'

export { checksFor, correctiveList, reviewOutreachDraft } from './outreach-review'
export type { OutreachReview, ReviewDeps } from './outreach-review'

export interface VerifyOutreachDraftArgs {
  admin: AdminClient
  userId: string
  /** agent_runs.goal for the one regeneration's own one-shot run. */
  goal: string
  input: OutreachDraftInput
  draft: OutreachDraftResult
}

/** The route-facing review: the writer is the outreach unit, the judges use the user's keys. */
export async function verifyOutreachDraft(args: VerifyOutreachDraftArgs): Promise<OutreachReview> {
  const log = (err: unknown) =>
    logHarnessError({ runId: args.goal, stepLabel: 'outreach-verify', agentType: 'outreach', phase: 'judge', userId: args.userId }, err)
  let claimsRun = unavailableRun
  let specificityRun = unavailableRun
  try {
    const apiKeys = await loadApiKeys(args.admin, args.userId)
    claimsRun = judgeRunner(apiKeys, 'judge-claims')
    specificityRun = judgeRunner(apiKeys, 'judge-specificity')
  } catch (err) {
    log(err)
  }
  return reviewOutreachDraft({ generate: (i) => regenOnce(args, i), claimsRun, specificityRun }, args.input, args.draft, log)
}

const unavailableRun: LlmRunner = async () => {
  throw new Error('judge unavailable')
}

async function regenOnce(args: VerifyOutreachDraftArgs, input: OutreachDraftInput): Promise<OutreachDraftResult> {
  const regenerated = await runUnitOnce('outreach', { admin: args.admin, userId: args.userId, goal: args.goal, input })
  return regenerated.output as OutreachDraftResult
}
