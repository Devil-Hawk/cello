// Agent: interview_prep — build a per-job interview prep kit.
//
// Given a target job (+ optional company dossier context) and the candidate's
// REAL resume text, this produces:
//   - questions[]     tailored questions across behavioral / technical /
//                     role-specific / company-specific / reverse categories
//   - star_stories[]  STAR stories drawn ONLY from the candidate's resume
//   - prep_notes      short focused prep guidance
// and upserts them into public.interview_kits (unique on user_id, job_id).
//
// Dual-source module (mirrors resume_optimizer.ts): the core fn accepts either a
// budget-aware LlmRunner (harness metering) OR a DecryptedApiKeys bundle (direct
// OpenRouter, used by the API route). A thin `interview_prep: AgentFn` wrapper
// loads context from ctx.admin and calls the core with ctx.llm.
//
// HARD HONESTY RULE (STAR stories): the model may reorganize, rephrase, and
// surface content the candidate GENUINELY has in the resume, mirroring the job's
// vocabulary — it may NEVER invent employers, titles, dates, degrees, metrics, or
// skills that are not already supported by the resume. Silence beats fabrication.

import type {
  AdminClient,
  AgentFn,
  DecryptedApiKeys,
  LlmResult,
  LlmRunner,
  LlmRunOptions,
} from '../types'
import { callLlm, parseJsonLoose } from '../llm'
import { composeSystemPrompt, loadModeDoc } from '../prompts'
import {
  upsertKit,
  type InterviewQuestion,
  type StarStory,
  type KitStatus,
} from '@/lib/interview/store'

const RESUME_LIMIT = 12_000
const DESC_LIMIT = 6_000
const DOSSIER_LIMIT = 2_000

export interface InterviewPrepJob {
  id: string
  title: string | null
  description?: string | null
  location?: string | null
  company_id?: string | null
}

export interface InterviewPrepCompany {
  id?: string | null
  name?: string | null
}

export interface InterviewPrepDossier {
  summary?: string | null
  signals?: unknown
}

/** The single hard contract this agent returns (see plan Contract C). */
export interface InterviewPrepOutput {
  kitId: string | null
  jobId: string
  questionCount: number
  starCount: number
  status: 'ready' | 'practiced'
  needsResume?: boolean
  needsKey?: boolean
}

export interface GenerateInterviewKitArgs {
  job: InterviewPrepJob
  company?: InterviewPrepCompany | null
  dossier?: InterviewPrepDossier | null
  resumeText: string
  admin: AdminClient
  userId: string
  /** Preferred: budget-aware runner (harness). */
  llm?: LlmRunner
  /** Fallback: direct OpenRouter call with the user's key. */
  apiKeys?: DecryptedApiKeys
  signal?: AbortSignal
}

/**
 * The resume is the one large block that stays IDENTICAL across every prep kit
 * a given user generates (job/dossier vary per call, the resume doesn't) — so
 * it belongs in `system` with `cachePrefix: true`, not re-sent fresh in every
 * `prompt`. The mode document (prompts/interview_prep.md — see
 * docs/PROMPT-GENERATOR.md) never changes across users either, so the whole
 * combined system message is a cache hit from the 2nd call on.
 */
function buildSystem(resumeText: string): string {
  return composeSystemPrompt({
    mode: loadModeDoc('interview_prep'),
    stableContext:
      "CANDIDATE RESUME (the ONLY source of truth for STAR stories and any claim about the candidate's experience):\n" +
      resumeText.slice(0, RESUME_LIMIT),
  })
}

function companyName(company?: InterviewPrepCompany | null): string {
  return (company?.name ?? '').trim() || 'the company'
}

function dossierBlock(dossier?: InterviewPrepDossier | null): string {
  if (!dossier) return ''
  const parts: string[] = []
  const summary = (dossier.summary ?? '').trim()
  if (summary) parts.push(summary)
  if (dossier.signals) {
    try {
      parts.push(JSON.stringify(dossier.signals))
    } catch {
      /* ignore unserializable signals */
    }
  }
  return parts.join('\n').slice(0, DOSSIER_LIMIT)
}

