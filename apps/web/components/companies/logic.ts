// The Companies page as pure functions: what the address asks for, the lines a row carries, and the answers Add or
// find gives. No I/O and no model. Every number a label or a row shows is passed in (from SQL); nothing here counts
// the rows it was given and calls that a total. Failure codes never reach a person: each has its sentence here.

import { ago } from '@/components/today/logic'
import { companyHref } from '@/lib/routes/companies'
import type { AddFailure } from '@/lib/companies/add-link'

export const PAGE_SIZE = 50

export const TABS = ['hiring', 'following', 'all'] as const
export type Tab = (typeof TABS)[number]
export const TAB_LABEL: Record<Tab, string> = { hiring: 'Hiring for you', following: 'Following', all: 'All' }

/** A page's key: the last row's own `k` from SQL. All is (name, id); the other tabs are (pinned, newest, most roles, name, id). */
export type Cursor = (string | number)[]

export interface CompaniesQuery {
  tab: Tab
  after: Cursor | null
  /** A role type id. */
  type: string | null
  cannot: boolean
  pinned: boolean
  /** Only employers with past H-1B filings, offered to a person who needs sponsorship. */
  h1b: boolean
  /** The row whose details are open. */
  focus: string | null
}

export const DEFAULT_QUERY: CompaniesQuery = { tab: 'hiring', after: null, type: null, cannot: false, pinned: false, h1b: false, focus: null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TYPE_ID = /^[a-z][a-z0-9-]{0,60}$/

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

/** A cursor the address carries, or null for anything that is not one SQL would have made for this tab. */
export function parseCursor(raw: string | undefined, tab: Tab): Cursor | null {
  if (!raw || raw.length > 400) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(v)) return null
  if (tab === 'all') return v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' && UUID.test(v[1]) ? (v as Cursor) : null
  const ok = v.length === 5 && [0, 1, 2].every((i) => Number.isInteger(v[i])) && typeof v[3] === 'string' && typeof v[4] === 'string' && UUID.test(v[4])
  return ok ? (v as Cursor) : null
}

export function parseCompaniesQuery(sp: Record<string, string | string[] | undefined>): CompaniesQuery {
  const tabRaw = first(sp.tab)
  const tab = (TABS as readonly string[]).includes(tabRaw ?? '') ? (tabRaw as Tab) : DEFAULT_QUERY.tab
  const type = first(sp.type)
  const focus = first(sp.focus)
  return {
    tab,
    after: parseCursor(first(sp.after), tab),
    type: type && TYPE_ID.test(type) ? type : null,
    cannot: first(sp.cannot) === '1',
    pinned: first(sp.pinned) === '1',
    h1b: first(sp.h1b) === '1',
    focus: focus && UUID.test(focus) ? focus : null,
  }
}

export const NO_FILTERS: Partial<CompaniesQuery> = { type: null, cannot: false, pinned: false, h1b: false, after: null }

/** The address for a query with a change laid over it; defaults are left out so the plain page has no parameters. */
export function companiesHref(q: CompaniesQuery, patch: Partial<CompaniesQuery> = {}): string {
  const n = { ...q, ...patch }
  const p = new URLSearchParams()
  if (n.tab !== DEFAULT_QUERY.tab) p.set('tab', n.tab)
  if (n.type) p.set('type', n.type)
  if (n.cannot) p.set('cannot', '1')
  if (n.pinned) p.set('pinned', '1')
  if (n.h1b) p.set('h1b', '1')
  if (n.after) p.set('after', JSON.stringify(n.after))
  if (n.focus) p.set('focus', n.focus)
  const s = p.toString()
  return s ? `/companies?${s}` : '/companies'
}

export function filterCount(q: CompaniesQuery): number {
  return [q.type !== null, q.cannot, q.pinned, q.h1b].filter(Boolean).length
}

// ---------------------------------------------------------------------------
// A row
// ---------------------------------------------------------------------------

export interface CompanyItem {
  /** The address of the Company page: the directory id, or the person's own id for an employer Cello has no row for. */
  id: string
  /** The person's own companies row, when they have one. */
  companyId: string | null
  name: string
  domain: string | null
  logoUrl: string | null
  careersUrl: string | null
  /** The last whole read's total, "of 636 open". */
  open: number | null
  lastReadAt: string | null
  /** Why Cello cannot read the site, or null. */
  cannotRead: string | null
  following: boolean
  pinned: boolean
  /** Roles kept for the person; null when the site cannot be read (never 0). */
  forYou: number | null
  by: { label: string; n: number }[]
  /** On the curated list of past H-1B filers, and the person needs sponsorship. */
  filings: boolean
  /** This row's own key, handed back as the next page's cursor. */
  key: Cursor
}

export interface DetailRole {
  id: string
  title: string
  type: string | null
  postedAt: string | null
}

export interface Details {
  roles: DetailRole[]
  /** Roles for the person at this employer, counted in SQL. */
  total: number
}

