// The Roles page as pure functions: what the address asks for, how rows are
// ordered and grouped, and the lines that carry a count. No I/O and no model.
// Every number a header shows is passed in (from role_counts in SQL); nothing
// here counts the rows it was given and calls that the total.

import { compareRankable, type Rankable } from '@/lib/scoring/shortlist'
import type { Chance } from '@/lib/scoring/types'
import type { PickItem, RoleItem } from './types'

export const PAGE = 25
export const PER_GROUP = 3
export const BAND_SIZE = 6

export const TABS = ['for-you', 'saved', 'hidden'] as const
export type Tab = (typeof TABS)[number]
export const TAB_LABEL: Record<Tab, string> = { 'for-you': 'For you', saved: 'Saved', hidden: 'Hidden' }

export const GROUPS = ['ranked', 'company', 'type'] as const
export type GroupBy = (typeof GROUPS)[number]
export const GROUP_LABEL: Record<GroupBy, string> = { ranked: 'Ranked', company: 'Company', type: 'Role type' }

export const POSTED = ['any', '24h', '7d', '30d'] as const
export type Posted = (typeof POSTED)[number]
export const POSTED_LABEL: Record<Posted, string> = { any: 'Any time', '24h': '24 hours', '7d': '7 days', '30d': '30 days' }
export const POSTED_HOURS: Record<Exclude<Posted, 'any'>, number> = { '24h': 24, '7d': 168, '30d': 720 }

export const LEVELS = ['intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'manager', 'director', 'exec'] as const

export interface RolesQuery {
  tab: Tab
  group: GroupBy
  sort: 'ranked' | 'newest'
  level: (typeof LEVELS)[number] | null
  posted: Posted
  undated: boolean
  remote: boolean
  /** Two letters, upper case. */
  country: string | null
  /** A company id (the shared employer's or the person's own). */
  company: string | null
  /** A role type id, as the person sees it (their own word over the posting's). */
  roleType: string | null
  /** Only roles at employers the person follows. */
  following: boolean
  /** Only employers with past H-1B filings, offered to a person who needs sponsorship. */
  h1b: boolean
  hideAgency: boolean
  /** How many rows are shown: PAGE, then PAGE more at a time. */
  limit: number
}

export const DEFAULT_QUERY: RolesQuery = {
  tab: 'for-you',
  group: 'ranked',
  sort: 'ranked',
  level: null,
  posted: 'any',
  undated: false,
  remote: false,
  country: null,
  company: null,
  roleType: null,
  following: false,
  h1b: false,
  hideAgency: false,
  limit: PAGE,
}

const TYPE_ID = /^[a-z][a-z0-9-]{0,62}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}

function pick<T extends string>(v: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback
}

/** What the address asks for. Anything that is not a known value falls back to the default; nothing is thrown. */
export function parseRolesQuery(sp: Record<string, string | string[] | undefined>): RolesQuery {
  const country = one(sp.country)?.trim().toUpperCase()
  const company = one(sp.company)
  const roleType = one(sp.type)
  const limit = Number(one(sp.limit))
  return {
    tab: pick(one(sp.tab), TABS, DEFAULT_QUERY.tab),
    group: pick(one(sp.group), GROUPS, DEFAULT_QUERY.group),
    sort: one(sp.sort) === 'newest' ? 'newest' : 'ranked',
    level: LEVELS.includes(one(sp.level) as (typeof LEVELS)[number]) ? (one(sp.level) as (typeof LEVELS)[number]) : null,
    posted: pick(one(sp.posted), POSTED, DEFAULT_QUERY.posted),
    undated: one(sp.undated) === '1',
    remote: one(sp.remote) === '1',
    country: country && /^[A-Z]{2}$/.test(country) ? country : null,
    company: company && UUID.test(company) ? company : null,
    roleType: roleType && TYPE_ID.test(roleType) ? roleType : null,
    following: one(sp.following) === '1',
    h1b: one(sp.h1b) === '1',
    hideAgency: one(sp.agency) === 'hide',
    limit: Number.isInteger(limit) && limit >= PAGE ? Math.min(limit, 300) : PAGE,
  }
}

