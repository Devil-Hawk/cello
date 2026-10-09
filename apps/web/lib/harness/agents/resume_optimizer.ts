// Resume ATS optimizer — the jobright-style "score my resume vs this job" loop.
//
// Given the user's resume text and a target job, this returns:
//   - atsScore (0-100)       ATS keyword/format fit of the ORIGINAL resume
//   - missingKeywords[]      job keywords absent from the resume
//   - formatIssues[]         concrete ATS-format problems (tables, headers, etc.)
//   - suggestedRewrite       an improved resume that ONLY surfaces/rephrases
//                            content already true in the original (NEVER fabricates),
//                            as plain text
//   - resume                 the same rewrite as a structured Resume (what gets saved)
//   - rescore                a fresh ATS score of the suggestedRewrite (the loop)
//
// THE REWRITE IS A PATCH. The model returns only what it changes (summary,
// skills, highlights per entry index) as strict JSON; lib/resume/tailor.ts
// merges it into the structured base in code, so employers, titles, dates,
// education and the template cannot change, and every suggestion is measured
// against the base text and dropped (with a warning) if it is not in it.
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
import { composeSystemPrompt, loadModeDoc, promptRef } from '../prompts'
import { createResumeVersion } from '@/lib/resume/store'
import { resumeToPlainText } from '@/lib/resume/render'
import { resolveResume } from '@/lib/resume/resolve'
import {
  TailorPatchSchema,
  llmJsonSchema,
  type NameContext,
  type Resume,
  type TailorPatch,
} from '@/lib/resume/schema'
import { applyTailorPatch, rankBulletsForJob } from '@/lib/resume/tailor'
import type { ResumeDocument, ResumeSource } from '@/lib/resume/types'

const RESUME_LIMIT = 12000
const DESC_LIMIT = 6000
// Ceiling on the tailoring patch. A patch carries a summary, skills and the
// highlights of every entry, which is most of a resume's bullets; 4096 leaves
// headroom for a dense multi-page one, and a clipped answer retries at double.
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
  /** resumeToPlainText(resume): the ATS text of the tailored resume. */
  suggestedRewrite: string
  /** The merged, validated document, so savers never re-parse text. */
  resume: Resume
  /** Suggestions dropped because they were not in the base resume. */
  warnings: string[]
  /** What moved or was reworded, and why, in words (from the patch that was kept). */
  changes: string[]
  /** Fresh ATS score of `suggestedRewrite`. */
  rescore: AtsScore
  tokensUsed: number
}