const CANNOT_READ: Record<string, string> = {
  cannot_read: 'Cannot read: the site did not answer three reads.',
  no_board: 'Cannot read: its job board is gone.',
  stale: 'Cannot read: no new role on its board in 120 days.',
  other_owner: 'Cannot read: its board now belongs to another employer.',
  not_linked: 'Cannot read: its board no longer links to it.',
}

export const cannotReadLine = (reason: string) => CANNOT_READ[reason] ?? 'Cannot read: Cello could not read its site.'

/** "3 for you", the split by type, and "of 636 open". Null when there is nothing to count or the site cannot be read. */
export function forYouLine(item: Pick<CompanyItem, 'forYou' | 'by' | 'open' | 'cannotRead'>): { head: string; split: string | null; open: string | null } | null {
  if (item.cannotRead || item.forYou === null || item.forYou <= 0) return null
  const shown = item.by.slice(0, 4)
  const more = item.by.length - shown.length
  const split = shown.length > 0 ? shown.map((t) => `${t.label} ${t.n}`).join(', ') + (more > 0 ? ` and ${more} more` : '') : null
  return { head: `${item.forYou} for you`, split, open: item.open !== null && item.open > 0 ? `of ${item.open.toLocaleString('en-US')} open` : null }
}

export interface CheckFacts {
  lastAt: string | null
  nextAt: string | null
  /** "Missed at 12:00. Cello is retrying." */
  missed: string | null
}

const hhmm = (iso: string) => new Date(iso).toISOString().slice(11, 16)

/** What the clock says about the person's own check, for a row they follow; for the rest, the rotation and when it was last read. */
export function readingLine(item: Pick<CompanyItem, 'following' | 'lastReadAt' | 'cannotRead'>, check: CheckFacts | null, now: number): string | null {
  if (item.cannotRead) return null
  if (item.following) {
    if (!check) return null
    if (check.missed) return check.missed
    return [check.lastAt ? `Checked ${ago(check.lastAt, now)}.` : null, check.nextAt ? `Next at ${hhmm(check.nextAt)} UTC.` : null].filter(Boolean).join(' ') || null
  }
  return item.lastReadAt ? `Read in rotation. Last read ${ago(item.lastReadAt, now)}.` : 'Read in rotation.'
}

export const FILINGS_LINE = 'Past H-1B filings'

export const followedLine = (name: string) => `Following ${name}. Cello is reading its site now.`

// ---------------------------------------------------------------------------
// The page's own states
// ---------------------------------------------------------------------------

export const NO_TYPES_LINE = 'Choose your role types to see who is hiring for you.'
export const HIRING_EMPTY = 'No employer has a role for you right now.'
export const FAILED_LINE = 'Could not load companies.'
export const NO_MATCH_LINE = 'No company matches these filters.'
export const FOLLOWING_EMPTY = 'You do not follow a company yet. Find one above, or follow one from All.'
export const RATE_LINE = 'You opened many pages just now. Try again in a few minutes.'

/** While the seed is still being checked. Null once nothing is pending. */
export function loadingLine(verified: number | null, pending: number | null): string | null {
  if (!pending || pending <= 0 || verified === null) return null
  return `Cello has checked ${verified.toLocaleString('en-US')} employers so far. The rest arrive as it reads them.`
}

/** The label of a tab: its count comes from SQL; All shows nothing until the sweep has stored one. */
export function tabLabel(tab: Tab, counts: { hiring: number; following: number; all: number | null }): string {
  const n = counts[tab]
  return n === null ? TAB_LABEL[tab] : `${TAB_LABEL[tab]} ${n.toLocaleString('en-US')}`
}

export function checkedAgainLine(next: string | null): string {
  return next ? `Checked within the hour. Try again after ${hhmm(next)} UTC.` : 'Checked within the hour. Try again later.'
}

// ---------------------------------------------------------------------------
// Add or find
// ---------------------------------------------------------------------------

export type Typed = { kind: 'none' } | { kind: 'name'; text: string } | { kind: 'link'; text: string }

