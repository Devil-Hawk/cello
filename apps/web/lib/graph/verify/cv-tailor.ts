// Plan-act-verify for cv_tailor (langgraph port design doc, Step 4, ruling 2
// EXACTLY). runAgentUnit('cv_tailor', ...) is the ACT — it already never
// persists (lib/harness/agents/applier.ts does, see that file's header).
// This module is the VERIFY stage that sits between act and applier's
// persist: (a) the containment report unit.ts already attaches gates here —
// retry with the report as corrective context, ≤2 retries, then FAIL
// WITHOUT PERSIST (a typed error, nothing written to application_drafts);
// (b) a containment-pass supplements evidence via matchClaim — informational
// only, matchClaim has no `ok` field to flip a verdict with (see
// lib/resume/claims.ts's own header); (c) a factual-grounding judge
// (autoevals Factuality vs the resume + framed job facts, via
// meteredJudgeClient) — below threshold shares the SAME bounded retry
// budget; a persistent failure or a budget refusal both still return
// content (the caller decides how to flag the persisted row — see
// CvTailorVerifyOutcome below), only a containment failure fails closed.
//
// THE ONLY CALLER TODAY: lib/graph/autopilot.ts#prepareApplicationDraft —
// the one place cv_tailor's tailored content is handed to applier as
// EXPLICIT resumeSummary/coverLetter input. lib/harness/chains.ts's
// apply-to-role DAG also runs cv_tailor before applier, but its own
// documented FAN-OUT LIMITATION means applier never actually receives
// tailor's per-job output there (falls back to the raw resume) — so there is
// no tailored content flowing into application_drafts on that path to gate.

import { runAgentUnit, type UnitConfig } from '../unit'
import { claimsFor, matchClaim } from '../../resume/claims'
import { loadApiKeys } from '../../harness/keys'
import { meteredJudgeClient, judgeGroundedness } from '../../evals/judge'
import { MissingKeyError } from '../../harness/llm'
import { BudgetCapError } from '../../harness/spend'
import { frameJobText } from '../../security/job-text'
import { logHarnessError } from '../../observability/log'
import type { AdminClient } from '../../harness/types'
import type { TailoringContainmentReport } from '../../security/job-text'
import type { EvalResult } from '../../evals/harness'

/** ≤2 retries TOTAL, shared across both the containment gate and the judge
 *  (ruling 2's "same bounded loop") — 1 initial attempt + up to 2 retries. */
const MAX_RETRIES = 2

/** How much job description to feed the judge as source fact — generous but
 *  bounded, same order of magnitude as cv_tailor.ts's own MAX_JD_CHARS. */
const JUDGE_JD_CHARS = 6000

export class CvTailorContainmentError extends Error {
  readonly report: TailoringContainmentReport
  readonly attempts: number
  constructor(report: TailoringContainmentReport, attempts: number) {
    super(
      `cv_tailor verify: containment failed after ${attempts} attempt(s) — ` +
        `${report.reason ?? 'the draft asserted something the resume does not support'}`
    )
    this.name = 'CvTailorContainmentError'
    this.report = report
    this.attempts = attempts
  }
}

interface JobFacts {
  title: string
  company: string
  description: string | null
}

async function loadJobFacts(admin: AdminClient, jobId: string): Promise<JobFacts> {
  const { data } = await admin.from('jobs').select('title, description, companies(name)').eq('id', jobId).single()
  const row = (data ?? {}) as {
    title?: string | null
    description?: string | null
    companies?: { name?: string | null } | { name?: string | null }[] | null
  }
  const c = row.companies
  const company = (Array.isArray(c) ? c[0]?.name : c?.name) ?? 'the company'
  return { title: row.title ?? '(untitled role)', company, description: row.description ?? null }
}

async function loadResumeText(admin: AdminClient, userId: string): Promise<string> {
  const { data } = await admin.from('profiles').select('resume_text').eq('id', userId).single()
  return ((data as { resume_text?: string | null } | null)?.resume_text ?? '').trim()
}

export interface CvTailorVerifyArgs {
  admin: AdminClient
  unitConfig: UnitConfig
  jobId: string
}

interface DraftContent {
  resumeSummary: string
  coverLetter: string
  keywords: string[]
}

/**
 * 'verified'      — containment + judge both passed. Persist normally.
 * 'judge-failed'  — containment passed, judge did not, retries exhausted.
 *                   Ruling 2c: the caller persists this WITH the content,
 *                   status 'failed', verdict attached — NEVER 'pending_review'.
 * 'unjudged'      — containment passed, the judge itself could not run — a
 *                   refusal (no key / budget cap) or an unexpected failure
 *                   (logged via logHarnessError; never silent). Ruling 2c:
 *                   the caller persists normally but this REQUIRES human
 *                   review — it must never auto-advance (see
 *                   app/api/drafts/batch-approve/eligibility.ts's
 *                   eval_verdicts check).
 * A containment failure never reaches this type at all — it throws
 * CvTailorContainmentError instead (ruling 2a: fail without persist).
 */
