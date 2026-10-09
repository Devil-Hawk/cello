// Agent: analyst — deep per-job analysis (summary, talking points, company
// insights) for the job-detail modal's "AI insights" panel.
//
// Ported from packages/agents/src/analyst/* (index.ts/analysis.ts/
// llm-client.ts/errors.ts/prompts.ts) onto ctx.llm, so this call is metered/
// demo-gated/journaled through the same chokepoints as every other unit (see
// lib/graph/unit.ts's header) instead of routing through
// packages/agents/src/analyst/llm-client.ts's own hand-rolled OpenAI/
// Anthropic fetch clients. app/api/agents/analyze/route.ts's consumer
// (components/jobs/job-detail-modal.tsx) depends on this staying exact in two
// places: the OUTPUT shape ({summary, talkingPoints, companyInsights}, plus
// `thin`, and strings in the two lists).
//
// THE PROMPT is prompts/analyst.md, rewritten from scratch (the verbatim port
// of packages/agents' prompt asked the model to infer culture from writing
// style and cited nothing). It now receives the resume and the posting as
// numbered lines and answers with items that cite them; parseAnalysis below
// drops any item whose citations do not exist or share no word with it.
//
// HONESTY CONTRACT (preserved from packages/agents/src/analyst/analysis.ts):
// every failure branch below THROWS an AnalystError. There is no
// createFallbackResponse()-shaped substitute anywhere in this file, and
// there must never be one again — a parse failure that quietly returned
// canned advice ("Look up employee reviews on Glassdoor...") in the exact
// shape of a real analysis is the bug packages/agents/src/analyst/errors.ts
// was written to keep dead. app/api/agents/analyze/route.ts reads
// AnalystError.code below to pick an HTTP status.
//
// NOT PORTED: packages/agents' CompanyInsightsCache. It cached insights
// keyed by companyId on the AnalystAgent INSTANCE, but the pre-port route
// constructed `new AnalystAgent()` fresh on every request — the cache was
// discarded before it could ever be read back, so it had zero observable
// effect in production. A per-call unit has nowhere safer to put a
// cross-request cache than a bare module-scope Map, which — unlike the
// original's per-instance Map — really would leak insights across users on a
// warm serverless instance. Reintroduce only with an explicit per-user scope.

import type { AgentFn } from '../types'
import { AnalystInput } from '../schemas'
import { frameJobText } from '@/lib/security/job-text'
import { MissingKeyError, parseJsonLoose } from '../llm'
import { BudgetCapError } from '../spend'
import { composeSystemPrompt, loadModeDoc, promptRef } from '../prompts'
import { citesSupport, cleanCites, mergeLines, numberLines } from '@/lib/quality/lines'

/**
 * Why an analysis could not be produced — mirrors packages/agents/src/
 * analyst/errors.ts#AnalysisFailureCode (minus 'invalid_input': that code
 * covered a caller passing no user/no jobs, which cannot happen here — the
 * unit's input is a schema-validated jobId, and app/api/agents/analyze/
 * route.ts already 400s on a missing one before ever calling this unit).
 */
export type AnalystErrorCode =
  | 'no_resume'
  | 'no_api_key'
  | 'provider_auth'
  | 'rate_limited'
  | 'provider_error'
  | 'empty_response'
  | 'unparseable_response'
  | 'incomplete_response'

/** Setup gaps are not worth retrying as-is; provider hiccups and bad model
 *  output are. Mirrors packages/agents/src/analyst/errors.ts#RETRYABLE. */
const RETRYABLE: Record<AnalystErrorCode, boolean> = {
  no_resume: false,
  no_api_key: false,
  provider_auth: false,
  rate_limited: true,
  provider_error: true,
  empty_response: true,
  unparseable_response: true,
  incomplete_response: true,
}

/** The only way this unit reports "no analysis" — see the file header's
 *  honesty contract. */
export class AnalystError extends Error {
  readonly code: AnalystErrorCode
  readonly retryable: boolean
  readonly providerStatus?: number

  constructor(code: AnalystErrorCode, message: string, providerStatus?: number) {
    super(message)
    this.name = 'AnalystError'
    this.code = code
    this.retryable = RETRYABLE[code]
    this.providerStatus = providerStatus
    // Native subclassing breaks `instanceof` when compiled down by a
    // consumer's bundler — same guard packages/agents/src/analyst/errors.ts
    // used, at the same cost (free at ES2020).
    Object.setPrototypeOf(this, AnalystError.prototype)
  }
}