/** The address for a query: only what differs from the default, so filters stay in the address and the default page has none. */
export function rolesHref(q: RolesQuery, change: Partial<RolesQuery> = {}): string {
  const n = { ...q, ...change }
  const p = new URLSearchParams()
  if (n.tab !== DEFAULT_QUERY.tab) p.set('tab', n.tab)
  if (n.group !== DEFAULT_QUERY.group) p.set('group', n.group)
  if (n.sort !== DEFAULT_QUERY.sort) p.set('sort', n.sort)
  if (n.level) p.set('level', n.level)
  if (n.posted !== DEFAULT_QUERY.posted) p.set('posted', n.posted)
  if (n.undated) p.set('undated', '1')
  if (n.remote) p.set('remote', '1')
  if (n.country) p.set('country', n.country)
  if (n.company) p.set('company', n.company)
  if (n.roleType) p.set('type', n.roleType)
  if (n.following) p.set('following', '1')
  if (n.h1b) p.set('h1b', '1')
  if (n.hideAgency) p.set('agency', 'hide')
  if (n.limit !== DEFAULT_QUERY.limit) p.set('limit', String(n.limit))
  const s = p.toString()
  return s ? `/roles?${s}` : '/roles'
}

/** How many filters are on, for the Filters button. Tab, grouping and sort are not filters. */
export function filterCount(q: RolesQuery): number {
  return [q.level, q.posted !== 'any', q.remote, q.country, q.company, q.roleType, q.following, q.h1b, q.hideAgency].filter(Boolean).length
}

// --- order -------------------------------------------------------------------

const byNewest = (a: RoleItem, b: RoleItem) =>
  (b.postedAt ?? '').localeCompare(a.postedAt ?? '') || a.id.localeCompare(b.id)

function rankable(i: RoleItem): Rankable {
  return { jobId: i.id, p: i.wantP ?? 0, reason: i.read ?? '', chance: (i.chance ?? 'cannot_assess') as Chance, gaps: [] }
}

/**
 * Ranked: roles Cello has judged first (want band, then chance), then the ones
 * not yet checked, newest first, in code order. The picks band sits above this
 * and is taken out of it by the caller.
 */
export function rankItems(items: readonly RoleItem[]): RoleItem[] {
  const judged = items.filter((i) => i.wantP !== null).sort((a, b) => compareRankable(rankable(a), rankable(b)))
  const rest = items.filter((i) => i.wantP === null).sort(byNewest)
  return [...judged, ...rest]
}

export function orderItems(items: readonly RoleItem[], sort: RolesQuery['sort']): RoleItem[] {
  return sort === 'newest' ? [...items].sort(byNewest) : rankItems(items)
}

/** The band above the list: the day's picks, or while picks are off the newest kept roles in code order. */
export function bandOf(items: readonly RoleItem[], picks: readonly PickItem[]): { kind: 'picks' | 'newest'; items: RoleItem[] } {
  if (picks.length > 0) return { kind: 'picks', items: [...picks] }
  return { kind: 'newest', items: [...items].sort(byNewest).slice(0, BAND_SIZE) }
}

// --- groups ------------------------------------------------------------------

export interface RoleGroup {
  key: string
  company: string
  companyId: string | null
  domain: string | null
  logoUrl: string | null
  /** The top rows shown. */
  items: RoleItem[]
  /** The person's roles at this employer, from role_counts; null when it is not known. */
  count: number | null
  /** Roles still unseen under the header: "9 more at Stripe". Null when the count is not known. */
  more: number | null
  /** Open roles at the employer from its last read ("of 636 open"). */
  open: number | null
  /** Why Cello cannot read this employer, when it cannot. The header then shows this and no count. */
  cannotRead: string | null
}

export interface EmployerFacts {
  open: number | null
  cannotRead: string | null
}

/** One group per employer, in the order of each group's best row. Counts come from SQL, never from the rows passed in. */
export function groupByCompany(
  ordered: readonly RoleItem[],
  counts: Readonly<Record<string, number>>,
  facts: Readonly<Record<string, EmployerFacts>> = {},
  perGroup = PER_GROUP,
): RoleGroup[] {
  const groups = new Map<string, RoleGroup>()
  for (const item of ordered) {
    const key = item.companyId ?? `none:${item.company}`
    let g = groups.get(key)
    if (!g) {
      const f = facts[key]
      g = {
        key,
        company: item.company,
        companyId: item.companyId,
        domain: item.domain,
        logoUrl: item.logoUrl,
        items: [],
        count: f?.cannotRead ? null : (counts[key] ?? null),
        more: null,
        open: f?.open ?? null,
        cannotRead: f?.cannotRead ?? null,
      }
      groups.set(key, g)
    }
    if (g.items.length < perGroup) g.items.push(item)
  }
  for (const g of groups.values()) g.more = g.count === null ? null : Math.max(0, g.count - g.items.length)
  return [...groups.values()]
}

