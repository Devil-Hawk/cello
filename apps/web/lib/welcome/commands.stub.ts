// lane-stub: PG1 welcome-commands
//
// Welcome's calls, written against the routes and tables main has today, until
// K10's commands (search.update, onboarding.finish, role_types.list, roles.find)
// are on main. When PG1 rebases after K10, Welcome calls those through K10's
// session door and this file is deleted.
//
// The facts (pay floor, work authorization, sponsorship) are saved through
// /api/settings/constraints, the same store Settings' dealbreakers edits. They
// move to K10's profile.set_facts, and the roles' reactions to roles.react
// (Welcome's roles use the Interested and Not for me control of components/fit).

import type { SupabaseClient } from '@supabase/supabase-js'
import { ROLE_TAXONOMY } from '@/lib/jobs/role-taxonomy'
import type { JobFunction } from '@/lib/jobs/classify'
import { openRolesOnly } from '@/lib/jobs/freshness'
import { fetchClientSafePreferences, markOnboarded } from '@/lib/preferences/client-safe'
import { EMPTY_TARGETING, type Targeting } from '@/lib/targeting'
import { applyRoleTargets, hasRoleTargets } from '@/lib/targeting/roles'

export interface RoleTypeOption {
  id: string
  label: string
  functions: JobFunction[]
}

// Which job function each role type sits in: the filter main applies today.
const FUNCTION_OF: Record<string, JobFunction> = {
  'data-scientist': 'data',
  'data-engineer': 'data',
  'data-analyst': 'data',
  'product-manager': 'product',
}

/** The role types a person can pick, from the taxonomy main already has. */
export function roleTypeOptions(): RoleTypeOption[] {
  return ROLE_TAXONOMY.map((r) => ({ id: r.id, label: r.label, functions: [FUNCTION_OF[r.id] ?? 'engineering'] }))
}

export const LEVELS = [
  { id: 'early', label: 'Early career', seniority: ['intern', 'junior'] },
  { id: 'mid', label: 'Mid', seniority: ['mid'] },
  { id: 'senior', label: 'Senior', seniority: ['senior'] },
  { id: 'lead', label: 'Staff and above', seniority: ['staff', 'principal'] },
] as const

export const COUNTRIES = [
  { code: 'US', label: 'United States' },
  { code: 'CA', label: 'Canada' },
  { code: 'GB', label: 'United Kingdom' },
  { code: 'DE', label: 'Germany' },
  { code: 'IN', label: 'India' },
] as const

export interface WelcomeTargets {
  roleTypeIds: string[]
  levelIds: string[]
  remoteOnly: boolean
  countries: string[]
  excludedCompanies: string[]
  excludedWords: string[]
  /** Lowest yearly pay in USD, null when not asked. */
  salaryFloorUsd: number | null
  /** Needs an employer to sponsor the right to work: null until answered, so an unanswered question never overwrites. */
  needsSponsorship: boolean | null
}

export const EMPTY_WELCOME_TARGETS: WelcomeTargets = {
  roleTypeIds: [],
  levelIds: [],
  remoteOnly: false,
  countries: [],
  excludedCompanies: [],
  excludedWords: [],
  salaryFloorUsd: null,
  needsSponsorship: null,
}

/** What a person asked for, as the targeting main stores and every reader already understands. */
export function toTargeting(w: WelcomeTargets): Targeting {
  const options = roleTypeOptions().filter((o) => w.roleTypeIds.includes(o.id))
  return {
    ...EMPTY_TARGETING,
    functions: Array.from(new Set(options.flatMap((o) => o.functions))),
    seniority: Array.from(new Set(LEVELS.filter((l) => w.levelIds.includes(l.id)).flatMap((l) => [...l.seniority]))),
    countries: w.countries.map((c) => c.toUpperCase()),
    remoteOnly: w.remoteOnly,
    excludedCompanies: w.excludedCompanies.map((c) => c.trim().toLowerCase()).filter(Boolean),
    excludedKeywords: w.excludedWords.map((c) => c.trim().toLowerCase()).filter(Boolean),
  }
}

/**
 * The facts, as the constraints store keeps them. Read first and written back
 * whole, so everything the person did not touch here (blocked countries, levels,
 * on-site cities) survives. The countries they can work in are work
 * authorization; the question about sponsorship is the second fact.
 */
