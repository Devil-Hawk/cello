// What the Companies pages read: the wall, one employer, and a search inside one employer's roles.
//
// Every number names its column. Nothing here calls a model or writes a row. The SQL does the joining
// (companies_page, company_page, company_roles in 20261021000100_companies_contract.sql); this file turns its rows
// into the contract and adds the header, which comes from the clock's own heartbeat and the directory.
//
// Where Cello does not know, the field is null with a reason, never 0:
//   openCount     company_directory.open_count, null before the first read and whenever cannot_read_reason is set
//   checked       the last read, from company_directory.last_read_at and failed_reads / cannot_read_reason:
//                   null          no read yet ("Not read yet")
//                   ok: true      the last read answered
//                   ok: false     the last read did not: reason is cannot_read_reason, or 'cannot_read' while a board that
//                                 did not answer is still being retried (recordRead keeps the reason only when the board leaves)
//   closed        the board left the rotation for good: cannot_read_reason is set and is not 'cannot_read'
//                 (gone, no longer proven, or no posting in 120 days; see the migration). A board that did not answer
//                 three times is "Cannot read", not closed.
//   keptForYou, topForYou, the "for you" insights, the shared insights
//                 null until Roles writes person_roles and PR 5 writes employer_insights

import type { SupabaseClient } from '@supabase/supabase-js'
import { meterState } from '../clock/meter'
import { routineStatus, type RoutineStatus } from '../clock/status'
import { directoryProgress } from './directory'
import { REASON_COPY } from './roles-status'

type Db = SupabaseClient<any, any, any>

export const PAGE_SIZE = 50
const WEEK_MS = 7 * 86_400_000

export interface Checked {
  at: string
  ok: boolean
  /** The class the directory holds: cannot_read, no_board, stale, other_owner, not_linked, not_employer_site. */
  reason?: string
  /** The company page's plain words for a board that did not answer. */
  line?: string
}

export interface CompaniesHeader {
  /** Employers first proven in the last 7 days whose source is not the person (company_directory.created_at, source). */
  foundByCelloThisWeek: number
  /** The person's followed employers (companies.watching with an employer_id). */
  following: number
  /** The sweep's own heartbeat: last success, next due, "Missed at 12:00. Cello is retrying.". */
  checked: RoutineStatus
  /** "Background work is off on this server." (background_ready). */
  backgroundOff: boolean
  /** "Cello is pacing its checks to stay within the free allowance." (clock_meter). */
  paced: boolean
  /** "Cello has checked 1,200 employers so far." (directory_progress). */
  seedProgress: { verified: number; pending: number; failed: number }
}

export interface CompanyRow {
  employerId: string
  name: string
  domain: string | null
  logoUrl: string | null
  hq: string | null
  foundBy: 'cello' | 'person'
  openCount: number | null
  openCountAt: string | null
  checked: Checked | null
  nextReadAt: string | null
  closed: boolean
  keptForYou: number | null
  topForYou: { title: string; chance: string }[] | null
  following: boolean
  isDream: boolean
  roleTypes: string[]
}

export interface CompaniesPage {
  /** Global facts: they do not follow the filters. */
  header: CompaniesHeader
  rows: CompanyRow[]
  /** Employers behind the current filters in all, whatever the page size ("12 employers match"); null past the last page, where no row says. */
  matched: number | null
  limit: number
  offset: number
}

export interface CompaniesPageOpts {
  type?: string
  /** Disabled in the UI until Roles writes person_roles; the SQL already honours it. */
  withRolesForYou?: boolean
  showClosed?: boolean
  limit?: number
  offset?: number
  now?: Date
}

export interface KeptRole {
  id: string
  title: string
  roleType: string | null
  location: string | null
  url: string
  postedAt: string | null
  chance: string | null
}

export interface CompanyPage extends Omit<CompanyRow, 'keptForYou' | 'topForYou' | 'roleTypes'> {
  careersUrl: string | null
  provider: string | null
  profile: Record<string, unknown> | null
  /** Every listing the last read saw, by role type (null = not typed yet): employer_stats.open_count. */
  byType: { roleType: string | null; open: number }[]
  /** The open roles this person holds here (person_roles x jobs); the most recent 100. */
  kept: KeptRole[]
  insights: {
    shared: null
    forYou: { topForYou: null; yourTypesCount: null; asks: null }
  }
}

export interface RoleHit {
  id: string
  title: string
  roleType: string | null
  location: string | null
  url: string
  postedAt: string | null
  kept: boolean
  chance: string | null
}

interface Head {
  employer_id: string
  name: string
  domain: string | null
  logo_url: string | null
  hq: string | null
  source: string
  open_count: number | null
  open_count_at: string | null
  last_read_at: string | null
  next_read_at: string | null
  failed_reads: number | null
  cannot_read_reason: string | null
  closed: boolean
  following: boolean
  is_dream: boolean
}

function checkedOf(r: Pick<Head, 'last_read_at' | 'failed_reads' | 'cannot_read_reason'>): Checked | null {
  if (!r.last_read_at) return null
  const reason = r.cannot_read_reason ?? ((r.failed_reads ?? 0) > 0 ? 'cannot_read' : undefined)
  return { at: r.last_read_at, ok: reason === undefined, ...(reason ? { reason } : {}) }
}