export type CvTailorVerifyOutcome =
  | ({ kind: 'verified'; verdict: EvalResult } & DraftContent & { tokensUsed: number })
  | ({ kind: 'judge-failed'; verdict: EvalResult } & DraftContent & { tokensUsed: number })
  | ({ kind: 'unjudged' } & DraftContent & { tokensUsed: number })

/**
 * Run cv_tailor, verify it, and return content ready to hand to applier — or
 * throw CvTailorContainmentError, which the caller MUST treat as fail-
 * without-persist (ruling 2a).
 */
export async function verifyCvTailorDraft(args: CvTailorVerifyArgs): Promise<CvTailorVerifyOutcome> {
  const userId = args.unitConfig.configurable.userId
  let tokensUsed = 0
  let correctiveContext: string | undefined

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await runAgentUnit('cv_tailor', {
      input: { jobId: args.jobId, correctiveContext },
      admin: args.admin,
      config: args.unitConfig,
      label: attempt === 0 ? `tailor:${args.jobId}` : `tailor:${args.jobId}#retry${attempt}`,
    })
    tokensUsed += result.tokensUsed
    const output = result.output as DraftContent

    // (a) CONTAINMENT — ruling 2a.
    if (!result.containment.ok) {
      if (attempt === MAX_RETRIES) {
        throw new CvTailorContainmentError(result.containment, attempt + 1)
      }
      correctiveContext =
        `Your previous draft was flagged for containment — ${result.containment.reason ?? 'it asserted something the resume does not support'}. ` +
        'Rewrite using ONLY facts present in the resume.'
      continue
    }

    // (b) matchClaim SUPPLEMENTS evidence, never overrides — see
    // lib/resume/claims.ts's header ("no `ok` field anywhere in it"). Purely
    // informational: folded into the judge verdict's rationale below, never
    // read to change ok/fail.
    const claims = await claimsFor(args.admin, userId)
    const matches = matchClaim(claims, `${output.resumeSummary}\n\n${output.coverLetter}`)
    const evidenceNote =
      matches.length > 0
        ? ` Corroborated by ${matches.length} stored resume claim(s): ${matches
            .slice(0, 3)
            .map((m) => m.claimText)
            .join('; ')}.`
        : ''

    // (c) FACTUAL-GROUNDING JUDGE — ruling 2c.
    const [job, resumeText] = await Promise.all([loadJobFacts(args.admin, args.jobId), loadResumeText(args.admin, userId)])
    const sourceFacts =
      `CANDIDATE RESUME:\n${resumeText}\n\nJOB FACTS:\nTitle: ${job.title}\nCompany: ${job.company}\n` +
      `Description:\n${frameJobText(job.description, { maxChars: JUDGE_JD_CHARS, emptyPlaceholder: '(no description provided)' })}`

    let verdict: EvalResult
    try {
      const apiKeys = await loadApiKeys(args.admin, userId)
      const client = meteredJudgeClient(args.admin, userId, apiKeys)
      verdict = await judgeGroundedness(
        client,
        { draft: `${output.resumeSummary}\n\n${output.coverLetter}`, sourceFacts },
        { userId }
      )
    } catch (err) {
      // Ruling 2c + invariant 7: the judge not producing a score — for ANY
      // reason, expected (budget cap / no key) or not (a real Factuality()
      // network failure, autoevals throwing) — is 'unjudged', never a
      // silent pass-through and never a rethrow the caller has no typed
      // handling for. Only the unexpected kind gets logged: a budget/key
      // refusal is the system working as designed (same "expected stop"
      // idiom as unit.ts's own catch), a genuine failure is worth an
      // operator's attention.
      if (!(err instanceof BudgetCapError || err instanceof MissingKeyError)) {
        logHarnessError(
          { runId: args.unitConfig.configurable.runId, stepLabel: `tailor:${args.jobId}`, agentType: 'cv_tailor', phase: 'judge', userId },
          err
        )
      }
      return { kind: 'unjudged', ...output, tokensUsed }
    }

    if (verdict.verdict === 'pass') {
      return { kind: 'verified', ...output, tokensUsed, verdict: { ...verdict, summary: verdict.summary + evidenceNote } }
    }

    if (attempt === MAX_RETRIES) {
      return { kind: 'judge-failed', ...output, tokensUsed, verdict: { ...verdict, summary: verdict.summary + evidenceNote } }
    }
    correctiveContext = `A factual-grounding review flagged your previous draft: ${verdict.summary} Revise so every claim traces to the resume or the job facts above.`
  }

  // Unreachable — every branch of the loop above returns or throws.
  throw new Error('cv_tailor verify: exhausted retries without a terminal outcome')
}
