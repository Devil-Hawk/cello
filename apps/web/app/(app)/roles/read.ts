// What the Roles page reads, as the signed-in person. person_roles is the list
// (row level security keeps it to their own rows); the posting is embedded; every
// count a header or a line shows comes from SQL (role_counts, head counts), never
// from counting the rows read here.

import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { openRolesOnly } from '@/lib/jobs/freshness'
import { FIT_COLUMNS, parseFit, readShortlist, todayUtc } from '@/lib/scoring'
import { OnJobs } from '@/lib/scoring/person-roles-query'
import type { PassReason, Reaction } from '@/lib/scoring/types'
import { POSTED_HOURS, type EmployerFacts, type RolesQuery } from '@/components/roles/logic'
import type { RolesViewProps } from '@/components/roles/roles-view'
import type { PickItem, RoleItem } from '@/components/roles/types'

type Db = SupabaseClient<any, any, any>

const JOB_COLUMNS =
  'id, title, location, salary_range, posted_at, seniority, is_remote, country, still_open, legit_label, employer_id, company_id, companies(name, logo_url, domain)'
export const LIST = `job_id, saved_at, hidden_reason, visible_since, ${FIT_COLUMNS}, jobs!inner(${JOB_COLUMNS})`

/** ponytail: ranking runs over the newest 300 rows the person's order returns; past that, "Show more" ends. SQL-side ranking when anyone keeps more than that open. */
const WINDOW = 300

interface JobRow {
  id: string
  title: string
  location: string | null
  salary_range: string | null
  posted_at: string | null
  seniority: string | null
  // Only the record selects these.
  description?: string | null
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
  jobs: JobRow | JobRow[] | null
}

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

function filtered(db: Db, q: RolesQuery) {
  let query = db.from('person_roles').select(LIST, { count: 'exact' })
  if (q.tab === 'for-you') query = query.is('hidden_reason', null)
  else if (q.tab === 'saved') query = query.not('saved_at', 'is', null)
  else query = query.not('hidden_reason', 'is', null)

  const on = new OnJobs(query)
  if (q.tab === 'for-you') {
    openRolesOnly(on)
    if (q.level) on.eq('seniority', q.level)
    if (q.remote) on.eq('is_remote', true)
    if (q.country) on.eq('country', q.country)
    if (q.company) on.or(`employer_id.eq.${q.company},company_id.eq.${q.company}`)
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

export async function readRoles(db: Db, userId: string, q: RolesQuery): Promise<Omit<RolesViewProps, 'query'>> {
  const startOfDay = `${todayUtc()}T00:00:00Z`
  const [list, employerCounts, outsideCounts, today] = await Promise.all([
    filtered(db, q).limit(WINDOW),
    db.rpc('role_counts', { p_by: 'employer' }),
    db.rpc('role_counts', { p_by: 'outside_week' }),
    db.from('person_roles').select('job_id', { count: 'exact', head: true }).is('hidden_reason', null).gte('visible_since', startOfDay),
  ])
  if (list.error) {
    console.error('[roles] list failed:', list.error.message)
    return { items: [], picks: [], total: 0, newToday: 0, groupCounts: {}, facts: {}, outside: {}, failed: true }
  }

  let items = ((list.data ?? []) as unknown as ListRow[]).map(toItem).filter((i): i is RoleItem => i !== null)
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
  return {
    items,
    picks,
    total: list.count ?? items.length,
    newToday: today.count ?? 0,
    groupCounts: toMap(employerCounts.data as { key: string; n: number }[] | null),
    facts: q.group === 'company' ? await employerFacts(employerIds) : {},
    outside: toMap(outsideCounts.data as { key: string; n: number }[] | null),
  }
}
