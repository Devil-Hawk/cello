// What the Roles page reads, as the signed-in person. person_roles is the list
// (row level security keeps it to their own rows); the posting is embedded; every
// count a header or a line shows comes from SQL (role_counts, head counts), never
// from counting the rows read here.

import type { SupabaseClient } from '@supabase/supabase-js'
import { checksStatus } from '@/lib/clock/status'
import { visaFromCuratedList } from '@/lib/dossier/visa'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { openRolesOnly } from '@/lib/jobs/freshness'
import { getRoleType, ROLE_TYPES } from '@/lib/jobs/role-types/taxonomy'
import { resolveConstraints } from '@/lib/scoring/constraints'
import { checkLine } from '@/components/today/logic'
import { FIT_COLUMNS, parseFit, readShortlist, todayUtc } from '@/lib/scoring'
import { OnJobs } from '@/lib/scoring/person-roles-query'
import type { PassReason, Reaction } from '@/lib/scoring/types'
import { POSTED_HOURS, type EmployerFacts, type RolesQuery } from '@/components/roles/logic'
import type { RolesViewProps } from '@/components/roles/roles-view'
import type { PickItem, RoleItem, RoleTypeView } from '@/components/roles/types'

type Db = SupabaseClient<any, any, any>

const JOB_COLUMNS =
  'id, title, location, salary_range, posted_at, seniority, is_remote, country, still_open, legit_label, employer_id, company_id, role_type, type_origin, type_prov, companies(name, logo_url, domain)'
export const LIST = `job_id, saved_at, hidden_reason, visible_since, via, role_type, ${FIT_COLUMNS}, jobs!inner(${JOB_COLUMNS})`

/** ponytail: ranking runs over the newest 300 rows the person's order returns; past that, "Show more" ends. SQL-side ranking when anyone keeps more than that open. */
const WINDOW = 300

interface JobRow {
  id: string
  title: string
  location: string | null
  salary_range: string | null
  posted_at: string | null
  seniority: string | null
  role_type: string | null
  type_origin: 'code' | 'model' | null
  type_prov?: unknown
  // Only the record selects these.
  description?: string | null
  description_md?: string | null
  description_state?: string | null
  description_source?: string | null
  apply_url?: string | null
  requirements?: unknown
  url?: string | null
  job_function?: string | null
  is_remote?: boolean | null
  country?: string | null
  source_tier?: string | null
  still_open: boolean | null
  legit_label: 'agency' | 'repost' | null
  employer_id: string | null
  company_id: string | null
  companies: { name: string | null; logo_url: string | null; domain: string | null } | { name: string | null; logo_url: string | null; domain: string | null }[] | null
}

export type ListRow = Record<string, unknown> & {
  job_id: string
  saved_at: string | null
  hidden_reason: 'not_for_me' | 'unclassified' | null
  /** How the role became the person's; 'link' is a pasted link. */
  via?: string | null
  /** The person's own word for the role's type (Change type). */
  role_type?: string | null
  jobs: JobRow | JobRow[] | null
}

/** The type a person sees: their own word over the posting's. A type id the taxonomy does not know shows as no type. */
export function typeView(own: string | null | undefined, posting: string | null, origin: 'code' | 'model' | null): RoleTypeView | null {
  const id = own ?? posting
  const def = id ? getRoleType(id) : undefined
  return id && def ? { id, label: def.label, own: !!own, origin: own ? null : origin } : null
}

/** The choices Change type and the Role type filter offer: every type a person can pick (not `other`), by label. */
export const TYPE_OPTIONS = ROLE_TYPES.filter((t) => t.id !== 'other').map((t) => ({ id: t.id, label: t.label }))

export function toItem(row: ListRow): RoleItem | null {
  const job = Array.isArray(row.jobs) ? row.jobs[0] : row.jobs
  if (!job) return null
  const company = Array.isArray(job.companies) ? job.companies[0] : job.companies
  const fit = parseFit({ id: job.id, ...row } as Parameters<typeof parseFit>[0])
  return {
    id: job.id,
    title: job.title,
    company: company?.name ?? 'Employer',
    companyId: job.employer_id ?? job.company_id,
    domain: company?.domain ?? null,
    logoUrl: company?.logo_url ?? null,
    location: job.location,
    postedAt: job.posted_at,
    pay: job.salary_range?.trim() || null,
    level: job.seniority,
    type: typeView(row.role_type, job.role_type, job.type_origin),
    pasted: row.via === 'link',
    legit: job.legit_label,
    chance: fit.chance?.label === 'cannot_assess' ? null : (fit.chance?.label ?? null),
    wantP: fit.want?.p ?? null,
    read: fit.want?.reason ?? null,
    savedAt: row.saved_at,
    hiddenReason: row.hidden_reason,
    closed: job.still_open === false,
    reaction: null,
  }
}

/** The employers the person follows, as the two id lists a posting's employer_id and company_id are matched against. */
interface Followed {
  employer: string[]
  company: string[]
}