/** "12 for you of 636 open", or "12 for you" when the last read has no total, or the reason when the employer cannot be read. */
export function groupCountLine(g: Pick<RoleGroup, 'count' | 'open' | 'cannotRead'>): string | null {
  if (g.cannotRead) return `Cello cannot read this site: ${g.cannotRead}`
  if (g.count === null) return null
  return g.open === null ? `${g.count} for you` : `${g.count} for you of ${g.open} open`
}

export interface TypeGroup {
  /** The role type id, or 'none' for roles no tier could type. */
  key: string
  label: string
  items: RoleItem[]
  /** The person's roles of this type, from role_counts('role_type'); null when it is not known (the untyped group). */
  count: number | null
  more: number | null
}

/** One group per role type, in the order of each group's best row. Counts come from SQL, never from the rows passed in. */
export function groupByType(ordered: readonly RoleItem[], counts: Readonly<Record<string, number>>, perGroup = PER_GROUP): TypeGroup[] {
  const groups = new Map<string, TypeGroup>()
  for (const item of ordered) {
    const key = item.type?.id ?? 'none'
    let g = groups.get(key)
    if (!g) {
      g = { key, label: item.type?.label ?? 'No type yet', items: [], count: key === 'none' ? null : (counts[key] ?? null), more: null }
      groups.set(key, g)
    }
    if (g.items.length < perGroup) g.items.push(item)
  }
  for (const g of groups.values()) g.more = g.count === null ? null : Math.max(0, g.count - g.items.length)
  return [...groups.values()]
}

/** "AI Engineer, 31": a type group's header, never without its honest count (the untyped group says no number). */
export function typeGroupHeader(g: Pick<TypeGroup, 'label' | 'count'>): string {
  return g.count === null ? g.label : `${g.label}, ${g.count}`
}

// --- lines ---------------------------------------------------------------------

/** "Posted 5h ago", "Posted 3 days ago". */
export function postedAgo(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const hours = Math.max(0, Math.floor((now - t) / 3_600_000))
  if (hours < 1) return 'Posted just now'
  if (hours < 24) return `Posted ${hours}h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? 'Posted yesterday' : `Posted ${days} days ago`
}

const LEVEL_WORD: Record<string, string> = { intern: 'Intern', junior: 'Junior', mid: 'Mid', senior: 'Senior', staff: 'Staff', principal: 'Principal', manager: 'Manager', director: 'Director', exec: 'Executive' }

/** "AI Engineer, Senior": the role type then the level, whichever the role has. */
export function typeLevel(i: Pick<RoleItem, 'type' | 'level'>): string | null {
  return [i.type?.label, i.level ? LEVEL_WORD[i.level] : null].filter(Boolean).join(', ') || null
}

/** One line of facts under a row: role type and level, place, pay as stated, posted. Plain text. */
export function metaLine(i: RoleItem, now = Date.now()): string {
  return [
    i.pasted ? 'You pasted this' : null,
    i.legit === 'agency' ? 'Agency' : i.legit === 'repost' ? 'Repost' : null,
    typeLevel(i),
    i.location,
    i.pay,
    postedAgo(i.postedAt, now),
  ]
    .filter(Boolean)
    .join(' · ')
}

const OUTSIDE_WORD: Record<string, string> = {
  place: 'place',
  title: 'other role types',
  level: 'level',
  excluded: 'on your leave-out list',
  age: 'older than 180 days',
}

/** "214 roles outside your search this week: 120 place, 80 other role types, 14 level." Null when none were left out. */
export function outsideLine(byReason: Readonly<Record<string, number>>): string | null {
  const parts = Object.entries(byReason)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const total = parts.reduce((s, [, n]) => s + n, 0)
  if (total === 0) return null
  const list = parts.map(([r, n]) => `${n} ${OUTSIDE_WORD[r] ?? r}`).join(', ')
  return `${total} ${total === 1 ? 'role' : 'roles'} outside your search this week: ${list}.`
}

/** The chance as the chip says it, or null when it has not been checked (a row then says nothing, never "Not scored"). */
export function chanceWord(c: Chance | null): string | null {
  return c === 'strong' ? 'Strong' : c === 'possible' ? 'Possible' : c === 'stretch' ? 'Stretch' : null
}
