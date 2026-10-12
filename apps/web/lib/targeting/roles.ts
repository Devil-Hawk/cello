// Do a role and the person's targets agree? Settings -> Targeting
// (profiles.preferences.targeting, resolved by ../targeting) decides what a
// person sees by default on the Jobs list and on a company's open positions.
//
// No model call: a role is judged on what lib/jobs/classify.ts already wrote at
// ingest (function, seniority, country, language, remote) plus its title and
// description. Three answers:
//   inside        every dimension the person set agrees
//   outside       something the person set disagrees (or an excluded keyword/company)
//   unclassified  nothing disagrees but a dimension could not be read from the
//                 role (function 'other', no country, ...). Shown under "All roles" only.
//
// targetVerdict (in memory, for a company's roles) and applyRoleTargets (a
// PostgREST query, for the paged Jobs list) implement the same rule; the test
// runs both over one table of rows.

import type { Targeting } from '../targeting'

export type TargetVerdict = 'inside' | 'outside' | 'unclassified'

export interface RoleFields {
  title: string
  description?: string | null
  job_function?: string | null
  seniority?: string | null
  country?: string | null
  language?: string | null
  is_remote?: boolean | null
}

/** Targets that can decide a role. minScore is not one: it needs a model score. */
export function hasRoleTargets(t: Targeting): boolean {
  return (
    t.functions.length > 0 ||
    t.seniority.length > 0 ||
    t.countries.length > 0 ||
    t.remoteOnly ||
    t.languages.length > 0 ||
    t.excludedCompanies.length > 0 ||
    t.excludedKeywords.length > 0
  )
}

/**
 * A title with no level word ("Data Scientist", "Software Engineer") is an
 * ordinary individual-contributor role, so with junior, mid or senior targeted
 * an unmarked title counts as inside. Without this the default targets of a
 * junior or mid candidate would hide every plain title.
 */
const UNMARKED_IS_IC = ['junior', 'mid', 'senior']
const unmarkedSeniorityIsInside = (t: Targeting) => t.seniority.some((s) => UNMARKED_IS_IC.includes(s))

const isBlank = (v: string | null | undefined) => v == null || v === '' || v === 'unknown'

/**
 * Keywords reduced to what both a substring test and an ILIKE pattern treat
 * the same: wildcard and list-syntax characters are dropped.
 */
export function usableKeywords(t: Targeting): string[] {
  return t.excludedKeywords.map((k) => k.replace(/[%_\\,()"*]/g, '').trim()).filter(Boolean)
}

export function targetVerdict(job: RoleFields, t: Targeting, companyName?: string | null): TargetVerdict {
  const name = (companyName ?? '').toLowerCase()
  if (name && t.excludedCompanies.some((c) => name.includes(c))) return 'outside'
  const text = job.title.toLowerCase()
  const body = (job.description ?? '').toLowerCase()
  if (usableKeywords(t).some((k) => text.includes(k) || body.includes(k))) return 'outside'

  let unread = false

  if (t.functions.length > 0) {
    const fn = job.job_function
    if (fn && t.functions.includes(fn)) {
      /* inside */
    } else if (isBlank(fn) || fn === 'other') unread = true
    else return 'outside'
  }

  if (t.seniority.length > 0) {
    const sr = job.seniority
    if (sr && t.seniority.includes(sr)) {
      /* inside */
    } else if (isBlank(sr)) {
      if (!unmarkedSeniorityIsInside(t)) unread = true
    } else return 'outside'
  }

  if (t.countries.length > 0) {
    const c = job.country?.toUpperCase()
    if (!c) unread = true
    else if (!t.countries.includes(c)) return 'outside'
  }

  if (t.languages.length > 0) {
    const l = job.language?.toLowerCase()
    if (isBlank(l)) unread = true
    else if (!t.languages.includes(l!)) return 'outside'
  }

  if (t.remoteOnly) {
    if (job.is_remote === true) {
      /* inside */
    } else if (job.is_remote == null) unread = true
    else return 'outside'
  }

  return unread ? 'unclassified' : 'inside'
}

/** Ids of companies the person excluded by name, for the paged list (the jobs table has no company name). */
export function excludedCompanyIds(companies: ReadonlyArray<{ id: string; name: string }>, t: Targeting): string[] {
  if (t.excludedCompanies.length === 0) return []
  return companies
    .filter((c) => {
      const name = c.name.toLowerCase()
      return t.excludedCompanies.some((x) => name.includes(x))
    })
    .map((c) => c.id)
}

/** The PostgREST builder calls applyRoleTargets uses, so it works on any query. */
interface RoleFilterBuilder<T> {
  in(column: string, values: readonly string[]): T
  eq(column: string, value: unknown): T
  not(column: string, operator: string, value: unknown): T
  or(filters: string): T
}

export const quote = (v: string) => (/[,()"]/.test(v) ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : v)

/** Restrict a jobs query to roles whose verdict is 'inside'. Same rule as targetVerdict. */
export function applyRoleTargets<T extends RoleFilterBuilder<T>>(
  query: T,
  t: Targeting,
  excludedIds: readonly string[] = []
): T {
  let q = query
  if (t.functions.length > 0) q = q.in('job_function', t.functions)
  if (t.seniority.length > 0) {
    q = unmarkedSeniorityIsInside(t)
      ? q.or(`seniority.in.(${t.seniority.map(quote).join(',')}),seniority.eq.unknown,seniority.is.null`)
      : q.in('seniority', t.seniority)
  }
  if (t.countries.length > 0) q = q.in('country', t.countries)
  if (t.languages.length > 0) q = q.in('language', t.languages)
  if (t.remoteOnly) q = q.eq('is_remote', true)
  for (const k of usableKeywords(t)) {
    q = q.not('title', 'ilike', `%${k}%`).or(`description.is.null,description.not.ilike.${quote(`%${k}%`)}`)
  }
  if (excludedIds.length > 0) q = q.not('company_id', 'in', `(${excludedIds.join(',')})`)
  return q
}
