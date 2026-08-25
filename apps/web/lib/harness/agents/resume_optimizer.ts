// Resume ATS optimizer — the jobright-style "score my resume vs this job" loop.
//
// Given the user's resume text and a target job, this returns:
//   - atsScore (0-100)       ATS keyword/format fit of the ORIGINAL resume
//   - missingKeywords[]      job keywords absent from the resume
//   - formatIssues[]         concrete ATS-format problems (tables, headers, etc.)
//   - suggestedRewrite       an improved resume that ONLY surfaces/rephrases
//                            content already true in the original (NEVER fabricates)
//   - rescore                a fresh ATS score of the suggestedRewrite (the loop)
//
// This is NOT a harness DAG agent (not in the agent_type enum) — it's a reusable
// module for an API route / the copilot. It accepts either a budget-aware
// LlmRunner (harness metering) or a DecryptedApiKeys bundle (direct OpenRouter).
//
// HARD RULE: the rewrite may reorganize, rephrase, and surface latent content,
// and mirror the job's phrasing for keywords the candidate genuinely has — it may
// NEVER invent employers, titles, dates, degrees, metrics, or skills.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { DecryptedApiKeys, LlmRunner, LlmResult, LlmRunOptions } from '../types'
import { callLlm, parseJsonLoose, TruncatedResponseError } from '../llm'
import { composeSystemPrompt, loadModeDoc } from '../prompts'
import { createVersion } from '@/lib/resume/store'
import type { ResumeDocument, ResumeSource } from '@/lib/resume/types'

const RESUME_LIMIT = 12000
const DESC_LIMIT = 6000
// Ceiling on the rewritten resume. A full 1-2 page resume in plain text runs
// roughly 3,000-9,000 chars (~800-2,400 tokens); 4096 leaves headroom for a
// denser multi-page resume without silently truncating it mid-document (the
// old 2200 cap did exactly that — see lib/resume/render.ts consumers).
const REWRITE_MAX_TOKENS = 4096

export interface ResumeOptimizerJob {
  title: string
  company?: string | null
  description?: string | null
}

export interface AtsScore {
  atsScore: number
  missingKeywords: string[]
  formatIssues: string[]
  /** Job keywords the resume already covers (useful for the UI). */
  matchedKeywords: string[]
}

export interface ResumeOptimizerResult extends AtsScore {
  suggestedRewrite: string
  /** Fresh ATS score of `suggestedRewrite`. */
  rescore: AtsScore
  tokensUsed: number
}

export interface OptimizeResumeArgs {
  resumeText: string
  job: ResumeOptimizerJob
  /** Preferred: budget-aware runner (harness). */
  llm?: LlmRunner
  /** Fallback: direct OpenRouter call with the user's key. */
  apiKeys?: DecryptedApiKeys
  signal?: AbortSignal
}

function clampPct(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0
  return Math.max(0, Math.min(100, Math.round(v)))
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((s) => s.trim())
}

function jobBlock(job: ResumeOptimizerJob): string {
  return (
    `Title: ${job.title}\n` +
    `Company: ${job.company ?? 'Unknown'}\n` +
    `Description:\n${(job.description ?? '').slice(0, DESC_LIMIT)}`
  )
}

/**
 * System prompt shared by all three passes (score, rewrite, rescore):
 * _shared.md + _voice.md + prompts/resume_optimizer.md (the house-style mode
 * document — see docs/PROMPT-GENERATOR.md — which carries both the Scoring
 * Rubric's full-range calibration bands and the Rewrite Rules honesty
 * discipline in one document) + the resume text for THIS call (the original
 * for score/rewrite, the rewrite itself for rescore). Identical for every
 * call scoring/rewriting the SAME resume text, so this is the half of the
 * prompt marked cachePrefix — the job (below, in the user prompt) is the part
 * that actually changes call to call.
 */
function resumeSystem(resumeText: string): string {
  return composeSystemPrompt({
    mode: loadModeDoc('resume_optimizer'),
    stableContext: `RESUME (the only source of truth — never credit content that is not here):\n${resumeText.slice(0, RESUME_LIMIT)}`,
  })
}

function scorePrompt(job: ResumeOptimizerJob): string {
  return `JOB:\n${jobBlock(job)}\n\nScore the RESUME given in the system prompt against this job.`
}

/**
 * Token cap for the ATS scoring passes.
 *
 * This was 700, which a typical scoring response (~535 completion tokens
 * measured against a 4.9k-char resume) came within 24% of. Any slightly longer
 * keyword list truncated the JSON mid-object and the whole optimize request
 * failed with "LLM response was not valid JSON" — intermittently, which is why
 * it presented to users as "the button does nothing". Doubling the headroom
 * costs nothing when unused, since billing is on tokens produced.
 */
const SCORE_MAX_TOKENS = 1600

