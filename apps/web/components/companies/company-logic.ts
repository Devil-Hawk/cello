// The Company page as pure functions: what its address asks for, the counted line over a live read, and every
// sentence for the states of 4.7. No I/O and no model. Each number is passed in from the read it belongs to; nothing
// here counts the rows it was given and calls that a total, and no failure code reaches a person.

import { ago } from '@/components/today/logic'
import type { OutsideReason } from '@/lib/jobs/target-relevance'
import { companyHref } from '@/lib/routes/companies'

export const LIVE_PAGE = 25

export interface CompanyQuery {
  /** Words searched in the employer's whole live list and the roles kept before. */
  q: string | null
  /** The whole list is open. */
  all: boolean
  type: string | null
  place: string | null
  /** 0-based page of the list. */
  page: number
}

export const DEFAULT_COMPANY_QUERY: CompanyQuery = { q: null, all: false, type: null, place: null, page: 0 }

const TYPE_ID = /^[a-z][a-z0-9-]{0,60}$/
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

/** Typed text as one plain line: control characters become spaces, runs of spaces one, cut to `max`. */
const clean = (v: string | undefined, max: number) => {
  const t = Array.from(v ?? '', (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c)).join('').replace(/\s+/g, ' ').trim().slice(0, max)
  return t === '' ? null : t
}

export function parseCompanyQuery(sp: Record<string, string | string[] | undefined>): CompanyQuery {
  const type = first(sp.type)
  const page = Number(first(sp.p))
  return {
    q: clean(first(sp.q), 80),
    all: first(sp.all) === '1',
    type: type && TYPE_ID.test(type) ? type : null,
    place: clean(first(sp.place), 60),
    page: Number.isInteger(page) && page > 0 ? Math.min(page, 1000) : 0,
  }
}

/** The query as an address's parameters; defaults are left out. */
export function companyQueryString(q: CompanyQuery, patch: Partial<CompanyQuery> = {}): string {
  const n = { ...q, ...patch }
  const p = new URLSearchParams()
  if (n.q) p.set('q', n.q)
  if (n.all) p.set('all', '1')
  if (n.type) p.set('type', n.type)
  if (n.place) p.set('place', n.place)
  if (n.page > 0) p.set('p', String(n.page))
  return p.toString()
}

/** This company's page with a change laid over the query. */
export function companyPageHref(id: string, q: CompanyQuery, patch: Partial<CompanyQuery> = {}): string {
  const s = companyQueryString(q, patch)
  return s ? `${companyHref(id)}?${s}` : companyHref(id)
}

/** The employer's own key for a posting in an address: letters, digits, - and _ only, so no router ever decodes it twice. A key is often a URL. */
export function encodeKey(key: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(key))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The key back from an address; null for anything encodeKey could not have made. */
export function decodeKey(s: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,700}$/.test(s)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))
  } catch {
    return null
  }
}

/** A not-kept title opens its preview. The address carries the employer's own key for the posting, never a link, and the list's query so Back returns to the same page. */
export function previewHref(id: string, key: string, q: CompanyQuery): string {
  const s = companyQueryString(q)
  return `${companyHref(id)}/roles/${encodeKey(key)}${s ? `?${s}` : ''}`
}

// ---------------------------------------------------------------------------
// The live list
// ---------------------------------------------------------------------------

const OTHER_LABEL: Record<OutsideReason, string> = {
  type: 'other role types',
  untyped: 'type unknown',
  title: 'other titles',
  place: 'place',
  level: 'level',
  age: 'too old',
  excluded: 'excluded',
}
const OTHER_ORDER: OutsideReason[] = ['type', 'untyped', 'title', 'place', 'level', 'age', 'excluded']

/** "624 others: 380 other role types, 20 type unknown, 150 place, 74 level": the parts add up to the others, which with the kept add up to what the employer listed. */
export function countedLine(r: { kept: number; total: number; counts: Record<string, number> }): string | null {
  const others = r.total - r.kept
  if (others <= 0) return null
  const parts = OTHER_ORDER.filter((k) => (r.counts[k] ?? 0) > 0).map((k) => `${r.counts[k]} ${OTHER_LABEL[k]}`)
  return parts.length > 0 ? `${others.toLocaleString('en-US')} others: ${parts.join(', ')}` : `${others.toLocaleString('en-US')} others`
}

/** "12 kept of 636 open." */
export const headlineLine = (total: number, kept: number) => `${kept.toLocaleString('en-US')} kept of ${total.toLocaleString('en-US')} open.`

export const windowLine = (total: number) => `Cello read ${total.toLocaleString('en-US')} roles. This employer lists more than it shows at once.`

export const noMatchLine = (company: string, q: string) => `No open role at ${company} matches '${q}'.`

