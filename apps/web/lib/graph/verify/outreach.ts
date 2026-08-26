// Plan-act-verify for outreach (langgraph port design doc, Step 4, item 2):
// groundedness (Factuality vs sourceFacts) + specificity (ClosedQA) — the two
// judges lib/evals/judge.ts already defines, verbatim. A failing verdict gets
// ONE bounded regeneration; either way this ALWAYS returns content for the
// caller to persist as 'pending_review' — unlike cv_tailor (ruling 2a),
// outreach's human-approve queue is already the send gate (nothing here ever
// reaches a recipient without a click on /api/outreach/send), so verify's job
// is to attach verdicts, not to block persistence.
//
// AUTOPILOT-ORIGINATED DRAFTS: ruling 2 says a failed-verdict draft must not
// count toward a tick's action quota. lib/graph/autopilot.ts never drafts
// outreach at all today (grep confirms — only cv_tailor/applier run there),
// so there is no quota to wire this into yet; `failedVerdict` on the result
// below is what a future autopilot outreach call site would key off, the
// same way lib/graph/verify/cv-tailor.ts's judge-failed outcome already
// excludes a cv_tailor draft from draftedThisTick (see that file + this
// stage's autopilot.ts wiring).

import { runUnitOnce } from '../oneshot'
import { meteredJudgeClient, judgeGroundedness, judgeSpecificity } from '../../evals/judge'
import { loadApiKeys } from '../../harness/keys'
import { MissingKeyError } from '../../harness/llm'
import { BudgetCapError } from '../../harness/spend'
import { frameJobText } from '../../security/job-text'
import { logHarnessError } from '../../observability/log'
import type { AdminClient } from '../../harness/types'
import type { OutreachDraftInput, OutreachDraftResult } from '../../harness/agents/outreach'
import type { EvalResult } from '../../evals/harness'

const JD_CHARS = 1500

function buildSourceFacts(input: OutreachDraftInput): string {
  return (
    `CANDIDATE RESUME:\n${(input.resumeText ?? '').trim() || '(no resume on file)'}\n\n` +
    `VERIFIED MATCH HIGHLIGHTS: ${(input.matchHighlights ?? []).join('; ') || '(none)'}\n\n` +
    `JOB FACTS:\nTitle: ${input.jobTitle}\nCompany: ${input.companyName}\n` +
    `Description:\n${frameJobText(input.jobDescription, { maxChars: JD_CHARS, emptyPlaceholder: '(no description provided)' })}`
  )
}

async function judgeDraft(
  admin: AdminClient,
  userId: string,
  apiKeys: Parameters<typeof meteredJudgeClient>[2],
  draft: OutreachDraftResult,
  sourceFacts: string,
  companyAndRole: string
): Promise<EvalResult[]> {
  const client = meteredJudgeClient(admin, userId, apiKeys)
  return Promise.all([
    judgeGroundedness(client, { draft: draft.body, sourceFacts }, { userId }),
    judgeSpecificity(client, { draft: draft.body, companyAndRole }, { userId }),
  ])
}

export interface VerifyOutreachDraftArgs {
  admin: AdminClient
  userId: string
  /** agent_runs.goal for the ONE bounded regeneration's own one-shot run, if it happens. */
  goal: string
  input: OutreachDraftInput
  draft: OutreachDraftResult
}

export interface OutreachVerifyResult {
  subject: string
  body: string
  tokensUsed: number
  /** Empty when the judge itself could not run (no key / budget cap) — still
   *  persisted, per this file's header; REFUSE-OVER-GUESS means an empty
   *  array here, never a substituted verdict. */
  verdicts: EvalResult[]
  /** True when the FINAL draft (after the one bounded regen, if any) still
   *  carries a failing verdict. */
  failedVerdict: boolean
  /** True when a judge call threw something OTHER than the two typed
   *  refusals (BudgetCapError/MissingKeyError) — cv-tailor.ts's SAME
   *  discipline: an unexpected judge failure (autoevals throwing, OpenRouter
   *  erroring — e.g. a judge requesting more tokens than the account can
   *  afford, drawing a raw 402) is logged via logHarnessError and NEVER
   *  allowed to take the draft down with it. The caller (the draft route)
   *  writes 'unjudged' eval_verdicts rows for both judges when this is true,
   *  same shape /api/outreach/judge's own BudgetCapError branch already uses
   *  for 'insufficient-budget'. */
  judgeUnavailable: boolean
}