async function scoreResume(
  run: LlmRunner,
  resumeText: string,
  job: ResumeOptimizerJob
): Promise<{ score: AtsScore; tokensUsed: number }> {
  const base: LlmRunOptions = {
    system: resumeSystem(resumeText),
    prompt: scorePrompt(job),
    json: true,
    maxTokens: SCORE_MAX_TOKENS,
    temperature: 0.2,
    // Scoring against calibrated bands is a judgement call, not mechanical
    // extraction — worth the reasoning spend.
    reasoning: { effort: 'medium' },
    // resumeText (in `system`, above) is the same for every job a given user
    // scores their original resume against — a real, reused cache prefix.
    cachePrefix: true,
  }
  let res
  try {
    res = await run(base)
  } catch (err) {
    // An unusually verbose response (or reasoning eating into the same output
    // budget) can still clip the cap; retry once wider rather than failing
    // the user's whole optimize run.
    if (!(err instanceof TruncatedResponseError)) throw err
    res = await run({ ...base, maxTokens: SCORE_MAX_TOKENS * 2 })
  }
  const raw = parseJsonLoose<Partial<AtsScore>>(res.content)
  return {
    score: {
      atsScore: clampPct(raw.atsScore),
      matchedKeywords: strArray(raw.matchedKeywords),
      missingKeywords: strArray(raw.missingKeywords),
      formatIssues: strArray(raw.formatIssues),
    },
    tokensUsed: res.tokensUsed,
  }
}

function rewritePrompt(job: ResumeOptimizerJob, missingKeywords: string[], formatIssues: string[]): string {
  return (
    `TARGET JOB:\n${jobBlock(job)}\n\n` +
    `Keywords the job wants that may be under-surfaced — incorporate ONLY those the ORIGINAL RESUME ` +
    `already supports: ${missingKeywords.join(', ') || '(none)'}\n` +
    `Format issues to fix: ${formatIssues.join('; ') || '(none)'}\n\n` +
    `Rewrite the resume now.`
  )
}

async function rewriteResume(
  run: LlmRunner,
  resumeText: string,
  job: ResumeOptimizerJob,
  missingKeywords: string[],
  formatIssues: string[]
): Promise<{ rewrite: string; tokensUsed: number }> {
  const base: LlmRunOptions = {
    system: resumeSystem(resumeText),
    prompt: rewritePrompt(job, missingKeywords, formatIssues),
    maxTokens: REWRITE_MAX_TOKENS,
    temperature: 0.3,
    // The honesty constraint is a judgement call applied across a whole
    // document, not mechanical formatting — this is where reasoning quality
    // matters most in this file.
    reasoning: { effort: 'medium' },
    cachePrefix: true,
  }
  let res = await run(base)
  // This call isn't json:true, so llm.ts's TruncatedResponseError never fires
  // here — check finishReason directly. Reasoning tokens bill as output and
  // share REWRITE_MAX_TOKENS with the rewrite itself, so a verbose reasoning
  // pass can now clip the cap in a way the old (reasoning-free) call could
  // not; retry once wider rather than silently saving a resume cut off
  // mid-sentence.
  if (res.finishReason === 'length') {
    res = await run({ ...base, maxTokens: REWRITE_MAX_TOKENS * 2 })
  }
  return { rewrite: res.content.trim(), tokensUsed: res.tokensUsed }
}

/**
 * Score the resume, produce an honesty-constrained rewrite, and rescore the
 * rewrite. Provide either `llm` (metered) or `apiKeys` (direct OpenRouter).
 */
export async function optimizeResume(args: OptimizeResumeArgs): Promise<ResumeOptimizerResult> {
  const resumeText = (args.resumeText ?? '').trim()
  if (!resumeText) throw new Error('resumeText is required')
  if (!args.job?.title) throw new Error('job.title is required')

  // Adapt whichever LLM source was provided into a single runner.
  const run: LlmRunner =
    args.llm ??
    ((opts: LlmRunOptions): Promise<LlmResult> => {
      if (!args.apiKeys) throw new Error('optimizeResume requires either `llm` or `apiKeys`')
      return callLlm(args.apiKeys, opts, args.signal)
    })

  let tokensUsed = 0

  const original = await scoreResume(run, resumeText, args.job)
  tokensUsed += original.tokensUsed

  const { rewrite, tokensUsed: rewriteTokens } = await rewriteResume(
    run,
    resumeText,
    args.job,
    original.score.missingKeywords,
    original.score.formatIssues
  )
  tokensUsed += rewriteTokens

  const rescored = await scoreResume(run, rewrite, args.job)
  tokensUsed += rescored.tokensUsed

  return {
    ...original.score,
    suggestedRewrite: rewrite,
    rescore: rescored.score,
    tokensUsed,
  }
}

export interface OptimizeAndSaveArgs extends OptimizeResumeArgs {
  /** Supabase client used to persist the rewrite (admin, or RLS-scoped). */
  client: SupabaseClient
  userId: string
  /** Job this rewrite was tailored for — persisted as a `resume_documents` version. */
  jobId: string
  title?: string | null
  /** Provenance for the saved version. Defaults to 'tailored'. */
  source?: ResumeSource
}

export interface OptimizeAndSaveResult extends ResumeOptimizerResult {
  document: ResumeDocument
}

/**
 * Run optimizeResume() and persist `suggestedRewrite` as a new
 * `resume_documents` version (source 'tailored' by default) via the shared
 * resume store, scored with the post-rewrite ATS score. This is what turns the
 * one-shot optimizer preview into a saved, versioned, editable resume — see
 * app/api/resume/documents (generate action).
 */
export async function optimizeResumeAndSave(args: OptimizeAndSaveArgs): Promise<OptimizeAndSaveResult> {
  const result = await optimizeResume(args)
  const document = await createVersion(args.client, {
    userId: args.userId,
    jobId: args.jobId,
    title: args.title ?? null,
    content: result.suggestedRewrite,
    atsScore: result.rescore.atsScore,
    source: args.source ?? 'tailored',
  })
  return { ...result, document }
}
