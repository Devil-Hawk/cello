// The two things the new system is compared against, on the same data.
//
//   1. The scorer that shipped in Release 1: one model call per job, a 0-100
//      score, ranked by it. The prompt and parser below are a frozen copy of
//      lib/harness/agents/matcher.ts as of release/1 (MATCHER_SYSTEM_HEAD and
//      scoreJobWithLlm), so it can be measured after the live code is gone.
//   2. A naive points formula, the kind of "+2 for this, +1 for that" rule the
//      new system deliberately does not use. It exists only as a yardstick.

import type { LlmRunner } from '@/lib/harness/types'
import { parseJsonLoose } from '@/lib/harness/llm'
import { frameJobText } from '@/lib/security/job-text'
import { parseTitle, scoreTitleAgainstTargets } from '@/lib/matching/title-rank'
import type { Chance } from '@/lib/scoring/types'

export const OLD_SCORER_SYSTEM_HEAD =
  'You are an expert technical recruiter producing an honest, evidence-based fit assessment ' +
  'between a candidate resume and a job. Be specific and concrete. Never invent candidate ' +
  'experience. Respond with a single JSON object and nothing else.\n\n' +
  `CANDIDATE RESUME (the only source of truth about the candidate — never credit ` +
  `experience that is not here):\n`

const DESC_LIMIT = 4000
const RESUME_LIMIT = 8000

export interface OldScorable {
  id: string
  title: string
  company: string
  location: string | null
  description: string | null
}

function clampPct(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n)
  return Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : 0
}

/** The Release 1 matcher call for one job. Returns its 0-100 score, or null when the model gave nothing usable. */
export async function oldScore(llm: LlmRunner, resume: string, job: OldScorable): Promise<number | null> {
  const system = `${OLD_SCORER_SYSTEM_HEAD}${resume.slice(0, RESUME_LIMIT)}`
  const prompt =
    `JOB:\nTitle: ${job.title}\nCompany: ${job.company || 'Unknown'}\n` +
    `Location: ${job.location ?? 'Unspecified'}\n` +
    `Description:\n${frameJobText(job.description, { maxChars: DESC_LIMIT, emptyPlaceholder: '(no description provided)' })}\n\n` +
    `Return JSON with EXACTLY these keys:\n` +
    `{\n` +
    `  "score": <overall fit 0-100>,\n` +
    `  "skillsMatch": <0-100>,\n` +
    `  "experienceMatch": <0-100>,\n` +
    `  "locationMatch": <0-100>,\n` +
    `  "strengths": [<3-5 concrete reasons the candidate fits, each grounded in the resume>],\n` +
    `  "gaps": [<0-5 concrete missing/weak requirements>],\n` +
    `  "seniorityFit": "<one short phrase, e.g. 'Strong fit for senior IC' or 'Slightly junior'>",\n` +
    `  "summary": "<2-3 sentence plain-language explanation of the match>",\n` +
    `  "matchedSkills": [<skills present in BOTH resume and job>],\n` +
    `  "missingSkills": [<skills the job wants that the resume lacks>]\n` +
    `}`
  try {
    const res = await llm({ system, prompt, json: true, maxTokens: 1800, temperature: 0.2, cachePrefix: true, name: 'old-scorer' })
    const raw = parseJsonLoose<{ score?: unknown }>(res.content)
    return raw.score == null ? null : clampPct(raw.score)
  } catch {
    return null
  }
}

/** The old score mapped to bands the way _shared.md described them: 70 and up strong, 50 to 69 possible, below 50 a stretch. */
export function oldBand(score: number): Chance {
  return score >= 70 ? 'strong' : score >= 50 ? 'possible' : 'stretch'
}

// ---------------------------------------------------------------------------
// Naive points
// ---------------------------------------------------------------------------

export interface NaivePerson {
  titles: string[]
  resume: string
  /** Words that rule a title out, lowercased. */
  excludedWords: string[]
  countries: string[]
}

const STOP = new Set(['and', 'the', 'for', 'with', 'using', 'experience', 'skills', 'tools', 'other', 'basic', 'knowledge', 'various'])

/** Skill tokens from a resume's SKILLS block: the comma separated words, lowercased. */
export function resumeSkillTokens(resume: string): string[] {
  const m = /SKILLS\s*\n([\s\S]*?)(\n\n|\nEDUCATION|$)/i.exec(resume)
  const block = m ? m[1] : ''
  const out = new Set<string>()
  for (const part of block.split(/[,\n;|]/)) {
    const t = part.replace(/\(.*?\)/g, '').trim().toLowerCase()
    if (t.length >= 2 && !STOP.has(t)) out.add(t)
  }
  return [...out]
}

function hasWord(hay: string, needle: string): boolean {
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(hay)
}

/**
 * +2 when the title matches a title the person stated, +1 for each resume skill
 * the posting mentions, +1 when the location is workable, -3 for an excluded
 * word in the title. The weights are the kind a person would guess.
 */
export function naivePoints(person: NaivePerson, job: OldScorable): number {
  let pts = 0
  const targets = person.titles.map((t) => parseTitle(t))
  if (targets.length > 0 && scoreTitleAgainstTargets(job.title, targets).score > 0) pts += 2
  const text = `${job.title}\n${job.description ?? ''}`
  for (const skill of resumeSkillTokens(person.resume)) if (hasWord(text, skill)) pts += 1
  const loc = (job.location ?? '').toLowerCase()
  const countryOk = person.countries.length === 0 || /remote|united states|\bus\b|usa|, wa|, ca|, ny|, ma|, tx/.test(loc) || loc === ''
  if (countryOk) pts += 1
  if (person.excludedWords.some((w) => hasWord(job.title, w))) pts -= 3
  return pts
}