function buildPrompt(args: GenerateInterviewKitArgs): string {
  const dossier = dossierBlock(args.dossier)
  return [
    `JOB TITLE: ${args.job.title ?? '(untitled)'}`,
    `COMPANY: ${companyName(args.company)}`,
    args.job.location ? `LOCATION: ${args.job.location}` : '',
    '',
    'JOB DESCRIPTION:',
    (args.job.description ?? '').slice(0, DESC_LIMIT) ||
      '(none provided — base technical/role-specific questions on the title alone, and flag that in prep_notes)',
    '',
    dossier
      ? 'COMPANY CONTEXT (public research — for company-specific questions):'
      : '(no company context provided — skip or generalize company-specific questions, and flag that in prep_notes)',
    dossier,
    '',
    'Produce the interview prep kit as JSON per the system rules.',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

function normalizeQuestions(raw: unknown): InterviewQuestion[] {
  if (!Array.isArray(raw)) return []
  const out: InterviewQuestion[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const q = item as Record<string, unknown>
    const question = typeof q.question === 'string' ? q.question.trim() : ''
    if (!question) continue
    out.push({
      category: typeof q.category === 'string' && q.category.trim() ? q.category.trim() : 'behavioral',
      question,
      guidance: typeof q.guidance === 'string' ? q.guidance.trim() : '',
      sampleAnswer: typeof q.sampleAnswer === 'string' ? q.sampleAnswer.trim() : '',
    })
  }
  return out
}

function normalizeStories(raw: unknown): StarStory[] {
  if (!Array.isArray(raw)) return []
  const out: StarStory[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const s = item as Record<string, unknown>
    const situation = typeof s.situation === 'string' ? s.situation.trim() : ''
    const action = typeof s.action === 'string' ? s.action.trim() : ''
    if (!situation && !action) continue
    out.push({
      situation,
      task: typeof s.task === 'string' ? s.task.trim() : '',
      action,
      result: typeof s.result === 'string' ? s.result.trim() : '',
      mapsToQuestion: typeof s.mapsToQuestion === 'string' ? s.mapsToQuestion.trim() : '',
    })
  }
  return out
}

/**
 * Generate the interview kit and upsert it into interview_kits. Provide either
 * `llm` (metered harness runner) or `apiKeys` (direct OpenRouter). Degrades
 * gracefully: no resume → { needsResume }, no key → { needsKey } (nothing
 * persisted in either case).
 */
export async function generateInterviewKit(
  args: GenerateInterviewKitArgs
): Promise<InterviewPrepOutput> {
  const jobId = args.job.id
  const status: KitStatus = 'ready'
  const empty: InterviewPrepOutput = {
    kitId: null,
    jobId,
    questionCount: 0,
    starCount: 0,
    status,
  }

  const resumeText = (args.resumeText ?? '').trim()
  if (!resumeText) return { ...empty, needsResume: true }

  const hasKey = args.llm != null || args.apiKeys?.openrouter != null
  if (!hasKey) return { ...empty, needsKey: true }

  const run: LlmRunner =
    args.llm ??
    ((opts: LlmRunOptions): Promise<LlmResult> => {
      if (!args.apiKeys) throw new Error('generateInterviewKit requires either `llm` or `apiKeys`')
      return callLlm(args.apiKeys, opts, args.signal)
    })

  const res = await run({
    system: buildSystem(resumeText),
    prompt: buildPrompt({ ...args, resumeText }),
    json: true,
    // 2600 was already close to typical usage for 8-14 questions + 3-5 STAR
    // stories; reasoning tokens are additive on top of that (billed as output),
    // so this needs real headroom, not just the content itself.
    maxTokens: 4096,
    temperature: 0.4,
    // Real synthesis under a hard honesty constraint (must map resume facts to
    // questions without inventing anything) — worth the judgement quality.
    reasoning: { effort: 'medium' },
    cachePrefix: true,
  })

  let parsed: { questions?: unknown; star_stories?: unknown; prep_notes?: unknown }
  try {
    parsed = parseJsonLoose(res.content)
  } catch {
    throw new Error('interview_prep: model did not return valid JSON')
  }

  const questions = normalizeQuestions(parsed.questions)
  const starStories = normalizeStories(parsed.star_stories)
  const prepNotes = typeof parsed.prep_notes === 'string' ? parsed.prep_notes.trim() : ''

  if (questions.length === 0) {
    throw new Error('interview_prep: model returned no usable questions')
  }

  const companyId = args.job.company_id ?? args.company?.id ?? null

  const kit = await upsertKit(args.admin, {
    user_id: args.userId,
    job_id: jobId,
    company_id: companyId,
    questions,
    prep_notes: prepNotes,
    star_stories: starStories,
    status,
  })

  return {
    kitId: kit.id,
    jobId,
    questionCount: questions.length,
    starCount: starStories.length,
    status,
  }
}

// --- Harness step wrapper ----------------------------------------------------

interface JobRow {
  id: string
  title: string | null
  description: string | null
  location: string | null
  company_id: string | null
  companies?: { id?: string | null; name?: string | null } | { id?: string | null; name?: string | null }[] | null
}

function firstRel<T>(rel: T | T[] | null | undefined): T | null {
  if (Array.isArray(rel)) return rel[0] ?? null
  return rel ?? null
}

export const interview_prep: AgentFn = async (ctx) => {
  const input = (ctx.input ?? {}) as { jobId?: unknown; resumeText?: unknown }
  const jobId = typeof input.jobId === 'string' ? input.jobId : ''
  if (!jobId) throw new Error('interview_prep: jobId is required')

  // Job + company.
  const { data: jobData, error: jobErr } = await ctx.admin
    .from('jobs')
    .select('id, title, description, location, company_id, companies(id, name)')
    .eq('id', jobId)
    .single()
  if (jobErr || !jobData) {
    throw new Error(`interview_prep: job ${jobId} not found: ${jobErr?.message ?? 'no row'}`)
  }
  const job = jobData as JobRow
  const company = firstRel(job.companies)

  // Resume: explicit input wins, else the user's stored resume.
  let resumeText = typeof input.resumeText === 'string' ? input.resumeText.trim() : ''
  if (!resumeText) {
    const { data: profile } = await ctx.admin
      .from('profiles')
      .select('resume_text')
      .eq('id', ctx.userId)
      .single()
    resumeText = ((profile?.resume_text as string | null) ?? '').trim()
  }

  const output: InterviewPrepOutput = {
    kitId: null,
    jobId,
    questionCount: 0,
    starCount: 0,
    status: 'ready',
  }

  if (!resumeText) {
    return { output: { ...output, needsResume: true }, tokensUsed: 0 }
  }
  // Degrade cleanly with no key — never call the metered runner (it would throw).
  if (!ctx.apiKeys?.openrouter) {
    return { output: { ...output, needsKey: true }, tokensUsed: 0 }
  }

  // Optional dossier context for company-specific questions.
  let dossier: InterviewPrepDossier | null = null
  if (job.company_id) {
    const { data: dossierRow } = await ctx.admin
      .from('company_dossiers')
      .select('summary, signals')
      .eq('company_id', job.company_id)
      .eq('user_id', ctx.userId)
      .maybeSingle()
    if (dossierRow) {
      dossier = {
        summary: (dossierRow as { summary?: string | null }).summary ?? null,
        signals: (dossierRow as { signals?: unknown }).signals ?? null,
      }
    }
  }

  const result = await generateInterviewKit({
    job: {
      id: job.id,
      title: job.title,
      description: job.description,
      location: job.location,
      company_id: job.company_id,
    },
    company: company ? { id: company.id ?? null, name: company.name ?? null } : null,
    dossier,
    resumeText,
    admin: ctx.admin,
    userId: ctx.userId,
    llm: ctx.llm, // metered — key presence already verified above
    signal: ctx.signal,
  })

  // ctx.llm already metered the tokens.
  return { output: result, tokensUsed: 0 }
}
