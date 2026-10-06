// The Reviewer: every draft the Writer makes is checked here before the person sees it.
//
// Code checks come first because they are exact and free:
//   - nothing in the draft claims what the resume does not support (the existing
//     tailoring containment check: employers, titles, dates, numbers)
//   - length fits the kind of document
//   - an outreach email has exactly one ask
//   - no banned phrase from the voice guide, and no em dash
// Then the claims judge reads every statement against the numbered resume and role
// lines. The judge is a different model family from the one that wrote the draft, so
// a model is never grading its own work. A judge that cannot run (no key, over
// budget, an answer it could not read) is reported as skipped, never as a pass.

import { checkTailoringContainment } from '@/lib/security/job-text'
import { judgeClaims, judgeModelFor, judgeRunner } from '@/lib/evals/claims-judge'
import { DEFAULT_MODEL } from '@/lib/harness/providers/openrouter'
import { MissingKeyError } from '@/lib/harness/llm'
import { jobLines, resumeLines, type NumberedLine } from '@/lib/resume/lines'
import type { AdminClient, DecryptedApiKeys } from '@/lib/harness/types'
import { isBudgetCapError } from '../spend-port'

export type DraftKind = 'resume' | 'cover_letter' | 'outreach_email' | 'follow_up'

export interface ReviewInput {
  kind: DraftKind
  /** The body being reviewed. */
  text: string
  subject?: string
  resumeText: string
  job?: { title: string | null; company: string | null; description: string | null }
  contactName?: string | null
  userName?: string | null
}

export interface Check {
  name: string
  ok: boolean
  detail?: string
}

export interface ReviewResult {
  passed: boolean
  checks: Check[]
  /** Plain sentences the Writer is told to fix, and the person can read. */
  issues: string[]
  judge: { status: 'passed' | 'failed' | 'skipped'; model?: string; reason?: string }
}

// --- the voice guide, as code -------------------------------------------------------

const BANNED_WORDS = [
  'leverage', 'synergy', 'seamless', 'robust', 'cutting-edge', 'innovative', 'spearheaded', 'passionate',
  'results-oriented', 'proven track record', 'facilitated', 'best practices', 'move the needle',
  'stakeholder alignment', 'actionable insights', 'unlock value', 'world-class', 'game-changing', 'holistic',
  'championed', 'orchestrated',
]
const BANNED_OPENERS = ['i am writing to express', 'i am excited to', 'i hope this finds you well', 'i am reaching out']
const BANNED_STATUS = ['just checking in', 'circling back', 'touching base']

export function bannedPhrases(text: string): string[] {
  const lower = text.toLowerCase()
  const hits: string[] = []
  for (const w of BANNED_WORDS) if (new RegExp(`\\b${w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}`, 'i').test(lower)) hits.push(w)
  for (const p of [...BANNED_OPENERS, ...BANNED_STATUS]) if (lower.includes(p)) hits.push(p)
  if (text.includes('\u2014')) hits.push('an em dash')
  return hits
}

export const wordCount = (text: string): number => (text.trim() ? text.trim().split(/\s+/).length : 0)

/** Length windows from the voice guide. Outside them the draft goes back once. */
export const LENGTH_LIMITS: Record<DraftKind, { min: number; max: number }> = {
  cover_letter: { min: 200, max: 460 },
  outreach_email: { min: 25, max: 130 },
  follow_up: { min: 15, max: 90 },
  resume: { min: 120, max: 1800 },
}