/** A link has a scheme, or a dot and a slash; anything else is a name. Two characters before it searches. */
export function classifyInput(raw: string): Typed {
  const text = raw.trim()
  if (text.length < 2) return { kind: 'none' }
  if (/^https?:\/\//i.test(text) || (text.includes('.') && text.includes('/'))) return { kind: 'link', text }
  return { kind: 'name', text }
}

export interface Offer {
  kind: 'employer' | 'posting'
  name: string
  domain?: string | null
  employerId?: string
  url?: string
}

/** What POST /api/companies/add answers (lib/companies/add-link.ts AddResult), as the browser reads it. */
export type AddResponse =
  | { ok: true; companyId: string; already: boolean; employer: { employerId: string | null; name: string; domain: string | null; logoUrl: string | null; openCount: number | null } }
  | { ok: false; reason: AddFailure; offers?: Offer[] }

export type AddAction =
  | { kind: 'follow'; label: string; employerId: string }
  | { kind: 'link'; label: string; link: string }
  | { kind: 'anyway'; label: string; link: string }
  | { kind: 'open'; label: string; href: string; external?: boolean }
  | { kind: 'paste'; label: string }

export type AddState =
  | { kind: 'idle' }
  | { kind: 'verifying'; line: string }
  | { kind: 'added'; line: string; actions: AddAction[] }
  | { kind: 'failed'; line: string; reason: AddFailure | 'network'; actions: AddAction[] }

export interface AddContext {
  /** The address the person pasted, when they pasted one. */
  link?: string
  /** The name of the employer being added, when a candidate or a hit was chosen. */
  name?: string
  /** Its website, when known. */
  domain?: string | null
}

const display = (link: string) => link.replace(/^https?:\/\//i, '').replace(/\/+$/, '')

const hostOf = (link: string): string | null => {
  try {
    return new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

/** "Checking that jobs.ashbyhq.com/retell-ai is Retell AI's job site." with a guess; else "Checking jobs.ashbyhq.com/retell-ai." */
export function verifyingLine(ctx: AddContext): string {
  const where = ctx.link ? display(ctx.link) : (ctx.domain ?? null)
  if (ctx.name && where) return `Checking that ${where} is ${ctx.name}'s job site.`
  if (ctx.name) return `Checking ${ctx.name}'s job site.`
  return where ? `Checking ${where}.` : 'Checking that site.'
}

/** One sentence per reason, with what the result carries. */
export function failLine(reason: AddFailure | 'network', ctx: AddContext): string {
  const host = ctx.link ? hostOf(ctx.link) : (ctx.domain ?? null)
  const who = ctx.name ? `${ctx.name}'s` : 'theirs'
  switch (reason) {
    case 'not_linked':
      return host ? `${host} does not link to this board, so Cello cannot tell it is ${who}.` : `Nothing shows this board is ${who}.`
    case 'other_owner':
      return 'This board belongs to a different employer.'
    case 'stale':
      return 'The newest role on this board is older than 120 days. It looks unused.'
    case 'no_board':
      return 'Cello found no job board on this page.'
    case 'not_employer_site':
      return "This is a job site. Cello reads employers' own sites."
    case 'cannot_read':
      return 'Cello could not read their site.'
    case 'bad_link':
      return 'Cello cannot read that address. Paste their careers page.'
    case 'daily_limit':
      return 'You have added 30 companies today. You can add more tomorrow.'
    case 'demo':
      return 'The demo cannot add companies. Sign in with your own account to add one.'
    case 'not_found':
      return 'Cello does not have that employer.'
    case 'not_saved':
      return 'Could not save that. Try again.'
    default:
      return 'Could not reach Cello. Try again.'
  }
}

/** What a finished add says and offers, from the answer alone. */
export function addOutcome(res: AddResponse, ctx: AddContext = {}): AddState {
  if (res.ok) {
    const name = res.employer.name
    const open = { kind: 'open' as const, label: `Open ${name}`, href: companyHref(res.employer.employerId ?? res.companyId) }
    if (res.already) return { kind: 'added', line: `You already follow ${name}.`, actions: [open] }
    return { kind: 'added', line: followedLine(name), actions: [open] }
  }
  const actions: AddAction[] = []
  for (const o of res.offers ?? []) {
    if (o.kind === 'employer' && o.employerId) actions.push({ kind: 'follow', label: `Follow ${o.name}`, employerId: o.employerId })
    else if (o.kind === 'posting' && o.url) actions.push({ kind: 'link', label: 'Use their own posting', link: o.url })
  }
  if (res.reason === 'no_board') actions.push({ kind: 'paste', label: 'Paste a link to one of their postings' })
  if (res.reason === 'cannot_read' && ctx.link) {
    actions.push({ kind: 'anyway', label: 'Follow anyway', link: ctx.link })
    actions.push({ kind: 'open', label: 'Open their site', href: ctx.link.startsWith('http') ? ctx.link : `https://${ctx.link}`, external: true })
  }
  return { kind: 'failed', line: failLine(res.reason, ctx), reason: res.reason, actions }
}

export type AddAct = { type: 'verify'; line: string } | { type: 'result'; state: AddState } | { type: 'reset' }

/** A result lands only while its own check is still the one on screen; typing again cancels it. */
export function addReducer(state: AddState, act: AddAct): AddState {
  switch (act.type) {
    case 'verify':
      return { kind: 'verifying', line: act.line }
    case 'result':
      return state.kind === 'verifying' ? act.state : state
    case 'reset':
      return { kind: 'idle' }
  }
}

/** The line under the field when a name finds nothing. */
export const unknownLine = (typed: string) => `Cello does not know '${typed}' yet.`

export interface Found {
  employers: CompanyItem[]
  notChecked: { id: string; name: string; domain: string | null }[]
}