/** How a role type is matched. A person's own word sits on person_roles, the posting's on jobs; the two are asked apart and joined, since one PostgREST filter cannot be "this table's column or that one's". */
type TypeMatch = 'own' | 'posting'

interface ListRows {
  data: ListRow[] | null
  count: number | null
  error: { message: string } | null
}

function filtered(db: Db, q: RolesQuery, followed: Followed | null, match: TypeMatch | null = null) {
  let query = db.from('person_roles').select(LIST, { count: 'exact' })
  if (q.tab === 'for-you') query = query.is('hidden_reason', null)
  else if (q.tab === 'saved') query = query.not('saved_at', 'is', null)
  else query = query.not('hidden_reason', 'is', null)
  if (match === 'own') query = query.eq('role_type', q.roleType)
  if (match === 'posting') query = query.is('role_type', null)

  const on = new OnJobs(query)
  if (match === 'posting') on.eq('role_type', q.roleType)
  if (q.tab === 'for-you') {
    openRolesOnly(on)
    if (q.level) on.eq('seniority', q.level)
    if (q.remote) on.eq('is_remote', true)
    if (q.country) on.eq('country', q.country)
    if (q.company) on.or(`employer_id.eq.${q.company},company_id.eq.${q.company}`)
    if (followed) {
      const parts = [followed.employer.length ? `employer_id.in.(${followed.employer.join(',')})` : null, followed.company.length ? `company_id.in.(${followed.company.join(',')})` : null]
      on.or(parts.filter(Boolean).join(','))
    }
    if (q.hideAgency) on.is('legit_label', null)
    if (q.posted !== 'any') {
      const cutoff = new Date(Date.now() - POSTED_HOURS[q.posted] * 3_600_000).toISOString()
      if (q.undated) on.or(`posted_at.gte.${cutoff},posted_at.is.null`)
      else on.gte('posted_at', cutoff)
    }
  }
  query = on.query
  if (q.tab === 'saved') return query.order('saved_at', { ascending: false })
  if (q.tab === 'hidden') return query.order('visible_since', { ascending: false })
  if (q.sort === 'newest') return query.order('jobs(posted_at)', { ascending: false, nullsFirst: false })
  return query.order('want_p', { ascending: false, nullsFirst: false }).order('jobs(posted_at)', { ascending: false, nullsFirst: false })
}

/** Both halves of a role type filter in the order the page asked for, cut to the window. The two sets cannot overlap (own is set in one, null in the other), so their counts add. */
function joinTyped(a: ListRows, b: ListRows, sort: RolesQuery['sort']): ListRows {
  const posted = (r: ListRow) => (Array.isArray(r.jobs) ? r.jobs[0] : r.jobs)?.posted_at ?? ''
  const want = (r: ListRow) => (typeof r.want_p === 'number' ? r.want_p : -1)
  const rows = [...(a.data ?? []), ...(b.data ?? [])].sort((x, y) => (sort === 'newest' ? 0 : want(y) - want(x)) || posted(y).localeCompare(posted(x)))
  return { data: rows.slice(0, WINDOW), count: (a.count ?? 0) + (b.count ?? 0), error: a.error ?? b.error }
}

/** Attaches the person's own reaction to the rows that will be drawn. */
async function withReactions(db: Db, items: RoleItem[], upTo: number): Promise<RoleItem[]> {
  const ids = items.slice(0, upTo).map((i) => i.id)
  if (ids.length === 0) return items
  const { data } = await db.from('role_reactions').select('job_id, reaction, reason').in('job_id', ids.slice(0, 100))
  const by = new Map(((data ?? []) as { job_id: string; reaction: Reaction; reason: PassReason | null }[]).map((r) => [r.job_id, r]))
  return items.map((i) => (by.has(i.id) ? { ...i, reaction: { reaction: by.get(i.id)!.reaction, reason: by.get(i.id)!.reason } } : i))
}

/** What the last read says about each employer shown: the open total, and why it cannot be read. The directory is not readable by a session, so this is the one service read, limited to employers in the person's own rows. */
async function employerFacts(ids: string[]): Promise<Record<string, EmployerFacts>> {
  if (ids.length === 0) return {}
  try {
    const { data } = await createAdminClient().from('company_directory').select('id, open_count, cannot_read_reason').in('id', ids.slice(0, 100))
    return Object.fromEntries(
      ((data ?? []) as { id: string; open_count: number | null; cannot_read_reason: string | null }[]).map((r) => [r.id, { open: r.open_count, cannotRead: r.cannot_read_reason }]),
    )
  } catch {
    return {}
  }
}

const toMap = (rows: { key: string; n: number | string }[] | null) => Object.fromEntries((rows ?? []).map((r) => [r.key, Number(r.n)]))

interface CompanyRow {
  id: string
  name: string | null
  employer_id: string | null
  watching: boolean | null
}

/** ponytail: Following only matches the first 100 followed employers by id in the address; past that, a search on the employers' ids in SQL. */
const FOLLOWED_MAX = 100

