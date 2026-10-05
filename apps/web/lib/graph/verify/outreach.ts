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
import { judgeClaims, judgeRunner, judgeSpecificity, type ClaimsResult, type SpecificityResult } from '../../evals/claims-judge'
import { loadApiKeys } from '../../harness/keys'
import { MissingKeyError } from '../../harness/providers'
import { BudgetCapError } from '../../harness/spend'
import { logHarnessError } from '../../observability/log'
import { checkDraft, type DraftCheckResult } from '../../writing/checks'
import { outreachSources, type OutreachDraftInput, type OutreachDraftResult } from '../../harness/agents/outreach'
import type { AdminClient, LlmRunner } from '../../harness/types'
import type { EvalResult } from '../../evals/harness'

export interface ReviewDeps {
  /** One more draft from the same writer; called at most once. */
  generate: (input: OutreachDraftInput) => Promise<OutreachDraftResult>
  claimsRun: LlmRunner
  specificityRun: LlmRunner
}

export interface OutreachReview {
  subject: string
  body: string
  tokensUsed: number
  source: 'model' | 'template'
  templateReason?: OutreachDraftResult['templateReason']
  /** groundedness and specificity, when the judges ran. Empty when they did not. */
  verdicts: EvalResult[]
  checks: DraftCheckResult
  /** True when the final draft still fails a check or a judge. */
  failed: boolean
  /** A judge call threw something other than the two typed refusals. Logged. */
  judgeUnavailable: boolean
  /** The judges could not run for a typed, expected reason. */
  judgeRefused?: 'missing-key' | 'budget-cap'
}

export function checksFor(input: OutreachDraftInput, draft: { subject: string; body: string }): DraftCheckResult {
  const kind = input.kind ?? 'initial'
  return checkDraft({
    kind: kind === 'follow_up' ? 'follow_up' : 'outreach',
    subject: draft.subject,
    body: draft.body,
    senderName: input.userName,
    contactName: input.contactName,
    companyName: input.companyName,
    jobTitle: input.jobTitle,
    hasHistory: kind === 'follow_up' ? true : (input.history?.length ?? 0) > 0,
    previousBody: input.previousEmail?.body ?? null,
  })
}

interface JudgeOutcome {
  verdicts: EvalResult[]
  refused?: 'missing-key' | 'budget-cap'
  unavailable: boolean
}

async function judge(deps: ReviewDeps, input: OutreachDraftInput, draft: OutreachDraftResult, onError: (err: unknown) => void): Promise<JudgeOutcome> {
  const src = outreachSources(input)
  try {
    const [groundedness, specificity] = await Promise.all([
      judgeClaims(deps.claimsRun, {
        text: draft.body,
        sources: [...src.resume, ...src.job, ...src.facts, ...src.history],
      }),
      judgeSpecificity(deps.specificityRun, {
        text: draft.body,
        jobLines: src.job,
        facts: src.facts,
        role: input.jobTitle ?? 'No specific role',
        company: input.companyName ?? 'the company',
      }),
    ])
    return { verdicts: [groundedness, specificity], unavailable: false }
  } catch (err) {
    if (err instanceof BudgetCapError) return { verdicts: [], refused: 'budget-cap', unavailable: false }
    if (err instanceof MissingKeyError) return { verdicts: [], refused: 'missing-key', unavailable: false }
    onError(err)
    return { verdicts: [], unavailable: true }
  }
}

function problems(checks: DraftCheckResult, verdicts: EvalResult[]): number {
  const claims = verdicts.find((v) => v.name === 'groundedness') as ClaimsResult | undefined
  const specific = verdicts.find((v) => v.name === 'specificity')
  return checks.checks.filter((c) => !c.ok).length + (claims?.unsupported.length ?? 0) + (specific?.verdict === 'fail' ? 1 : 0)
}

/** The numbered list of fixes the regeneration is asked for. */
export function correctiveList(checks: DraftCheckResult, verdicts: EvalResult[]): string {
  const items: string[] = []
  const claims = verdicts.find((v) => v.name === 'groundedness') as ClaimsResult | undefined
  for (const c of claims?.unsupported ?? []) {
    items.push(`Remove or rewrite "${c.text}". No line in the resume, job post, research or history says this.`)
  }
  const specific = verdicts.find((v) => v.name === 'specificity') as SpecificityResult | undefined
  if (specific?.verdict === 'fail') {
    items.push('Use one concrete detail from the job post or company facts, and name where it ties to the resume.')
  }
  for (const c of checks.checks) if (!c.ok) items.push(c.message)
  return items.map((s, i) => `${i + 1}. ${s}`).join('\n')
}

export async function reviewOutreachDraft(
  deps: ReviewDeps,
  input: OutreachDraftInput,
  draft: OutreachDraftResult,
  onJudgeError: (err: unknown) => void = () => {}
): Promise<OutreachReview> {
  const source = draft.source ?? (draft.tokensUsed > 0 ? 'model' : 'template')
  const result = (d: OutreachDraftResult, j: JudgeOutcome, tokens: number): OutreachReview => {
    const checks = checksFor(input, d)
    return {
      subject: d.subject,
      body: d.body,
      tokensUsed: tokens,
      source: d.source ?? source,
      templateReason: d.templateReason,
      verdicts: j.verdicts,
      checks,
      failed: !checks.ok || j.verdicts.some((v) => v.verdict === 'fail'),
      judgeUnavailable: j.unavailable,
      judgeRefused: j.refused,
    }
  }

  // The template makes no claim about the sender, so there is nothing for a judge to read.
  if (source === 'template') return result(draft, { verdicts: [], unavailable: false }, draft.tokensUsed)

  const first = await judge(deps, input, draft, onJudgeError)
  const firstChecks = checksFor(input, draft)
  const needsFix = !firstChecks.ok || first.verdicts.some((v) => v.verdict === 'fail')
  if (!needsFix) return result(draft, first, draft.tokensUsed)

  const regen = await deps.generate({ ...input, correctiveContext: correctiveList(firstChecks, first.verdicts) })
  const tokens = draft.tokensUsed + regen.tokensUsed
  // A template regeneration (the model failed on the retry) never replaces a real draft.
  if ((regen.source ?? 'model') === 'template' || regen.tokensUsed === 0) return result(draft, first, tokens)

  const second = await judge(deps, input, regen, onJudgeError)
  // Keep whichever draft has fewer problems; on a tie the corrected one wins.
  const keepRegen = problems(checksFor(input, regen), second.verdicts) <= problems(firstChecks, first.verdicts)
  return keepRegen ? result(regen, second, tokens) : result(draft, first, tokens)
}

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