/**
 * Classify whatever ctx.llm threw into an AnalystError. MissingKeyError is
 * callLlm's own "nothing configured at all" signal (lib/harness/providers) —
 * every other provider failure carries an HTTP status the way the OpenAI
 * SDK's APIError does (lib/harness/llm.test.ts's fakeProviderError models
 * the same shape): 401/403 is a rejected key, 429 is a rate limit, anything
 * else (including a network failure or a TruncatedResponseError that
 * survived runAgentUnit's own one-retry-wider policy) is provider_error.
 */
function classifyLlmFailure(err: unknown): Error {
  // The cap is a distinct, already-typed answer ("you are out of allowance"),
  // not a provider failure — pass it through unwrapped so the route can give
  // it the 429 + budgetExhausted treatment it always has, instead of folding
  // it into a generic provider_error.
  if (err instanceof BudgetCapError) return err
  if (err instanceof MissingKeyError) {
    return new AnalystError(
      'no_api_key',
      'No AI provider key is configured, so no analysis was generated. Add an OpenRouter key in Settings → API keys.'
    )
  }
  const status =
    err && typeof err === 'object' && typeof (err as { status?: unknown }).status === 'number'
      ? (err as { status: number }).status
      : undefined
  if (status === 401 || status === 403) {
    return new AnalystError(
      'provider_auth',
      `The AI provider rejected the API key (HTTP ${status}). Check the key in Settings → API keys.`,
      status
    )
  }
  if (status === 429) {
    return new AnalystError(
      'rate_limited',
      'The AI provider rate-limited the analysis. Wait a moment and try again.',
      status
    )
  }
  const message = err instanceof Error ? err.message : String(err)
  return new AnalystError('provider_error', message || 'The analysis failed to run.', status)
}

// --- prompt (prompts/analyst.md) --------------------------------------------

/** A posting with less description than this gives the model little to cite. */
export const THIN_POSTING_CHARS = 300

export interface AnalysisPromptInput {
  jobTitle: string
  jobDescription: string | null
  companyName: string
  companyNotes?: string | null
  resumeText: string
}

export interface AnalystPrompt {
  system: string
  prompt: string
  /** R and J ids to their text, for checking the model's citations. */
  lines: Map<string, string>
  thin: boolean
}

/** The system and user halves of the analysis call. The resume and the posting
 *  go in as numbered lines; the posting stays inside the untrusted frame. */
export function buildAnalystPrompt(input: AnalysisPromptInput): AnalystPrompt {
  const resume = numberLines(input.resumeText, 'R', { maxLines: 90 })
  const description = (input.jobDescription ?? '').trim()
  // The title is part of the posting, so it is line J1 and can be cited.
  const job = numberLines(`${input.jobTitle}\n${description.slice(0, 12_000)}`, 'J')
  const thin = description.length < THIN_POSTING_CHARS
  const prompt = [
    `COMPANY: ${input.companyName}`,
    input.companyNotes ? `NOTES: ${input.companyNotes}` : '',
    `POSTING LENGTH: ${thin ? 'short' : 'full'}`,
    `RESUME:\n${resume.block}`,
    // INJECTION DEFENCE (lib/security/job-text.ts): the description is
    // EMPLOYER-CONTROLLED, and frameJobText fences it as data before it
    // reaches the prompt; see lib/security/injection-chokepoints.test.ts's
    // PROMPT_BUILDERS entry for this file.
    `JOB:\n${frameJobText(job.block)}`,
  ]
    .filter(Boolean)
    .join('\n\n')
  return {
    system: composeSystemPrompt({ mode: loadModeDoc('analyst') }),
    prompt,
    lines: mergeLines(resume, job),
    thin,
  }
}

// --- response parsing --------------------------------------------------------

/** No `|| 'placeholder'` fallback: a placeholder in the summary slot reads as
 *  the model's verdict on the job. An absent summary is a failed generation,
 *  handled by the caller below. */
function sanitizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Items the model cited properly: {text, cites} where every id exists and the
 *  cited lines share a word with the text. Plain strings carry no citation and
 *  are dropped, as is anything else. */