export async function setFacts(w: WelcomeTargets): Promise<boolean> {
  const asked = {
    ...(w.salaryFloorUsd !== null && { salaryFloorUsd: w.salaryFloorUsd }),
    ...(w.needsSponsorship !== null && { needsSponsorship: w.needsSponsorship }),
    ...(w.countries.length > 0 && { onlyCountries: w.countries.map((c) => c.toUpperCase()) }),
  }
  if (Object.keys(asked).length === 0) return true
  const current = await fetch('/api/settings/constraints')
    .then((r) => (r.ok ? (r.json() as Promise<{ constraints?: Record<string, unknown> }>) : null))
    .catch(() => null)
  if (!current?.constraints) return false
  const res = await fetch('/api/settings/constraints', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...current.constraints, ...asked }),
  })
  return res.ok
}

/** search.update, over main's route. It keeps whatever else the person already set (languages, minimum score). */
export async function searchUpdate(w: WelcomeTargets): Promise<{ ok: boolean }> {
  try {
    const current = await fetch('/api/settings/targeting')
      .then((r) => (r.ok ? (r.json() as Promise<{ targeting?: Targeting }>) : null))
      .catch(() => null)
    const res = await fetch('/api/settings/targeting', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(current?.targeting ?? EMPTY_TARGETING), ...toTargeting(w) }),
    })
    return { ok: res.ok && (await setFacts(w)) }
  } catch {
    return { ok: false }
  }
}

/** onboarding.finish: stamps onboardedAt, keeping the account's current threshold. */
export async function onboardingFinish(supabase: SupabaseClient): Promise<{ ok: boolean }> {
  const prefs = await fetchClientSafePreferences(supabase)
  const threshold = typeof prefs?.matchThreshold === 'number' ? prefs.matchThreshold : 70
  const error = await markOnboarded(supabase, threshold)
  return { ok: !error }
}

export interface WelcomeRole {
  id: string
  title: string
  company: string
  companyId: string | null
  domain: string | null
  logoUrl: string | null
  location: string | null
  postedAt: string | null
}

type Rows = Array<{
  id: string
  title: string
  company_id: string | null
  location: string | null
  posted_at: string | null
  companies: { name: string | null; domain: string | null; logo_url: string | null } | null
}>

// The Jobs page types its query this way: the builder's generics are too deep
// for the compiler once the filters are chained.
type JobsQuery = ReturnType<ReturnType<SupabaseClient['from']>['select']>

/** Open roles inside the person's targets: the same two filters the Jobs list applies. */
function openInsideTargets(query: unknown, t: Targeting): JobsQuery {
  return applyRoleTargets(openRolesOnly(query as JobsQuery), t)
}

/**
 * How many open roles fit the targets right now, by the same code filter the
 * Jobs list uses. Null when it cannot be counted, and the line then hides.
 */
export async function fitCount(supabase: SupabaseClient, t: Targeting): Promise<number | null> {
  if (!hasRoleTargets(t)) return null
  try {
    const q = openInsideTargets(supabase.from('jobs').select('id', { count: 'exact', head: true }), t)
    const { count, error } = await q
    return error ? null : (count ?? 0)
  } catch {
    return null
  }
}

/** The roles that fit, newest first: code order, nothing ranked. Empty when none, null when unreadable. */
export async function rolesFind(supabase: SupabaseClient, t: Targeting, limit = 8): Promise<WelcomeRole[] | null> {
  try {
    const q = openInsideTargets(
      supabase.from('jobs').select('id, title, company_id, location, posted_at, companies(name, domain, logo_url)'),
      t,
    )
      .order('posted_at', { ascending: false, nullsFirst: false })
      .order('id', { ascending: true })
      .limit(limit)
    const { data, error } = await q
    if (error) return null
    return ((data ?? []) as unknown as Rows).map((r) => ({
      id: r.id,
      title: r.title,
      company: r.companies?.name ?? 'Employer',
      companyId: r.company_id,
      domain: r.companies?.domain ?? null,
      logoUrl: r.companies?.logo_url ?? null,
      location: r.location,
      postedAt: r.posted_at,
    }))
  } catch {
    return null
  }
}
