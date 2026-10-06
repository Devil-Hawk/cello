// The holistic read of the taste model: a model plays a recruiter who knows this
// one person. It is given what they stated, a balanced sample of their own recent
// decisions with the reasons they tapped, and the roles to judge. It returns, per
// role, the probability they would be interested, the same probability from the
// stated preferences alone (the cold-start prior), and one sentence in their terms.

import type { LlmRunner } from '@/lib/harness/types'
import { MissingKeyError, parseJsonLoose } from '@/lib/harness/llm'
import { BudgetCapError } from '@/lib/harness/spend'
import { frameJobTextList } from '@/lib/security/job-text'
import { scoringPromptRef, scoringSystem } from './prompts'
import type { ReactionRecord, RoleFacts } from './types'

export interface StatedPreferences {
  titles: string[]
  functions: string[]
  seniority: string[]
  countries: string[]
  remoteOnly: boolean
  likedCompanies: string[]
  dislikedCompanies: string[]
  /** Free-text preferences Cello remembers about the person, in their words. */
  notes: string[]
  /** One or two lines of resume background. */
  background: string
}

export const NO_STATED: StatedPreferences = {
  titles: [],
  functions: [],
  seniority: [],
  countries: [],
  remoteOnly: false,
  likedCompanies: [],
  dislikedCompanies: [],
  notes: [],
  background: '',
}

export interface WantJudgement {
  p: number
  reason: string
}

const REASON_WORDS: Record<string, string> = {
  too_junior: 'too junior',
  too_senior: 'too senior',
  company: 'company',
  domain: 'domain',
  location: 'location',
  pay: 'pay',
  other: 'other',
  level: 'level',
  role_type: 'role type',
}

const BATCH_SIZE = 10
const EXAMPLES_PER_SIDE = 8
const EXCERPT_CHARS = 700
const EXAMPLE_CHARS = 160

export function renderStated(s: StatedPreferences): string {
  const lines: string[] = []
  const list = (label: string, v: string[]) => v.length > 0 && lines.push(`${label}: ${v.join(', ')}`)
  list('Wants roles titled', s.titles)
  list('Wants work in', s.functions)
  list('Wants level', s.seniority)
  list('Works in countries', s.countries)
  if (s.remoteOnly) lines.push('Remote roles only')
  list('Likes companies', s.likedCompanies)
  list('Rules out companies', s.dislikedCompanies)
  list('Told Cello', s.notes)
  if (s.background.trim()) lines.push(`Background: ${s.background.trim().slice(0, 600)}`)
  return lines.length > 0 ? lines.join('\n') : '(they have stated nothing yet)'
}

function oneLine(s: string, n: number): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, n)
}

/** A balanced, time-ordered sample: the latest interested and applied roles and the latest passes. */
export function sampleDecisions(reactions: readonly ReactionRecord[], perSide = EXAMPLES_PER_SIDE): ReactionRecord[] {
  const byTime = [...reactions].sort((a, b) => b.at.localeCompare(a.at))
  const yes = byTime.filter((r) => r.reaction !== 'not_for_me').slice(0, perSide)
  const no = byTime.filter((r) => r.reaction === 'not_for_me').slice(0, perSide)
  return [...yes, ...no].sort((a, b) => a.at.localeCompare(b.at))
}

export function renderDecisions(reactions: readonly ReactionRecord[]): string {
  const sample = sampleDecisions(reactions)
  if (sample.length === 0) return '(no decisions yet)'
  const lines = sample.map((r) => {
    const tag = r.reaction === 'not_for_me' ? `not for me${r.reason ? `, ${REASON_WORDS[r.reason]}` : ''}` : r.reaction
    const where = r.location ? ` (${oneLine(r.location, 40)})` : ''
    const excerpt = oneLine(r.text.split('\n').slice(3).join(' '), EXAMPLE_CHARS)
    return `[${tag}] ${oneLine(r.title, 80)}, ${oneLine(r.company, 50)}${where}${excerpt ? `. ${excerpt}` : ''}`
  })
  const yes = reactions.filter((r) => r.reaction !== 'not_for_me').length
  return `${lines.join('\n')}\nInterested in ${yes} of ${reactions.length} roles shown so far.`
}

function clampProb(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n)) return null
  return Math.min(0.98, Math.max(0.02, n))
}

function firstSentence(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''
  if (!s) return ''
  const m = /^(.+?[.!?])(\s|$)/.exec(s)
  return (m ? m[1] : s).slice(0, 220)
}

/** Parses one judge answer; rows with no usable probability are dropped. */
export function parseJudgements(raw: unknown, idMap: ReadonlyMap<string, string>): Map<string, WantJudgement> {
  const out = new Map<string, WantJudgement>()
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { roles?: unknown }).roles) ? ((raw as { roles: unknown[] }).roles) : []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const jobId = idMap.get(String(r.id))
    const p = clampProb(r.p)
    if (!jobId || p == null) continue
    out.set(jobId, { p, reason: firstSentence(r.reason) })
  }
  return out
}

export interface JudgeWantInput {
  stated: StatedPreferences
  reactions: readonly ReactionRecord[]
  roles: readonly RoleFacts[]
}

async function judgeBatches(llm: LlmRunner, context: string, roles: readonly RoleFacts[]): Promise<Map<string, WantJudgement>> {
  const out = new Map<string, WantJudgement>()
  for (let i = 0; i < roles.length; i += BATCH_SIZE) {
    const batch = roles.slice(i, i + BATCH_SIZE)
    const idMap = new Map(batch.map((r, k) => [`a${k + 1}`, r.id]))
    const prompt =
      frameJobTextList(
        batch.map((r, k) => ({
          id: `a${k + 1}`,
          text: `${r.title}, ${r.company}${r.location ? ` (${r.location})` : ''}\n${oneLine(r.description ?? '', EXCERPT_CHARS) || '(no description yet)'}`,
        })),
        { label: 'ROLE', maxChars: EXCERPT_CHARS + 200 }
      ) + '\n\nJudge every role.'
    try {
      const res = await llm({
        name: 'judge-role-want',
        system: scoringSystem('role_want', context),
        prompt,
        json: true,
        temperature: 0.2,
        maxTokens: 350 * batch.length + 1500,
        cachePrefix: true,
        promptRef: scoringPromptRef('role_want'),
      })
      for (const [id, j] of parseJudgements(parseJsonLoose(res.content), idMap)) out.set(id, j)
    } catch (err) {
      if (err instanceof MissingKeyError || err instanceof BudgetCapError) throw err
      // This batch is left unjudged; the caller falls back to the other signals.
    }
  }
  return out
}

/** Judges roles ten to a call from the stated preferences and the person's own decisions. A batch the model fails on is simply absent. */
export async function judgeWant(llm: LlmRunner, input: JudgeWantInput): Promise<Map<string, WantJudgement>> {
  const context = `What they told us:\n${renderStated(input.stated)}\n\nWhat they did:\n${renderDecisions(input.reactions)}`
  return judgeBatches(llm, context, input.roles)
}

/**
 * The same judgement from the stated preferences alone: the cold-start prior.
 * It is a separate call so what the decisions showed cannot leak into it, and it
 * does not change as reactions accumulate, so callers keep it per role.
 */
export async function judgeStated(llm: LlmRunner, stated: StatedPreferences, roles: readonly RoleFacts[]): Promise<Map<string, WantJudgement>> {
  const context = `What they told us:\n${renderStated(stated)}\n\nWhat they did:\n${renderDecisions([])}`
  return judgeBatches(llm, context, roles)
}