function headOf(r: Head): Omit<CompanyRow, 'keptForYou' | 'topForYou' | 'roleTypes'> {
  const known = r.open_count !== null && r.cannot_read_reason === null
  return {
    employerId: r.employer_id,
    name: r.name,
    domain: r.domain,
    logoUrl: r.logo_url,
    hq: r.hq,
    foundBy: r.source === 'person' ? 'person' : 'cello',
    openCount: known ? r.open_count : null,
    openCountAt: known ? r.open_count_at : null,
    checked: checkedOf(r),
    nextReadAt: r.next_read_at,
    closed: r.closed,
    following: r.following,
    isDream: r.is_dream,
  }
}

async function header(db: Db, userId: string, now: Date): Promise<CompaniesHeader> {
  const [found, following, routine, heartbeat, ready, meter, seedProgress] = await Promise.all([
    db.from('company_directory').select('id', { count: 'exact', head: true }).not('verified_at', 'is', null).neq('source', 'person').gte('created_at', new Date(now.getTime() - WEEK_MS).toISOString()),
    db.from('companies').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('watching', true).not('employer_id', 'is', null),
    db.from('routines').select('command, next_due_at, enabled').eq('command', 'directory.sweep').is('user_id', null).maybeSingle(),
    db.from('job_heartbeats').select('job, succeeded_at, next_due_at, found, failure').eq('job', 'directory.sweep').is('user_id', null).maybeSingle(),
    db.rpc('background_ready'),
    meterState(db, now).catch(() => null),
    directoryProgress(db),
  ])
  const backgroundOff = ready.data !== true
  const checked = routineStatus('directory.sweep', routine.data ?? undefined, heartbeat.data ?? undefined, now)
  return {
    foundByCelloThisWeek: found.count ?? 0,
    following: following.count ?? 0,
    // with background work off Cello is not retrying, so "Cello is retrying" would be false
    checked: backgroundOff ? { ...checked, missedText: null } : checked,
    backgroundOff,
    paced: meter?.paused === true,
    seedProgress,
  }
}

export async function companiesPage(db: Db, userId: string, opts: CompaniesPageOpts = {}): Promise<CompaniesPage> {
  const now = opts.now ?? new Date()
  const limit = opts.limit ?? PAGE_SIZE
  const offset = opts.offset ?? 0
  const [h, list] = await Promise.all([
    header(db, userId, now),
    db.rpc('companies_page', { p_user: userId, p_type: opts.type ?? null, p_with_roles: opts.withRolesForYou ?? false, p_show_closed: opts.showClosed ?? false, p_limit: limit, p_offset: offset }),
  ])
  if (list.error) throw new Error('could not read the companies')
  const found = (list.data ?? []) as (Head & { role_types: string[] | null; matched: number })[]
  const rows = found.map((r) => ({ ...headOf(r), keptForYou: null, topForYou: null, roleTypes: r.role_types ?? [] }))
  return { header: h, rows, matched: found[0]?.matched ?? (offset === 0 ? 0 : null), limit, offset }
}

/**
 * The directory id for an id from either door: an employer's own, or the id of the person's follow row, which the
 * dashboard and the role sheet still link with. ponytail: one extra read; drop it when those links carry the employer id.
 */
async function employerOf(db: Db, userId: string, id: string): Promise<string> {
  const { data } = await db.from('companies').select('employer_id').eq('id', id).eq('user_id', userId).maybeSingle()
  return (data as { employer_id: string | null } | null)?.employer_id ?? id
}

export async function companyPage(db: Db, userId: string, id: string): Promise<CompanyPage | null> {
  const { data, error } = await db.rpc('company_page', { p_user: userId, p_employer: await employerOf(db, userId, id) })
  if (error) throw new Error('could not read the company')
  const r = (Array.isArray(data) ? data[0] : data) as
    | (Head & {
        careers_url: string | null
        ats_provider: string | null
        profile: Record<string, unknown> | null
        by_type: { role_type: string | null; open: number }[]
        kept: { id: string; title: string; role_type: string | null; location: string | null; url: string; posted_at: string | null; chance: string | null }[]
      })
    | undefined
  if (!r) return null
  const base = headOf(r)
  return {
    ...base,
    // a board that did not answer says why in plain words, and never "0 open"
    checked: base.checked && base.checked.reason === 'cannot_read' ? { ...base.checked, line: REASON_COPY.board_unreachable } : base.checked,
    careersUrl: r.careers_url,
    provider: r.ats_provider,
    profile: r.profile,
    byType: (r.by_type ?? []).map((t) => ({ roleType: t.role_type, open: t.open })),
    kept: (r.kept ?? []).map((k) => ({ id: k.id, title: k.title, roleType: k.role_type, location: k.location, url: k.url, postedAt: k.posted_at, chance: k.chance })),
    insights: { shared: null, forYou: { topForYou: null, yourTypesCount: null, asks: null } },
  }
}

/** Search inside one employer's stored open roles: title, role type or description holds `q` (all of them when `q` is empty). */
export async function companyRoles(db: Db, userId: string, id: string, q: string): Promise<RoleHit[]> {
  const { data, error } = await db.rpc('company_roles', { p_user: userId, p_employer: await employerOf(db, userId, id), p_q: q.trim() })
  if (error) throw new Error('could not read the roles')
  return ((data ?? []) as { id: string; title: string; role_type: string | null; location: string | null; url: string; posted_at: string | null; kept: boolean; chance: string | null }[]).map((r) => ({
    id: r.id,
    title: r.title,
    roleType: r.role_type,
    location: r.location,
    url: r.url,
    postedAt: r.posted_at,
    kept: r.kept,
    chance: r.chance,
  }))
}