function citedItems(value: unknown, lines: Map<string, string>): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const text = sanitizeString((item as { text?: unknown }).text)
    if (!text) continue
    if (citesSupport(text, cleanCites((item as { cites?: unknown }).cites), lines)) out.push(text)
  }
  return out
}

export interface ParsedAnalysis {
  summary: string
  talkingPoints: string[]
  companyInsights: string[]
  thin: boolean
}

/** The model's JSON as the panel's shape, keeping only what is cited. A short
 *  posting gets no company insights whatever the model wrote. Throws AnalystError for a response that is not an analysis. */
export function parseAnalysis(raw: string, lines: Map<string, string>, thin: boolean): ParsedAnalysis {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new AnalystError('empty_response', 'The model returned an empty response, so there is no analysis for this job yet.')
  }

  let parsed: unknown
  try {
    parsed = parseJsonLoose(trimmed)
  } catch {
    throw new AnalystError('unparseable_response', 'The model replied, but not with the structured analysis Cello asked for.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AnalystError('incomplete_response', 'The model returned JSON that was not an analysis object.')
  }

  const fields = parsed as Record<string, unknown>
  const summary = sanitizeString(fields.summary)
  const talkingPoints = citedItems(fields.talkingPoints, lines)
  const companyInsights = thin ? [] : citedItems(fields.companyInsights, lines)

  // A partial analysis is still honest: every item rendered is cited. A short
  // posting may leave nothing but the summary, which then says so. Otherwise a
  // response with no summary, or nothing in ANY section, is a failed generation
  // dressed as a result: refuse it rather than let the modal announce insights
  // and show nothing.
  const hasAnySection = talkingPoints.length > 0 || companyInsights.length > 0
  if (!summary || (!hasAnySection && !thin)) {
    throw new AnalystError(
      'incomplete_response',
      'The model returned an incomplete analysis, so there is nothing reliable to show for this job.'
    )
  }
  return { summary, talkingPoints, companyInsights, thin }
}

// --- DB shape ----------------------------------------------------------------

interface JobRow {
  id: string
  title: string | null
  description: string | null
  viewer_company_id: string | null
  viewer_company_name: string | null
}

export const analyst: AgentFn = async (ctx) => {
  const input = AnalystInput.parse(ctx.input ?? {})

  const { data: jobData, error: jobErr } = await ctx.admin
    .from('person_jobs')
    .select('id, title, description, viewer_company_id, viewer_company_name')
    .eq('viewer_id', ctx.userId)
    .eq('id', input.jobId)
    .single()
  if (jobErr || !jobData) {
    throw new Error(`analyst: job ${input.jobId} not found: ${jobErr?.message ?? 'no row'}`)
  }
  const job = jobData as JobRow
  const companyName = job.viewer_company_name ?? 'Unknown Company'
  // Notes are the person's own, so they come from their company, never the shared role's first owner.
  const { data: companyRow } = job.viewer_company_id
    ? await ctx.admin.from('companies').select('notes').eq('id', job.viewer_company_id).eq('user_id', ctx.userId).maybeSingle()
    : { data: null }
  const companyNotes = (companyRow as { notes?: string | null } | null)?.notes ?? null

  const { data: profile } = await ctx.admin.from('profiles').select('resume_text').eq('id', ctx.userId).single()
  const resumeText = ((profile?.resume_text as string | null) ?? '').trim()
  if (!resumeText) {
    throw new AnalystError(
      'no_resume',
      'Upload your resume in Settings — the analysis compares this job against it.'
    )
  }

  const built = buildAnalystPrompt({
    jobTitle: job.title ?? '(untitled)',
    jobDescription: job.description,
    companyName,
    companyNotes,
    resumeText,
  })

  let res
  try {
    res = await ctx.llm({
      system: built.system,
      prompt: built.prompt,
      json: true,
      maxTokens: 2000,
      // Prep notes must stay on the page in front of the model: low temperature.
      temperature: 0.2,
      cachePrefix: true,
      promptRef: promptRef('analyst'),
    })
  } catch (err) {
    throw classifyLlmFailure(err)
  }

  const output = parseAnalysis(res.content, built.lines, built.thin)

  return {
    output,
    // ctx.llm already metered the tokens.
    tokensUsed: 0,
  }
}