/**
 * Judge `args.draft`; on any failing verdict, regenerate ONCE with the
 * failure as corrective context and re-judge; return whichever draft is
 * final either way. NEVER blocks persistence — the caller always gets
 * content back.
 */
export async function verifyOutreachDraft(args: VerifyOutreachDraftArgs): Promise<OutreachVerifyResult> {
  let tokensUsed = args.draft.tokensUsed
  const sourceFacts = buildSourceFacts(args.input)
  const companyAndRole = `${args.input.companyName}, ${args.input.jobTitle}`

  let apiKeys
  try {
    apiKeys = await loadApiKeys(args.admin, args.userId)
  } catch {
    return { subject: args.draft.subject, body: args.draft.body, tokensUsed, verdicts: [], failedVerdict: false, judgeUnavailable: false }
  }

  let verdicts: EvalResult[]
  try {
    verdicts = await judgeDraft(args.admin, args.userId, apiKeys, args.draft, sourceFacts, companyAndRole)
  } catch (err) {
    if (err instanceof BudgetCapError || err instanceof MissingKeyError) {
      return { subject: args.draft.subject, body: args.draft.body, tokensUsed, verdicts: [], failedVerdict: false, judgeUnavailable: false }
    }
    // Any OTHER judge failure — autoevals throwing, OpenRouter erroring (the
    // E2E case this exists for: a judge call requesting more tokens than the
    // account can afford, drawing a raw 402) — must not take the draft down
    // with it. cv-tailor.ts's SAME discipline (see that file's judge catch):
    // log it loudly, still return content for the caller to persist.
    logJudgeFailure(args, err)
    return { subject: args.draft.subject, body: args.draft.body, tokensUsed, verdicts: [], failedVerdict: false, judgeUnavailable: true }
  }

  if (verdicts.every((v) => v.verdict === 'pass')) {
    return { subject: args.draft.subject, body: args.draft.body, tokensUsed, verdicts, failedVerdict: false, judgeUnavailable: false }
  }

  // ONE bounded regeneration, corrective context built from whichever verdict(s) failed.
  const correctiveContext = verdicts
    .filter((v) => v.verdict === 'fail')
    .map((v) => v.summary)
    .join(' ')
  const regenerated = await runUnitOnce('outreach', {
    admin: args.admin,
    userId: args.userId,
    goal: args.goal,
    input: { ...args.input, correctiveContext },
  })
  const regenDraft = regenerated.output as OutreachDraftResult
  tokensUsed += regenDraft.tokensUsed

  try {
    const finalVerdicts = await judgeDraft(args.admin, args.userId, apiKeys, regenDraft, sourceFacts, companyAndRole)
    return {
      subject: regenDraft.subject,
      body: regenDraft.body,
      tokensUsed,
      verdicts: finalVerdicts,
      failedVerdict: finalVerdicts.some((v) => v.verdict === 'fail'),
      judgeUnavailable: false,
    }
  } catch (err) {
    if (err instanceof BudgetCapError || err instanceof MissingKeyError) {
      // Judge went unavailable mid-flight (e.g. the regen call itself pushed
      // spend over the cap) — keep the regenerated content, carry the
      // FIRST-pass verdicts forward rather than fabricate a second verdict.
      return {
        subject: regenDraft.subject,
        body: regenDraft.body,
        tokensUsed,
        verdicts,
        failedVerdict: verdicts.some((v) => v.verdict === 'fail'),
        judgeUnavailable: false,
      }
    }
    // Same unexpected-failure discipline as the first-pass catch above — the
    // regenerated content still persists, this run just could not be judged.
    logJudgeFailure(args, err)
    return { subject: regenDraft.subject, body: regenDraft.body, tokensUsed, verdicts: [], failedVerdict: false, judgeUnavailable: true }
  }
}

/** Shared logging chokepoint for both judge call sites above — an unexpected
 *  judge failure is ALWAYS logged, never silent (invariant 7's "refuse, don't
 *  guess" applies to the log line too, not just the persisted verdict). */
function logJudgeFailure(args: VerifyOutreachDraftArgs, err: unknown): void {
  logHarnessError({ runId: args.goal, stepLabel: 'outreach-verify', agentType: 'outreach', phase: 'judge', userId: args.userId }, err)
}