export async function readRoles(db: Db, userId: string, q: RolesQuery): Promise<Omit<RolesViewProps, 'query'>> {
  const nowMs = Date.now()
  const startOfDay = `${todayUtc()}T00:00:00Z`
  let admin: Db | null = null
  try {
    admin = createAdminClient()
  } catch {
    admin = null
  }

  // The person's own employers: the names for the Company chooser, and who they follow.
  const companyRows = ((await db.from('companies').select('id, name, employer_id, watching').limit(1000)).data ?? []) as CompanyRow[]
  const followedRows = companyRows.filter((c) => c.watching).slice(0, FOLLOWED_MAX)
  const followed: Followed | null = q.following ? { employer: followedRows.filter((c) => c.employer_id).map((c) => c.employer_id!), company: followedRows.filter((c) => !c.employer_id).map((c) => c.id) } : null
  const nobodyFollowed = followed !== null && followed.employer.length + followed.company.length === 0

  const typed = q.tab === 'for-you' && q.roleType !== null
  const [list, employerCounts, typeCounts, outsideCounts, today, untyped, profile, checks] = await Promise.all([
    nobodyFollowed
      ? Promise.resolve({ data: [], count: 0, error: null } as ListRows)
      : typed
        ? Promise.all([filtered(db, q, followed, 'own').limit(WINDOW), filtered(db, q, followed, 'posting').limit(WINDOW)]).then(([a, b]) => joinTyped(a as unknown as ListRows, b as unknown as ListRows, q.sort))
        : (filtered(db, q, followed).limit(WINDOW) as unknown as Promise<ListRows>),
    db.rpc('role_counts', { p_by: 'employer' }),
    db.rpc('role_counts', { p_by: 'role_type' }),
    db.rpc('role_counts', { p_by: 'outside_week' }),
    db.from('person_roles').select('job_id', { count: 'exact', head: true }).is('hidden_reason', null).gte('visible_since', startOfDay),
    q.tab === 'hidden' ? db.from('person_roles').select('job_id', { count: 'exact', head: true }).eq('hidden_reason', 'unclassified') : Promise.resolve({ count: 0 }),
    db.from('profiles').select('preferences').eq('id', userId).maybeSingle(),
    checksStatus(db, admin, new Date(nowMs)).catch(() => null),
  ])
  const base = { typeOptions: TYPE_OPTIONS, needsSponsorship: false, companyOptions: [] as { id: string; label: string }[], untypedTotal: 0, checkLine: checks ? checkLine(checks, nowMs) : null }
  if (list.error) {
    console.error('[roles] list failed:', list.error.message)
    return { ...base, items: [], picks: [], total: 0, newToday: 0, groupCounts: {}, typeCounts: {}, facts: {}, outside: {}, failed: true }
  }

  let items = (list.data ?? []).map(toItem).filter((i): i is RoleItem => i !== null)
  let total = list.count ?? items.length
  // ponytail: Past H-1B filings is the curated list matched by employer name in code, over the window the page reads; the total is then what the window holds. A table of sponsor names in SQL when the list grows.
  if (q.h1b) {
    items = items.filter((i) => visaFromCuratedList(i.company) === 'likely')
    total = items.length
  }
  items = await withReactions(db, items, q.limit + 6)

  let picks: PickItem[] = []
  if (q.tab === 'for-you') {
    try {
      const view = await readShortlist(db as never, userId, todayUtc())
      if (view.status === 'ready') {
        const byId = new Map(items.map((i) => [i.id, i]))
        picks = view.picks.flatMap((p) => {
          const item = p.job ? byId.get(p.job.id) : undefined
          return item ? [{ ...item, explanation: p.explanation, kind: p.kind }] : []
        })
      }
    } catch {
      /* picks are off or unreadable: the band falls back to the newest kept roles */
    }
  }

  const employerIds = Array.from(new Set(items.map((i) => i.companyId).filter((x): x is string => !!x)))
  const withCount = toMap(employerCounts.data as { key: string; n: number }[] | null)
  const names = new Map<string, string>()
  for (const c of companyRows) if (c.name) names.set(c.employer_id ?? c.id, c.name)
  const prefs = (profile.data as { preferences?: unknown } | null)?.preferences ?? null
  return {
    ...base,
    needsSponsorship: resolveConstraints(prefs).needsSponsorship,
    companyOptions: Object.keys(withCount)
      .flatMap((id) => (names.has(id) ? [{ id, label: names.get(id)! }] : []))
      .sort((a, b) => a.label.localeCompare(b.label))
      .slice(0, 300),
    untypedTotal: (untyped as { count: number | null }).count ?? 0,
    items,
    picks,
    total,
    newToday: today.count ?? 0,
    groupCounts: withCount,
    typeCounts: toMap(typeCounts.data as { key: string; n: number }[] | null),
    facts: q.group === 'company' ? await employerFacts(employerIds) : {},
    outside: toMap(outsideCounts.data as { key: string; n: number }[] | null),
  }
}