export interface OptimizeResumeArgs {
  resumeText: string
  /**
   * The structured base, when the caller has one. Without it the base is
   * derived deterministically from `resumeText` (no LLM call), so a caller with
   * only profiles.resume_text still gets a structured merge.
   */
  base?: Resume
  /** Profile name and email, for the name fallback when deriving the base. */
  nameCtx?: NameContext
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
    promptRef: promptRef('resume_optimizer'),
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

/** "work[0]: Senior Engineer, Acme": the addressable entries the patch refers to. */
function entryIndex(base: Resume): string {
  // Each entry with its own bullets, so a patch for work[0] can only be about work[0]'s bullets.
  const bullets = (hs: string[]) => hs.map((h) => `    - ${h}`).join('\n')
  const lines = [
    ...base.work.map((w, i) => `work[${i}]: ${[w.position, w.name].filter(Boolean).join(', ')}\n${bullets(w.highlights)}`),
    ...base.projects.map((p, i) => `projects[${i}]: ${p.name}\n${bullets(p.highlights)}`),
  ]
  return lines.join('\n') || '(no entries)'
}

function rewritePrompt(
  job: ResumeOptimizerJob,
  missingKeywords: string[],
  formatIssues: string[],
  base: Resume
): string {
  return (
    `TARGET JOB:\n${jobBlock(job)}\n\n` +
    `Keywords the job wants that may be under-surfaced; incorporate ONLY those the ORIGINAL RESUME ` +
    `already supports: ${missingKeywords.join(', ') || '(none)'}\n` +
    `Format issues to fix: ${formatIssues.join('; ') || '(none)'}\n\n` +
    `ENTRIES (refer to them by index):\n${entryIndex(base)}\n\n` +
    `How to tailor: (1) For every work entry, return its own bullets with the ones most relevant to the TARGET JOB first, ` +
    `rewording a bullet only to use the job's vocabulary where the bullet already says the same thing. Keep every bullet of ` +
    `that entry, add none, and never move a bullet to another entry. (2) Reword the summary so its first sentence speaks to this ` +
    `role, using only facts already in the resume. (3) In skills, move the keywords the job asks for and the resume already has to the front.\n\n` +
    `Return the patch now: only the fields you change.`
  )
}

function issuePaths(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .slice(0, 12)
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('; ')
}

async function rewriteResume(
  run: LlmRunner,
  base: Resume,
  job: ResumeOptimizerJob,
  missingKeywords: string[],
  formatIssues: string[]
): Promise<{ patch: TailorPatch; tokensUsed: number }> {
  const opts: LlmRunOptions = {
    system: resumeSystem(resumeToPlainText(base)),
    promptRef: promptRef('resume_optimizer'),
    prompt: rewritePrompt(job, missingKeywords, formatIssues, base),
    json: true,
    jsonSchema: { name: 'tailor_patch', schema: llmJsonSchema(TailorPatchSchema) },
    maxTokens: REWRITE_MAX_TOKENS,
    temperature: 0.3,
    // The honesty constraint is a judgement call applied across a whole
    // document, not mechanical formatting: this is where reasoning quality
    // matters most in this file.
    reasoning: { effort: 'medium' },
    cachePrefix: true,
  }
  let tokensUsed = 0
  let problem: string | null = null
  // One re-ask with the Zod issue paths, then fail: no partial or unstructured
  // version is ever saved.
  for (let attempt = 0; attempt < 2; attempt++) {
    const call: LlmRunOptions = problem
      ? { ...opts, prompt: `${opts.prompt}\n\nYour previous answer was invalid: ${problem}\nReturn the corrected JSON.` }
      : opts
    let res: LlmResult
    try {
      res = await run(call)
    } catch (err) {
      // Reasoning tokens bill as output and share the cap, so a verbose pass
      // can clip it; retry once wider rather than failing the whole run.
      if (!(err instanceof TruncatedResponseError)) throw err
      res = await run({ ...call, maxTokens: REWRITE_MAX_TOKENS * 2 })
    }
    tokensUsed += res.tokensUsed
    let raw: unknown
    try {
      raw = parseJsonLoose(res.content)
    } catch {
      problem = '(root): not valid JSON'
      continue
    }
    const parsed = TailorPatchSchema.safeParse(raw)
    if (parsed.success) return { patch: parsed.data, tokensUsed }
    problem = issuePaths(parsed.error)
  }
  throw new Error('Could not produce a valid tailored resume; nothing was saved')
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
      return callLlm(args.apiKeys, { ...opts, name: opts.name ?? 'optimize-resume' }, args.signal)
    })

  let tokensUsed = 0

  // The structured base. Scoring, the rewrite and the rescore all read its
  // rendered text, so the before and after scores compare like with like.
  const base =
    args.base ?? resolveResume({ content: resumeText, content_json: null }, args.nameCtx)
  const basePlain = resumeToPlainText(base)

  const original = await scoreResume(run, basePlain, args.job)
  tokensUsed += original.tokensUsed

  const { patch, tokensUsed: rewriteTokens } = await rewriteResume(
    run,
    base,
    args.job,
    original.score.missingKeywords,
    original.score.formatIssues
  )
  tokensUsed += rewriteTokens

  const patched = applyTailorPatch(base, patch)
  const { warnings } = patched
  // Then, in code, the bullets that match the posting best lead each job.
  const ranked = rankBulletsForJob(patched.resume, args.job)
  const resume = ranked.resume
  const changes = [...patched.changes, ...ranked.changes]
  const rewrite = resumeToPlainText(resume)

  const rescored = await scoreResume(run, rewrite, args.job)
  tokensUsed += rescored.tokensUsed

  return {
    ...original.score,
    suggestedRewrite: rewrite,
    resume,
    warnings,
    changes,
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
 * Run optimizeResume() and persist the structured `resume` as a new
 * `resume_documents` version (source 'tailored' by default) via the shared
 * resume store, scored with the post-rewrite ATS score. This is what turns the
 * one-shot optimizer preview into a saved, versioned, editable resume — see
 * app/api/resume/documents (generate action).
 */
export async function optimizeResumeAndSave(args: OptimizeAndSaveArgs): Promise<OptimizeAndSaveResult> {
  const result = await optimizeResume(args)
  const document = await createResumeVersion(args.client, {
    userId: args.userId,
    jobId: args.jobId,
    title: args.title ?? null,
    resume: result.resume,
    atsScore: result.rescore.atsScore,
    source: args.source ?? 'tailored',
  })
  return { ...result, document }
}
