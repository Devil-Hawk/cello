// Agent: analyst — deep per-job analysis (summary, talking points, company
// insights, interview tips) for the job-detail modal's "AI insights" panel.
//
// Ported from packages/agents/src/analyst/* (index.ts/analysis.ts/
// llm-client.ts/errors.ts/prompts.ts) onto ctx.llm, so this call is metered/
// demo-gated/journaled through the same chokepoints as every other unit (see
// lib/graph/unit.ts's header) instead of routing through
// packages/agents/src/analyst/llm-client.ts's own hand-rolled OpenAI/
// Anthropic fetch clients. app/api/agents/analyze/route.ts's consumer
// (components/jobs/job-detail-modal.tsx) depends on this staying exact in two
// places: the OUTPUT shape ({summary, talkingPoints, companyInsights,
// interviewTips} — nothing else) and the PROMPT itself
// (ANALYST_SYSTEM_PROMPT / generateFullAnalysisPrompt below, copied verbatim
// from packages/agents/src/analyst/prompts.ts) — a differently-worded prompt
// is a different analysis, which is exactly what "preserve exactly" rules
// out here.
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

// --- prompt (verbatim from packages/agents/src/analyst/prompts.ts) ---------

const ANALYST_SYSTEM_PROMPT = `You are an expert career analyst and interview coach. You use structured reasoning to analyze job opportunities and provide actionable preparation guidance.

## Your Reasoning Process

Before answering, you MUST think through each step carefully:

1. **UNDERSTAND** - Read and comprehend the job requirements fully
2. **ANALYZE** - Compare against the candidate's background systematically
3. **SYNTHESIZE** - Form connections and insights
4. **VALIDATE** - Check your conclusions make sense
5. **RESPOND** - Provide clear, actionable output

## Quality Standards

- Be SPECIFIC - generic advice is unhelpful
- Be HONEST - acknowledge gaps, don't oversell
- Be ACTIONABLE - every point should be something they can DO
- Be CONCISE - respect the candidate's time

Always respond in the exact JSON format requested.`

interface AnalysisPromptInput {
  jobTitle: string
  jobDescription: string
  companyName: string
  companyNotes?: string | null
  resumeText: string
}

function generateFullAnalysisPrompt(input: AnalysisPromptInput): string {
  return `Analyze this job opportunity and provide interview preparation guidance.

## INPUT DATA

### Job Details
**Title:** ${input.jobTitle}
**Company:** ${input.companyName}
${input.companyNotes ? `**Company Notes:** ${input.companyNotes}` : ''}

**Full Job Description:**
${input.jobDescription}

### Candidate Resume
${input.resumeText}

---

## YOUR ANALYSIS PROCESS

Think through this step by step:

### Step 1: Job Requirements Extraction
<think>
First, identify the KEY requirements from this job:
- What are the MUST-HAVE skills? (explicitly stated as required)
- What are the NICE-TO-HAVE skills? (preferred/bonus)
- What experience level is needed?
- What domain knowledge is important?
- What soft skills or traits are emphasized?
</think>

### Step 2: Candidate-Job Fit Analysis
<think>
Now compare the candidate's resume to these requirements:
- Which requirements does the candidate STRONGLY match?
- Which requirements are a PARTIAL match?
- What GAPS exist that the candidate should address?
- What TRANSFERABLE skills could bridge gaps?
</think>

### Step 3: Company & Culture Analysis
<think>
Based on the job description language and any notes:
- What does the writing style suggest about company culture?
- What values seem important to this company?
- What kind of work environment is implied?
- What growth/impact opportunities are mentioned?
</think>

### Step 4: Interview Strategy Formulation
<think>
Given the fit analysis:
- What stories/examples should the candidate prepare?
- What technical topics need review?
- What behavioral questions are likely?
- What questions should the candidate ask?
</think>

---

## OUTPUT

Now provide your analysis in this exact JSON format:

{
  "summary": "[2-3 sentence summary of the role and fit]",
  "talkingPoints": [
    "[Point 1: Connect specific resume experience to specific job requirement]",
    "[Point 2: Another concrete match with example/metric]",
    "[Point 3: Transferable skill that addresses a requirement]",
    "[Point 4: Unique value proposition]",
    "[Point 5: Cultural/soft skill alignment]"
  ],
  "companyInsights": [
    "[Insight about company culture from job description]",
    "[Insight about team dynamics or work style]",
    "[Insight about growth/learning opportunities]",
    "[Insight about company values/mission]"
  ],
  "interviewTips": [
    "[Specific technical topic to review with why]",
    "[Behavioral question to prepare with STAR format example topic]",
    "[Question to ask the interviewer that shows insight]",
    "[Preparation activity: research, practice, etc.]",
    "[Mindset or approach tip for this specific role/company]"
  ]
}

IMPORTANT:
- Every talking point must reference SPECIFIC content from both the job description AND resume
- Company insights should be inferred from the job posting, not generic
- Interview tips should be tailored to THIS role, not generic interview advice
- If you cannot find specific evidence, acknowledge uncertainty

Respond with ONLY the JSON object.`
}

