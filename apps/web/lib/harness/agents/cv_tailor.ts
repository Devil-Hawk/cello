// Agent: cv_tailor — tailor a resume summary + cover letter for a specific job.
//
// OWNER: P4 apply workstream. HARD RULE (embedded in the prompt AND enforced by
// framing): rewrites NEVER fabricate — they only surface / rephrase content that
// is TRUE in the user's resume (profiles.resume_text). Keyword mirroring means
// reformulate, never invent (career-ops _shared.md + cover.md rules, adapted).
//
// Prompt rules adapted from career-ops modes/_shared.md and modes/cover.md,
// MIT License, Copyright (c) 2026 Santiago Fernández de Valderrama
// (full text in career-ops/LICENSE).
//
// Uses ctx.llm so tokens are metered against the run budget. Output satisfies
// CvTailorOutput.

import type { AgentFn } from '../types'
import { CvTailorInput } from '../schemas'
import { parseJsonLoose, TruncatedResponseError } from '../llm'
import { composeSystemPrompt, loadModeDoc } from '../prompts'

const MAX_RESUME_CHARS = 12_000
const MAX_JD_CHARS = 8_000
const MAX_TOKENS = 2048

/**
 * System prompt = _shared.md + _voice.md + prompts/cv_tailor.md (the house-style
 * mode document — see docs/PROMPT-GENERATOR.md) + the candidate's resume. The
 * resume is the large, stable part reused across every job this user tailors
 * for — that's the cacheable prefix. The job block (below, in the user prompt)
 * is what actually changes call to call.
 */
function systemWithResume(resumeText: string): string {
  return composeSystemPrompt({
    mode: loadModeDoc('cv_tailor'),
    stableContext: `CANDIDATE RESUME (the ONLY source of truth for claims):\n${resumeText.slice(0, MAX_RESUME_CHARS)}`,
  })
}

interface JobRow {
  id: string
  title: string | null
  description: string | null
  location: string | null
  url: string | null
  company_id: string | null
  companies?: { name?: string | null } | { name?: string | null }[] | null
}

function companyName(job: JobRow): string {
  const c = job.companies
  if (Array.isArray(c)) return c[0]?.name ?? 'the company'
  return c?.name ?? 'the company'
}

export const cv_tailor: AgentFn = async (ctx) => {
  const input = CvTailorInput.parse(ctx.input ?? {})

  // Load the job + its company name.
  const { data: jobData, error: jobErr } = await ctx.admin
    .from('jobs')
    .select('id, title, description, location, url, company_id, companies(name)')
    .eq('id', input.jobId)
    .single()
  if (jobErr || !jobData) {
    throw new Error(`cv_tailor: job ${input.jobId} not found: ${jobErr?.message ?? 'no row'}`)
  }
  const job = jobData as JobRow

  // Resume text: explicit input wins, else the user's stored resume.
  let resumeText = input.resumeText?.trim()
  if (!resumeText) {
    const { data: profile } = await ctx.admin
      .from('profiles')
      .select('resume_text')
      .eq('id', ctx.userId)
      .single()
    resumeText = ((profile?.resume_text as string | null) ?? '').trim()
  }
  if (!resumeText) {
    throw new Error('cv_tailor: no resume on file — upload a resume before tailoring')
  }

  const description = (job.description ?? '').slice(0, MAX_JD_CHARS)
  const userPrompt = [
    `JOB TITLE: ${job.title ?? '(untitled)'}`,
    `COMPANY: ${companyName(job)}`,
    job.location ? `LOCATION: ${job.location}` : '',
    '',
    'JOB DESCRIPTION:',
    description || '(no description provided)',
    !description
      ? 'The job has no description — mirror only the title/company; do not guess at requirements ' +
        'the description never stated.'
      : '',
    '',
    'Using the resume given in the system prompt as your only source of truth, produce the tailored',
    'resume summary + cover letter as JSON per the system rules.',
  ]
    .filter(Boolean)
    .join('\n')

  const base = {
    system: systemWithResume(resumeText),
    prompt: userPrompt,
    json: true,
    maxTokens: MAX_TOKENS,
    temperature: 0.4,
    // Tailoring is synthesis a human will act on (it goes to a real employer),
    // and the honesty constraint has to be applied judgement-by-judgement
    // across the whole letter — worth the reasoning spend.
    reasoning: { effort: 'medium' as const },
    // The resume (in `system`, above) is identical across every job this
    // user tailors for — a real, reused cache prefix.
    cachePrefix: true,
  }
  let res
  try {
    res = await ctx.llm(base)
  } catch (err) {
    // Reasoning tokens bill as output and share the same cap as the JSON
    // body; retry once wider rather than failing the whole tailor call.
    if (!(err instanceof TruncatedResponseError)) throw err
    res = await ctx.llm({ ...base, maxTokens: MAX_TOKENS * 2 })
  }

  let parsed: { resumeSummary?: unknown; coverLetter?: unknown; keywords?: unknown }
  try {
    parsed = parseJsonLoose(res.content)
  } catch {
    throw new Error('cv_tailor: model did not return valid JSON')
  }

  const resumeSummary = typeof parsed.resumeSummary === 'string' ? parsed.resumeSummary.trim() : ''
  const coverLetter = typeof parsed.coverLetter === 'string' ? parsed.coverLetter.trim() : ''
  const keywords = Array.isArray(parsed.keywords)
    ? parsed.keywords.filter((k): k is string => typeof k === 'string' && k.trim().length > 0).slice(0, 20)
    : []

  if (!resumeSummary && !coverLetter) {
    throw new Error('cv_tailor: model returned empty summary and cover letter')
  }

  return {
    output: { jobId: input.jobId, resumeSummary, coverLetter, keywords },
    // ctx.llm already metered the tokens.
    tokensUsed: 0,
  }
}