export const RENDERED_LINE = 'Cello reads this site in the background, so its roles cannot be listed here.'

export const RATE_LINE = 'You opened many pages just now. Try again in a few minutes.'

const CLAUSE: Record<string, string> = {
  cannot_read: 'it did not answer three reads',
  no_board: 'its job board is gone',
  stale: 'no new role on its board in 120 days',
  other_owner: 'its board now belongs to another employer',
  not_linked: 'its board no longer links to it',
  human_check: 'it asks for a human check',
}

/** "Cello cannot read Apple's site: its job board is gone." */
export function cannotReadSite(company: string, reason: string): string {
  return `Cello cannot read ${company}'s site: ${CLAUSE[reason] ?? 'Cello could not read it'}.`
}

/** What a live read that listed nothing says, from the reader's own reason. */
export function failureLine(company: string, failure: string | null): string {
  if (failure === 'no_careers_url') return `Cello has no careers page for ${company} yet.`
  if (failure === 'unreachable') return `Cello could not reach ${company}'s site just now.`
  return `Cello found no open roles on ${company}'s site just now.`
}

export const keptOnlyLine = (company: string) => `Cello cannot read ${company}'s site, so this searches the roles it kept before.`

export const closedLine = 'This role is no longer listed.'

// ---------------------------------------------------------------------------
// The first screen and the groups
// ---------------------------------------------------------------------------

export interface FieldFacts {
  /** Postings in the person's role types, opened in 90 and 30 days. */
  n90: number
  n30: number
  /** The split by the person's own types, most first. */
  byType: { id: string; label: string; n: number }[]
  /** Median posting life per type, only from at least five closed. */
  medians: { label: string; days: number }[]
  /** Postings that state pay. */
  pay: number
  fill: string | null
}

export function fieldLines(f: FieldFacts, company: string): string[] {
  const out: string[] = []
  if (f.n90 > 0) out.push(`${f.n90} postings in your role types in 90 days, ${f.n30} in 30.`)
  if (f.byType.length > 0) out.push(f.byType.map((t) => `${t.label} ${t.n}`).join(', '))
  for (const m of f.medians) out.push(`A ${m.label} posting stays open a median of ${m.days} days.`)
  if (f.pay > 0) out.push(`${f.pay} of ${company}'s postings state pay.`)
  if (f.fill) out.push(f.fill)
  return out
}

export interface Fact {
  text: string
  /** Where it comes from and when. */
  source: string
}

export interface HistoryItem {
  at: string
  text: string
}

export const FOLLOW_LEARN = "Following reads this employer's site every 6 hours, and Send for me may apply here if you turn it on."

export const followLine = (name: string) => `Following ${name}. Cello is reading its site now.`

export function emailLine(appliedAt: string | null): string {
  if (!appliedAt) return "Cello has not found this employer's job site yet."
  const month = new Date(appliedAt).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })
  return `You applied here in ${month}. Cello has not found this employer's job site yet.`
}

/** The reading line of the Checks group: the clock's record for a followed employer, the rotation for the rest. */
export function checksLine(c: { following: boolean; lastReadAt: string | null; check: { lastAt: string | null; nextAt: string | null; missed: string | null } | null }, now: number): string | null {
  if (c.following) {
    if (!c.check) return null
    if (c.check.missed) return c.check.missed
    const next = c.check.nextAt ? `Next at ${new Date(c.check.nextAt).toISOString().slice(11, 16)} UTC.` : null
    return [c.check.lastAt ? `Checked ${ago(c.check.lastAt, now)}.` : null, next].filter(Boolean).join(' ') || null
  }
  return c.lastReadAt ? `Read in rotation. Last read ${ago(c.lastReadAt, now)}.` : 'Read in rotation.'
}

/** What Remove company will do, from the counts read first: what stays and what goes. */
export function removeLines(name: string, n: { applications: number; conversations: number; people: number; notes: boolean }): { stays: string[]; goes: string[] } {
  const plural = (c: number, one: string, many: string) => `${c} ${c === 1 ? one : many}`
  const stay = (c: number) => (c === 1 ? 'stays' : 'stay')
  const stays = [
    n.applications > 0 ? `Your ${plural(n.applications, 'application', 'applications')} with ${name} ${stay(n.applications)}.` : null,
    n.conversations > 0 ? `Your ${plural(n.conversations, 'conversation', 'conversations')} ${stay(n.conversations)}.` : null,
    n.people > 0 ? `The ${plural(n.people, 'person', 'people')} you know there ${stay(n.people)}.` : null,
  ].filter((x): x is string => x !== null)
  return { stays, goes: [`You stop following ${name}.`, ...(n.notes ? ['Your notes on it are deleted.'] : [])] }
}

export const REMOVE_REFUSED = (name: string) => `Cello cannot remove ${name} while an application there is open.`