/** Sentences that end in a question mark, plus plain requests. One is the rule for outreach. */
export function countAsks(text: string): number {
  const questions = (text.match(/\?/g) ?? []).length
  if (questions > 0) return questions
  return /\b(could you|would you|can you|please (?:let|point|share|send)|i(?:'d| would) (?:welcome|appreciate|love) (?:a|the|to))\b/i.test(text) ? 1 : 0
}

/**
 * The length of a call or chat the email asks for is not a claim about the person.
 * Without this the containment check flags "ten minutes" in every outreach email.
 */
const ASK_DURATIONS = ['five minutes', 'ten minutes', 'fifteen minutes', 'twenty minutes', 'thirty minutes', '5 minutes', '10 minutes', '15 minutes', '20 minutes', '30 minutes']

export function codeChecks(input: ReviewInput): Check[] {
  const checks: Check[] = []

  const allow = [input.job?.company, input.job?.title, input.contactName, input.userName, ...(input.kind === 'outreach_email' || input.kind === 'follow_up' ? ASK_DURATIONS : [])].filter(
    (s): s is string => Boolean(s)
  )
  const containment = checkTailoringContainment(input.resumeText, input.text, { allow, jobText: input.job?.description ?? undefined })
  checks.push({
    name: 'Claims match your resume',
    ok: containment.ok,
    ...(containment.ok ? {} : { detail: containment.reason ?? 'The draft says something your resume does not support.' }),
  })

  const words = wordCount(input.text)
  const limits = LENGTH_LIMITS[input.kind]
  checks.push({
    name: 'Length fits',
    ok: words >= limits.min && words <= limits.max,
    ...(words < limits.min
      ? { detail: `It is ${words} words. Aim for ${limits.min} to ${limits.max}.` }
      : words > limits.max
        ? { detail: `It is ${words} words. Cut it to ${limits.max} or fewer.` }
        : {}),
  })

  if (input.kind === 'outreach_email' || input.kind === 'follow_up') {
    const asks = countAsks(input.text)
    checks.push({
      name: 'One clear ask',
      ok: asks === 1,
      ...(asks === 1 ? {} : { detail: asks === 0 ? 'It does not ask for anything. Add one small ask.' : `It asks ${asks} things. Keep one.` }),
    })
  }

  const banned = bannedPhrases(`${input.subject ?? ''}\n${input.text}`)
  checks.push({
    name: 'Plain wording',
    ok: banned.length === 0,
    ...(banned.length ? { detail: `Remove: ${banned.join(', ')}.` } : {}),
  })
  return checks
}

// --- the judge ----------------------------------------------------------------------

export interface JudgeDeps {
  admin: AdminClient
  userId: string
  apiKeys: DecryptedApiKeys
  /** Test seam: the claims judge. */
  judge?: (input: { text: string; sources: NumberedLine[] }) => Promise<{ verdict: 'pass' | 'fail' | 'insufficient-data'; summary?: string; unsupported?: { text: string }[] }>
}

/** The numbered lines the judge reads the draft against: the resume, and the role as the job lines. */
export function sourceLinesFor(input: ReviewInput): NumberedLine[] {
  const role = input.job ? [input.job.title, input.job.company, input.job.description].filter(Boolean).join('\n') : ''
  return [...resumeLines(input.resumeText), ...jobLines(role)]
}

export async function reviewDraft(deps: JudgeDeps, input: ReviewInput): Promise<ReviewResult> {
  const checks = codeChecks(input)
  const model = judgeModelFor(deps.apiKeys.model ?? DEFAULT_MODEL)
  const run = deps.judge ?? ((i) => judgeClaims(judgeRunner(deps.apiKeys, 'judge-writer-draft'), i))
  let judge: ReviewResult['judge']
  let unsupported: { text: string }[] = []
  try {
    const res = await run({ text: input.text, sources: sourceLinesFor(input) })
    unsupported = res.unsupported ?? []
    judge =
      res.verdict === 'insufficient-data'
        ? { status: 'skipped', model, reason: res.summary || 'The second opinion gave no verdict.' }
        : { status: res.verdict === 'pass' ? 'passed' : 'failed', model }
  } catch (e) {
    judge = {
      status: 'skipped',
      model,
      reason:
        e instanceof MissingKeyError ? 'No key for the second opinion.' : isBudgetCapError(e) ? 'Budget reached before the second opinion.' : 'The second opinion was not available.',
    }
  }

  const issues = checks.filter((c) => !c.ok).map((c) => c.detail ?? c.name)
  if (judge.status === 'failed') {
    if (unsupported.length === 0) issues.push('A second reader found statements the resume and the role do not support.')
    for (const c of unsupported.slice(0, 5)) issues.push(`Remove or rewrite "${c.text}". Nothing in your resume or the role says this.`)
  }
  return { passed: issues.length === 0, checks, issues, judge }
}
