// The company page's shared insight lines, worded here once so the page shows them as given (Part 1, 1.6).
// Every line carries its source and the time it was worked out. A fact Cello does not have gives no line, never a zero.

import { SENIORITY_LEVELS } from '../jobs/classify'
import { getRoleType } from '../jobs/role-types'
import { normalizeCompanyName } from '../entities/companies'
import sponsors from '../dossier/h1b-sponsors.json'

export interface InsightLine {
  text: string
  /** Where the fact comes from, in words: "careers.datadoghq.com". */
  source: string
  /** When Cello worked it out or fetched it (ISO); null for a list Cello keeps in its code. */
  at: string | null
}

/** A row of employer_insights as company_page returns it (jsonb: the columns' own names). */
export interface InsightsRow {
  computed_at: string
  open: number
  by_type: { roleType: string | null; open: number }[]
  by_seniority: Record<string, number>
  locations: { name: string; count: number }[]
  remote_share: number | null
  posted_7d: number
  posted_30d: number
  pay: { stated: number; min: number | null; max: number | null; currency: string | null }
  median_age_days: number | null
  typical_close_days: number | null
  closes_seen: number
  stack: { name: string; count: number }[]
}

export interface InsightEmployer {
  name: string
  domain: string | null
  careersUrl: string | null
  provider: string | null
  profile: Record<string, unknown> | null
}

const SHOWN_TYPES = 3
const SHOWN_PLACES = 5
const SHOWN_STACK = 4
const SENIOR_FIRST = [...SENIORITY_LEVELS].reverse().filter((l) => l !== 'unknown')
const LISTED = new Set(sponsors.sponsors.map(normalizeCompanyName))

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
// Sentence case: "ML Engineer" reads "ML engineer" (acronyms stay).
const typeWords = (id: string) => (getRoleType(id)?.label ?? id).split(' ').map((w) => (w === w.toUpperCase() ? w : w.toLowerCase())).join(' ')
const money = (n: number, currency: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n)

function span(days: number): string {
  if (days < 14) return plural(days, 'day', 'days')
  return days < 90 ? `${Math.round(days / 7)} weeks` : `${Math.round(days / 30)} months`
}

function hostOf(url: string | null): string | null {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, '') : null
  } catch {
    return null
  }
}

const label = (p: string) => (p === 'smartrecruiters' ? 'SmartRecruiters' : p.charAt(0).toUpperCase() + p.slice(1))

function hiring(i: InsightsRow): string {
  const typed = i.by_type.filter((t) => t.roleType)
  const shown = typed.slice(0, SHOWN_TYPES)
  const other = i.open - shown.reduce((n, t) => n + t.open, 0)
  const types = [...shown.map((t) => `${t.open} ${typeWords(t.roleType as string)}`), ...(shown.length && other > 0 ? [`${other} other`] : [])]
  const levels = SENIOR_FIRST.filter((l) => i.by_seniority[l] > 0).map((l) => `${i.by_seniority[l]} ${l}`)
  const posted = [...(i.posted_7d > 0 ? [`${i.posted_7d} posted this week`] : []), ...(i.posted_30d > 0 ? [`${i.posted_30d}${i.posted_7d > 0 ? '' : ' posted'} this month`] : [])]
  const remote = i.remote_share ? `${Math.round(i.remote_share * 100)} % remote` : null
  // "Paris, France" is Paris on this line; the stored places keep what the postings say
  const places = [...new Set(i.locations.map((p) => p.name.split(',')[0].trim()))].slice(0, SHOWN_PLACES).join(', ')
  return [
    `Hiring ${plural(i.open, 'role', 'roles')}${types.length ? `: ${types.join(', ')}` : ''}.`,
    levels.length ? `${levels.join(', ')}.` : '',
    posted.length ? `${posted.join(', ')}.` : '',
    places ? `${places}${remote ? ` (${remote})` : ''}.` : remote ? `${remote}.` : '',
  ].filter(Boolean).join(' ')
}

function company(p: Record<string, unknown>): InsightLine | null {
  // A lookup that matched nobody, or found no website, says nothing about this employer.
  if (p.matched === false || typeof p.website !== 'string' || !p.website) return null
  const str = (...keys: string[]) => keys.map((k) => p[k]).find((v): v is string => typeof v === 'string' && v.trim() !== '')
  const people = [p.employees, p.size].find((v): v is number => typeof v === 'number' && v > 0)
  const parts = [
    `website ${p.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}`,
    str('hq', 'headquarters') && `headquarters ${str('hq', 'headquarters')}`,
    people && `about ${people.toLocaleString('en-US')} people`,
    str('industry') && `industry ${str('industry')}`,
    typeof p.founded === 'number' || str('founded') ? `founded ${p.founded}` : '',
    str('ticker') && `ticker ${str('ticker')}`,
    str('github') && `GitHub ${str('github')}`,
  ].filter(Boolean)
  const source = str('source') ?? 'a public source'
  return { text: `${parts.join(', ').replace(/^./, (c) => c.toUpperCase())}.`, source: source.replace(/^./, (c) => c.toUpperCase()), at: str('fetched_at', 'checked_at') ?? null }
}

/** The lines in the order the page shows them: hiring, pay, pace, age, stack, visa, company. */
export function insightLines(row: InsightsRow | null, e: InsightEmployer): InsightLine[] {
  const lines: InsightLine[] = []
  if (row && row.open > 0) {
    const board = hostOf(e.careersUrl) ?? (e.provider ? `${label(e.provider)} board` : 'its job board')
    const at = row.computed_at
    lines.push({ text: hiring(row), source: board, at })
    const { stated, min, max, currency } = row.pay
    if (stated > 0) {
      const range = min !== null && max !== null && currency ? `: ${money(min, currency)}${max > min ? ` to ${money(max, currency)}` : ''}` : ''
      lines.push({ text: `Pay stated on ${stated} of ${row.open}${range}.`, source: board, at })
    }
    if (row.typical_close_days !== null) {
      lines.push({ text: `Postings typically close in about ${span(row.typical_close_days)} (from ${plural(row.closes_seen, 'posting', 'postings')} Cello watched close here).`, source: "Cello's own record of this board", at })
    }
    if (row.median_age_days !== null) {
      lines.push({ text: `Median posting age ${row.median_age_days === 0 ? 'under a day' : plural(row.median_age_days, 'day', 'days')}.`, source: board, at })
    }
    if (row.stack.length) lines.push({ text: `Named in postings: ${row.stack.slice(0, SHOWN_STACK).map((s) => `${s.name} ${s.count}`).join(', ')}.`, source: board, at })
  }
  // The list holds names only, so the line says an employer is on it and gives no count.
  if (LISTED.has(normalizeCompanyName(e.name)) || (e.domain && LISTED.has(e.domain.split('.')[0]))) {
    lines.push({ text: 'Has a record of H-1B filings in public U.S. Department of Labor data.', source: 'U.S. Department of Labor H-1B disclosure data, as a list in Cello', at: null })
  }
  const profile = e.profile && company(e.profile)
  if (profile) lines.push(profile)
  return lines
}
