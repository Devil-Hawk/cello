// release/1 writers frozen for the "before" measurement: the cover letter, the
// company research synthesis, the visa parse and the
// follow-up status line, each as it built its prompt and read the model's answer
// before the output work. Not used by the app.

import type { LlmRunner } from '@/lib/harness/types'
import { frameJobText } from '@/lib/security/job-text'
import { legacySystem } from './prompts'

function parseLoose(raw: string): Record<string, unknown> {
  const t = raw.trim()
  try {
    return JSON.parse(t)
  } catch {
    const m = t.match(/[[{][\s\S]*[\]}]/)
    if (m) return JSON.parse(m[0])
    throw new Error('not valid JSON')
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

// --- cover letter -------------------------------------------------------------

export async function legacyTailor(
  run: LlmRunner,
  a: { title: string; company: string; location?: string | null; description: string; resumeText: string }
): Promise<{ resumeSummary: string; coverLetter: string; keywords: string[] }> {
  const rawDescription = a.description.trim()
  const description = frameJobText(a.description, { maxChars: 8_000, emptyPlaceholder: '(no description provided)' })
  const prompt = [
    `JOB TITLE: ${a.title}`,
    `COMPANY: ${a.company}`,
    a.location ? `LOCATION: ${a.location}` : '',
    '',
    'JOB DESCRIPTION:',
    description,
    !rawDescription ? 'The job has no description — mirror only the title/company; do not guess at requirements the description never stated.' : '',
    '',
    'Using the resume given in the system prompt as your only source of truth, produce the tailored',
    'resume summary + cover letter as JSON per the system rules.',
  ]
    .filter(Boolean)
    .join('\n')
  const res = await run({
    system: legacySystem({
      mode: 'cv_tailor',
      stableContext: `CANDIDATE RESUME (the ONLY source of truth for claims):\n${a.resumeText.slice(0, 12_000)}`,
    }),
    prompt,
    json: true,
    maxTokens: 2048,
    temperature: 0.4,
    reasoning: { effort: 'medium' },
    cachePrefix: true,
  })
  const p = parseLoose(res.content)
  return {
    resumeSummary: str(p.resumeSummary),
    coverLetter: str(p.coverLetter),
    keywords: Array.isArray(p.keywords) ? p.keywords.filter((k): k is string => typeof k === 'string') : [],
  }
}

// --- company research --------------------------------------------------------------

export interface LegacyBundle {
  wikipediaSummary?: string
  github?: { description?: string | null; publicRepos?: number }
  homeText?: string
  aboutText?: string
  careersText?: string
  news: { title: string }[]
}

function legacySynthPrompt(company: { name: string; domain: string | null }, pub: LegacyBundle): string {
  const verified: string[] = []
  if (pub.wikipediaSummary) verified.push('Wikipedia summary')
  if (pub.github?.description) verified.push('GitHub org description')
  if (pub.homeText) verified.push('official site (home)')
  if (pub.aboutText) verified.push('official site (about)')
  if (pub.careersText) verified.push('official site (careers)')
  if (pub.news.length > 0) verified.push(`${pub.news.length} verified news mention(s)`)
  const parts: string[] = [
    `COMPANY: ${company.name}${company.domain ? ` (${company.domain})` : ''}`,
    `VERIFIED EVIDENCE AVAILABLE: ${verified.join(', ') || 'none'}. Nothing else was corroborated as ` +
      'being about this specific company — do not treat its absence as evidence of anything.',
  ]
  if (pub.wikipediaSummary) parts.push(`WIKIPEDIA:\n${pub.wikipediaSummary}`)
  if (pub.github?.description) {
    const g = pub.github
    const repoNote = g.publicRepos != null ? ` (public repos: ${g.publicRepos})` : ''
    parts.push(`GITHUB ORG:\n${frameJobText(g.description, { label: 'GITHUB ORG DESCRIPTION' })}${repoNote}`)
  }
  if (pub.homeText) parts.push(`OFFICIAL SITE (home):\n${pub.homeText}`)
  if (pub.aboutText) parts.push(`OFFICIAL SITE (about):\n${pub.aboutText}`)
  if (pub.careersText) parts.push(`OFFICIAL SITE (careers):\n${pub.careersText}`)
  if (pub.news.length > 0) parts.push(`VERIFIED RECENT NEWS HEADLINES:\n${pub.news.map((n) => `- ${n.title}`).join('\n')}`)
  return parts.join('\n\n').slice(0, 12_000)
}

export interface LegacyResearch {
  /** What the panel showed as the summary: the model's, else the Wikipedia extract. */
  shownSummary: string | null
  modelSummary: string | null
  funding: string | null
  techStack: string[]
  failed: boolean
  cutOff: boolean
}

export async function legacyResearch(run: LlmRunner, company: { name: string; domain: string | null }, pub: LegacyBundle): Promise<LegacyResearch> {
  try {
    const res = await run({
      system: legacySystem({ mode: 'company_researcher' }),
      prompt: legacySynthPrompt(company, pub),
      json: true,
      maxTokens: 700,
      temperature: 0.2,
      cachePrefix: true,
    })
    const p = parseLoose(res.content)
    const modelSummary = str(p.summary) || null
    return {
      modelSummary,
      shownSummary: modelSummary ?? pub.wikipediaSummary ?? null,
      funding: str(p.funding) || null,
      techStack: Array.isArray(p.techStack) ? p.techStack.filter((t): t is string => typeof t === 'string') : [],
      failed: false,
      cutOff: false,
    }
  } catch (e) {
    return {
      modelSummary: null,
      shownSummary: pub.wikipediaSummary ?? null,
      funding: null,
      techStack: [],
      failed: true,
      cutOff: e instanceof Error && e.name === 'TruncatedResponseError',
    }
  }
}

export async function legacyVisa(run: LlmRunner, careersText: string): Promise<{ signal: string; evidence?: string }> {
  const res = await run({
    system: legacySystem({ mode: 'visa', includeVoice: false }),
    prompt: `CAREERS PAGE TEXT:\n${careersText.slice(0, 6000)}`,
    json: true,
    maxTokens: 300,
    temperature: 0,
    cachePrefix: true,
  })
  const raw = parseLoose(res.content) as { signal?: string; evidence?: string }
  const s = raw?.signal
  if (s === 'likely' || s === 'unlikely' || s === 'unknown') return { signal: s, evidence: (raw.evidence || '').trim() || undefined }
  return { signal: 'unknown' }
}

// --- follow-up status line ----------------------------------------------------------

export async function legacyStatusLine(run: LlmRunner, created: { company: string; days: number }[]): Promise<string> {
  const res = await run({
    system: legacySystem({ mode: 'follow_upper' }),
    prompt: `Follow-ups queued (all due tomorrow):\n${created.map((c) => `- ${c.company}: silent for ${c.days} days`).join('\n')}`,
    maxTokens: 220,
    temperature: 0.5,
    cachePrefix: true,
  })
  return res.content.trim()
}
