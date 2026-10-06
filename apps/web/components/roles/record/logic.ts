// The words of the record that code can write from stored facts. No model: every
// line here is a fact about where a posting came from, what it states, or what
// the person's own search says about it.

import type { EvidenceSource, FitItem, FitStrip } from '@/lib/fit/types'
import type { TypeProv } from '@/lib/jobs/relevance-types'
import type { RoleTypeView } from '../types'

export const FOLD_LINES = 12

/** A posting longer than the fold gets the fade and "Read the whole posting"; a short one is shown whole. */
export function needsFold(text: string): boolean {
  return text.length > 900 || text.split('\n').length > FOLD_LINES
}

const LEVEL: Record<string, string> = { intern: 'Intern', junior: 'Junior', mid: 'Mid', senior: 'Senior', staff: 'Staff', principal: 'Principal', manager: 'Manager', director: 'Director', exec: 'Executive' }
const FUNCTION: Record<string, string> = { engineering: 'Engineering', data: 'Data', product: 'Product', design: 'Design', sales: 'Sales', marketing: 'Marketing', operations: 'Operations', other: 'Other' }

export interface WhyFacts {
  /** The role type the person sees. */
  roleType?: RoleTypeView | null
  jobFunction: string | null
  seniority: string | null
  isRemote: boolean | null
  country: string | null
}

export interface WhyTargets {
  /** The role type ids the person chose. */
  roleTypes?: string[]
  functions: string[]
  seniority: string[]
  countries: string[]
  remoteOnly: boolean
}

/**
 * Why the role was kept, from the person's own search and the role's stored
 * facts: "Kept: Engineering is one of your role types, Senior is your level, and
 * remote is how you want to work." Null when the search names nothing this role
 * matches, so the group stays hidden rather than saying something empty.
 */
export function whyKept(job: WhyFacts, t: WhyTargets): string | null {
  const parts: string[] = []
  if (job.roleType && t.roleTypes?.includes(job.roleType.id)) parts.push(`${job.roleType.label} is one of your role types`)
  else if (job.jobFunction && t.functions.includes(job.jobFunction)) parts.push(`${FUNCTION[job.jobFunction] ?? job.jobFunction} is one of your role types`)
  if (job.seniority && t.seniority.includes(job.seniority)) parts.push(`${LEVEL[job.seniority] ?? job.seniority} is your level`)
  if (job.country && t.countries.includes(job.country)) parts.push(`${job.country} is where you work`)
  if (job.isRemote && t.remoteOnly) parts.push('remote is how you want to work')
  if (parts.length === 0) return null
  const last = parts.pop()!
  return `Kept: ${parts.length ? `${parts.join(', ')}, and ${last}` : last}.`
}

/**
 * What the posting says about sponsorship, for a person who needs it. Past H-1B
 * filings come from the public list and are only ever a track record; nothing
 * here says an employer does not sponsor.
 */
export function sponsorshipLines(needsSponsorship: boolean, pastH1B: boolean, description: string): string[] {
  if (!needsSponsorship) return []
  const lines = [/sponsor/i.test(description) ? 'The posting mentions sponsorship.' : 'The posting does not mention sponsorship.']
  if (pastH1B) lines.push('Past H-1B filings.')
  return lines
}

export interface ApplicationFacts {
  stage: string
  appliedAt: string | null
}

const month = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

/** "You applied on Sep 12." once applied; nothing for a role that is only saved. */
export function statusSentence(a: ApplicationFacts | null): string | null {
  if (!a || a.stage === 'discovered') return null
  return a.appliedAt ? `You applied on ${month(a.appliedAt)}.` : 'You applied.'
}

/** Where the posting was read, as a fact about the read: "From Stripe's job board. Still listed as of 3 hours ago." */
export function sourceLine(company: string, tier: string | null, closed: boolean, checkedAt: string | null, now = Date.now()): string | null {
  const from = tier === 'board' ? `From ${company}'s job board.` : tier ? `From ${company}'s careers site.` : null
  let listed: string | null = null
  if (closed) listed = 'The posting is closed.'
  else if (checkedAt) {
    const hours = Math.max(0, Math.floor((now - Date.parse(checkedAt)) / 3_600_000))
    listed = `Still listed as of ${hours < 1 ? 'just now' : hours < 24 ? `${hours} ${hours === 1 ? 'hour' : 'hours'} ago` : `${Math.floor(hours / 24)} ${Math.floor(hours / 24) === 1 ? 'day' : 'days'} ago`}.`
  }
  return [from, listed].filter(Boolean).join(' ') || null
}

/** A posting that is only a link or a stub: the page says so and sends the person to the employer. */
export function isPartial(description: string): boolean {
  return description.trim().length < 200
}

/**
 * Why the role has its type, from how it was set: the person's own word, the title words a rule matched,
 * or a model's read with its quote. `model` says the sentence is Cello's read and carries the mark.
 * Null when nothing says how (no sentence is made up).
 */
export function whyType(type: RoleTypeView | null, prov: TypeProv | null): { text: string; model: boolean } | null {
  if (!type) return null
  if (type.own) return { text: `You chose ${type.label} for titles like this one.`, model: false }
  if (type.origin === 'model') {
    const quote = prov?.evidence?.[0]?.quote
    return { text: quote ? `${type.label}, read from "${quote}".` : `${type.label}, read from the title and the posting.`, model: true }
  }
  if (prov?.rule === 'department') return { text: `${type.label}, from the team name "${prov.pattern}".`, model: false }
  if (prov?.rule && prov.pattern) return { text: `${type.label}, from the title words "${prov.pattern}".`, model: false }
  return null
}

/** A pasted role is here even when it is not of a type the person chose; the record says so. */
export function pastedLine(pasted: boolean, type: RoleTypeView | null, chosen: readonly string[]): string | null {
  if (!pasted) return null
  return chosen.length > 0 && !(type && chosen.includes(type.id)) ? 'You pasted this. It is outside your role types.' : 'You pasted this.'
}

/** Strengths, gaps and unknowns of the items as they stand (a correction changes one). */
export function stripOf(items: readonly Pick<FitItem, 'verdict'>[]): FitStrip {
  return { strengths: items.filter((i) => i.verdict === 'strength').length, gaps: items.filter((i) => i.verdict === 'gap').length, unknown: items.filter((i) => i.verdict === 'unknown').length }
}

/** "5 pluses, 1 minus, 3 not sure". */
export function stripSentence(s: FitStrip): string {
  return `${s.strengths} ${s.strengths === 1 ? 'plus' : 'pluses'}, ${s.gaps} ${s.gaps === 1 ? 'minus' : 'minuses'}, ${s.unknown} not sure`
}

export const SOURCE_LABEL: Record<EvidenceSource, string> = { resume: 'Your resume', answer: 'Your saved answer', profile: 'Your profile', material: 'From a page you saved' }

/** Not found is a fact about where code looked, never a judgement that the person lacks the thing. */
export const UNREAD = 'Cello has not read this against your resume yet.'
