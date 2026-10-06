// What the Copilot's search_roles and refresh_companies decide in code: which
// title and place words match, which followed companies are worth re-reading,
// and the answer to a find request. Pure: no database, no network, no model.

import { isTrackedCompany } from '../companies/watchlist'
import { lastCheckedMs } from '../companies/roles-status'
import { hasSource } from '../ingest/run'
import { classifyTitleForIntent, keywordsForIntent, resolveRoleIntent } from './role-taxonomy'

export const REFRESH_AFTER_MS = 6 * 3_600_000
export const REFRESH_MAX_PER_TURN = 5

const FILLER = new Set(['role', 'roles', 'job', 'jobs', 'position', 'positions', 'in', 'at', 'the', 'a', 'for'])

export interface TitleMatcher {
  label: string
  keywords: string[]
  matches(title: string): boolean
}

/** Title words and their short forms (FDE, ML engineer). Adjacent titles only when `adjacent` is set. */
export function titleMatcher(title?: string, adjacent = false): TitleMatcher | null {
  const text = title?.trim()
  if (!text) return null
  const intent = resolveRoleIntent(text)
  if (intent) {
    return {
      label: intent.label,
      keywords: keywordsForIntent(intent, { includeAdjacent: adjacent }),
      matches: (t) => {
        const v = classifyTitleForIntent(t, intent)
        return v === 'in-role' || (adjacent && v === 'adjacent')
      },
    }
  }
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !FILLER.has(w))
  if (words.length === 0) return null
  return {
    label: words.join(' '),
    keywords: [words.reduce((a, b) => (b.length > a.length ? b : a))],
    matches: (t) => {
      const have = new Set(t.toLowerCase().split(/[^a-z0-9]+/))
      return words.every((w) => have.has(w))
    },
  }
}

const PLACE_ALIASES: Record<string, string[]> = {
  sf: ['san francisco', 'sf'],
  'san francisco': ['san francisco'],
  'bay area': ['san francisco', 'oakland', 'san jose', 'palo alto', 'mountain view', 'menlo park', 'sunnyvale', 'redwood city'],
  nyc: ['new york', 'nyc'],
  'new york': ['new york'],
  la: ['los angeles'],
}

export interface PlaceMatcher {
  remote: boolean
  /** What to ILIKE in SQL; the in-memory match is the exact one. */
  patterns: string[]
  matches(loc: string | null, isRemote: boolean | null): boolean
}

const wholeWord = (s: string) =>
  new RegExp(`(?<![A-Za-z0-9])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i')

/** A city, a state code or remote, matched on the stored location text. */
export function placeMatcher(place?: string): PlaceMatcher | null {
  const p = place?.trim()
  if (!p) return null
  const key = p.toLowerCase()
  if (key === 'remote') {
    return { remote: true, patterns: ['remote'], matches: (loc, isRemote) => isRemote === true || /\bremote\b/i.test(loc ?? '') }
  }
  const alias = PLACE_ALIASES[key]
  if (alias) {
    const res = alias.map(wholeWord)
    return { remote: false, patterns: alias, matches: (loc) => !!loc && res.some((r) => r.test(loc)) }
  }
  if (/^[A-Za-z]{2}$/.test(p)) {
    const code = p.toUpperCase()
    const re = new RegExp(`\\b${code}\\b`)
    return { remote: false, patterns: [code], matches: (loc) => !!loc && re.test(loc) }
  }
  const re = wholeWord(p)
  return { remote: false, patterns: [p], matches: (loc) => !!loc && re.test(loc) }
}

interface CompanyRow {
  name: string
  metadata?: unknown
  last_scraped_at?: string | null
  career_url: string | null
}

/** Followed companies worth reading again: never checked first, then the oldest, at most 5. */
export function pickCompaniesToRefresh<T extends CompanyRow>(rows: T[], now: number) {
  const tracked = rows.filter(isTrackedCompany)
  const withSource = tracked.filter(hasSource)
  const age = (c: T) => lastCheckedMs(c)
  const stale = withSource.filter((c) => {
    const last = age(c)
    return last === null || now - last >= REFRESH_AFTER_MS
  })
  stale.sort((a, b) => (age(a) ?? -Infinity) - (age(b) ?? -Infinity))
  return {
    pick: stale.slice(0, REFRESH_MAX_PER_TURN),
    /** Every followed company with something to read that was not checked in the last 6 hours, picked or not. */
    stale: stale.map((c) => c.name),
    fresh: withSource.filter((c) => !stale.includes(c)).map((c) => c.name),
    noSource: tracked.filter((c) => !hasSource(c)).map((c) => c.name),
  }
}

export interface RoleLine {
  title: string | null
  company: string | null
  url: string | null
  location: string | null
  isRemote?: boolean | null
  postedAt: string | null
  insideTargets?: boolean
}

export function formatRoleLine(r: RoleLine): string {
  const title = (r.title ?? 'Untitled').replace(/[[\]]/g, '')
  const head = r.url ? `[${title}](${r.url})` : title
  const place = r.location?.trim() || (r.isRemote ? 'Remote' : 'place not listed')
  const posted = r.postedAt ? `posted ${r.postedAt.slice(0, 10)}` : 'undated'
  return `- ${[head, r.company ?? 'unknown company', place, posted].join(', ')}${r.insideTargets === false ? ', outside your targets' : ''}`
}

function names(list: string[], joiner = 'and'): string {
  const shown = list.slice(0, 5)
  const all = list.length > 5 ? [...shown, `${list.length - 5} more`] : shown
  return all.length > 1 ? `${all.slice(0, -1).join(', ')} ${joiner} ${all[all.length - 1]}` : (all[0] ?? '')
}

export interface RoleAnswerInput {
  /** Followed companies that were searched. */
  searched: string[]
  /** Open roles stored for them (inside the person's targets when they set any). */
  poolCount: number
  scoped: boolean
  /** The title as asked (the taxonomy label when it has one) and the place as asked. */
  title?: string
  place?: string
  roles: RoleLine[]
  limit: number
  /** Followed companies not checked in the last 6 hours. */
  notChecked: string[]
}

/** The reply to a find request. Code writes it; the model does not. */
export function formatRoleAnswer(i: RoleAnswerInput): string {
  if (i.searched.length === 0) {
    return 'You follow no companies yet. Following one on [Companies](/companies) brings its board in.'
  }
  const roles = i.roles.slice(0, i.limit)
  const kind = `${i.title ? `${i.title} ` : ''}roles${i.place ? ` in ${i.place}` : ''}`
  const lines = [
    `Searched ${names(i.searched)}: ${i.poolCount} open roles${i.scoped ? ' inside your targets' : ''}, ${roles.length} ${kind}.`,
    ...roles.map(formatRoleLine),
  ]
  if (roles.length < i.limit) {
    const have = new Set(roles.map((r) => r.company))
    const none = i.searched.filter((n) => !have.has(n))
    const who = none.length > 0 ? `No ${kind} at ${names(none, 'or')}.` : `Those are all the ${kind} at the companies you follow.`
    lines.push(`${who} Following another company on [Companies](/companies) brings its board in.`)
  }
  if (i.notChecked.length > 0) lines.push(`Not checked in the last 6 hours: ${names(i.notChecked)}.`)
  return lines.join('\n')
}
