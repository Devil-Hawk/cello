// The shared half of the company page's insights (Part 1, 1.6), computed from one employer's whole board at each read
// and stored in employer_insights. Pure: nothing here reads the network or the database, and nothing is estimated.
// A field Cello cannot know is null or absent, never 0.

import type { AtsJob } from '../ats/types'
import { classifyJob } from '../jobs/classify'
import { normalizeCompanyName } from '../entities/companies'
import { typeTitle } from '../jobs/role-types'
import { stackWords } from './stack-words'

const DAY_MS = 86_400_000
const TOP_LOCATIONS = 8
const TOP_STACK = 30
/** Cello's own close times say nothing about the pace until this many postings have closed. */
export const MIN_CLOSES = 10

export interface Pay {
  /** Postings whose stated yearly range is inside min to max, in `currency`. */
  stated: number
  /** The lowest and highest yearly figure stated in `currency`; null when no posting states a yearly range Cello can read. */
  min: number | null
  max: number | null
  currency: string | null
}

export interface Insights {
  open: number
  byType: { roleType: string | null; open: number }[]
  bySeniority: Record<string, number>
  locations: { name: string; count: number }[]
  /** Share of postings that say remote, 0 to 1; null on an empty board. */
  remoteShare: number | null
  posted7d: number
  posted30d: number
  pay: Pay
  medianAgeDays: number | null
  typicalCloseDays: number | null
  closesSeen: number
  stack: { name: string; count: number }[]
}

export interface InsightOpts {
  now: number
  /** This employer's closed postings: when Cello first saw each (jobs.discovered_at) and when it closed (jobs.closed_at). */
  closes: { firstSeen: string; closedAt: string }[]
  /** The employer's name: a posting names its own employer in every line, so a stack word that is the employer is left out. */
  employer?: string
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const tally = <T>(items: T[], key: (t: T) => string | null) => {
  const out = new Map<string, number>()
  for (const i of items) {
    const k = key(i)
    if (k !== null) out.set(k, (out.get(k) ?? 0) + 1)
  }
  return out
}

/**
 * A yearly range as the adapters write it: "USD 140,000–240,000 / yr" (Ashby), "USD 150,000–190,000 per year salary"
 * (Lever) or "USD 75,000 per year" (Recruitee). An hourly or monthly rate, a bonus and a pre-rendered phrase
 * ("Competitive") give no yearly figure.
 *
 * ponytail: Ashby writes "/ yr" for every interval after multiplying (hourly x2080, daily x260, monthly x12, lib/ats/ashby.ts)
 * and does not mark which it started from, so an hourly Ashby posting reads here as a stated yearly figure. Only the
 * adapter can tell them apart; the upgrade is for it to leave the multiplied ones unmarked or flagged.
 */
const YEARLY = /^([A-Z]{3}) ([\d,]+)(?:–([\d,]+))? (?:\/ yr|per year(?: salary)?)$/
function yearly(salary: string): { currency: string; lo: number; hi: number } | null {
  const m = YEARLY.exec(salary.trim())
  if (!m) return null
  const lo = Number(m[2].replace(/,/g, ''))
  const hi = Number((m[3] ?? m[2]).replace(/,/g, ''))
  return Number.isFinite(lo) && Number.isFinite(hi) ? { currency: m[1], lo: Math.min(lo, hi), hi: Math.max(lo, hi) } : null
}

/**
 * One range, over the postings that state a yearly amount in one currency, and `stated` is how many postings that is,
 * so the count never claims more than the range covers. The currency with most postings wins; a tie goes to USD, then
 * to the code that sorts first. No such posting gives no range at all.
 */
function payOf(jobs: AtsJob[]): Pay {
  const ranges = jobs.map((j) => (j.salary ? yearly(j.salary) : null)).filter((r): r is NonNullable<typeof r> => r !== null)
  const byCurrency = tally(ranges, (r) => r.currency)
  const rank = (c: string) => (c === 'USD' ? 0 : 1)
  const currency = [...byCurrency].sort((a, b) => b[1] - a[1] || rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))[0]?.[0]
  if (!currency) return { stated: 0, min: null, max: null, currency: null }
  const own = ranges.filter((r) => r.currency === currency)
  return { stated: own.length, min: Math.min(...own.map((r) => r.lo)), max: Math.max(...own.map((r) => r.hi)), currency }
}

export function computeInsights(jobs: AtsJob[], opts: InsightOpts): Insights {
  const open = jobs.length
  const classes = jobs.map((j) => classifyJob({ title: j.title, description: j.description, location: j.location }))
  const ages = jobs.map((j) => (j.postedAt ? (opts.now - Date.parse(j.postedAt)) / DAY_MS : NaN)).filter((a) => !Number.isNaN(a)).map((a) => Math.max(0, a))
  const closeDays = opts.closes.map((c) => (Date.parse(c.closedAt) - Date.parse(c.firstSeen)) / DAY_MS).filter((d) => Number.isFinite(d) && d >= 0)
  const typical = closeDays.length >= MIN_CLOSES ? median(closeDays) : null
  // A place is counted once per posting; Ashby joins a posting's extra places with " · ", Greenhouse with ";".
  const places = new Map<string, { name: string; count: number }>()
  for (const j of jobs) {
    for (const name of new Set((j.location ?? '').split(/ · |;/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean))) {
      const at = places.get(name.toLowerCase()) ?? { name, count: 0 }
      at.count++
      places.set(name.toLowerCase(), at)
    }
  }
  const own = new Set(normalizeCompanyName(opts.employer ?? '').split(' '))
  const stack = new Map<string, number>()
  for (const j of jobs) for (const w of stackWords(`${j.title}\n${j.description ?? ''}`)) if (!own.has(w.toLowerCase())) stack.set(w, (stack.get(w) ?? 0) + 1)
  const bySeniority = Object.fromEntries(tally(classes, (c) => c.seniority))
  const types = tally(jobs, (j) => typeTitle(j.title.trim()).role_type ?? '')
  return {
    open,
    byType: [...types].map(([t, n]) => ({ roleType: t || null, open: n })).sort((a, b) => b.open - a.open || String(a.roleType).localeCompare(String(b.roleType))),
    bySeniority,
    locations: [...places.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, TOP_LOCATIONS),
    remoteShare: open ? Math.round((classes.filter((c) => c.isRemote).length / open) * 100) / 100 : null,
    posted7d: ages.filter((a) => a <= 7).length,
    posted30d: ages.filter((a) => a <= 30).length,
    pay: payOf(jobs),
    medianAgeDays: ages.length ? Math.round(median(ages) as number) : null,
    typicalCloseDays: typical === null ? null : Math.round(typical),
    closesSeen: closeDays.length,
    stack: [...stack].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, TOP_STACK),
  }
}