// --- response parsing (ported from packages/agents/src/analyst/analysis.ts) -

/** No `|| 'placeholder'` fallback: a placeholder in the summary slot reads as
 *  the model's verdict on the job. An absent summary is a failed generation,
 *  handled by the caller below. */
function sanitizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

// --- DB shape ----------------------------------------------------------------

interface JobRow {
  id: string
  title: string | null
  description: string | null
  company_id: string | null
  companies?: { name?: string | null; notes?: string | null } | { name?: string | null; notes?: string | null }[] | null
}

function companyFields(job: JobRow): { name: string; notes: string | null } {
  const c = job.companies
  const row = Array.isArray(c) ? c[0] : c
  return { name: row?.name ?? 'Unknown Company', notes: row?.notes ?? null }
}

export const analyst: AgentFn = async (ctx) => {
  const input = AnalystInput.parse(ctx.input ?? {})

  const { data: jobData, error: jobErr } = await ctx.admin
    .from('jobs')
    .select('id, title, description, company_id, companies(name, notes)')
    .eq('id', input.jobId)
    .single()
  if (jobErr || !jobData) {
    throw new Error(`analyst: job ${input.jobId} not found: ${jobErr?.message ?? 'no row'}`)
  }
  const job = jobData as JobRow
  const { name: companyName, notes: companyNotes } = companyFields(job)

  const { data: profile } = await ctx.admin.from('profiles').select('resume_text').eq('id', ctx.userId).single()
  const resumeText = ((profile?.resume_text as string | null) ?? '').trim()
  if (!resumeText) {
    throw new AnalystError(
      'no_resume',
      'Upload your resume in Settings — the analysis compares this job against it.'
    )
  }

  const prompt = generateFullAnalysisPrompt({
    jobTitle: job.title ?? '(untitled)',
    // INJECTION DEFENCE (lib/security/job-text.ts): the description is
    // EMPLOYER-CONTROLLED, and frameJobText fences it as data before it
    // reaches the prompt — see lib/security/injection-chokepoints.test.ts's
    // PROMPT_BUILDERS entry for this file.
    jobDescription: frameJobText(job.description),
    companyName,
    companyNotes,
    resumeText,
  })

  let res
  try {
    res = await ctx.llm({ system: ANALYST_SYSTEM_PROMPT, prompt, json: true, maxTokens: 2000, temperature: 0.7 })
  } catch (err) {
    throw classifyLlmFailure(err)
  }

  const raw = res.content.trim()
  if (!raw) {
    throw new AnalystError(
      'empty_response',
      'The model returned an empty response, so there is no analysis for this job yet.'
    )
  }

  let parsed: unknown
  try {
    parsed = parseJsonLoose(raw)
  } catch {
    throw new AnalystError(
      'unparseable_response',
      'The model replied, but not with the structured analysis Cello asked for.'
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AnalystError('incomplete_response', 'The model returned JSON that was not an analysis object.')
  }

  const fields = parsed as Record<string, unknown>
  const summary = sanitizeString(fields.summary)
  const talkingPoints = sanitizeStringArray(fields.talkingPoints)
  const companyInsights = sanitizeStringArray(fields.companyInsights)
  const interviewTips = sanitizeStringArray(fields.interviewTips)

  // A partial analysis is still honest — every section rendered is real
  // model output, and empty sections just don't render. But a response with
  // no summary, or nothing in ANY section, is a failed generation dressed as
  // a result: refuse it rather than let the modal announce insights and show
  // nothing.
  const hasAnySection = talkingPoints.length > 0 || companyInsights.length > 0 || interviewTips.length > 0
  if (!summary || !hasAnySection) {
    throw new AnalystError(
      'incomplete_response',
      'The model returned an incomplete analysis, so there is nothing reliable to show for this job.'
    )
  }

  return {
    output: { summary, talkingPoints, companyInsights, interviewTips },
    // ctx.llm already metered the tokens.
    tokensUsed: 0,
  }
}
