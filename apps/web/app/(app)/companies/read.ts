// What the Companies page reads, as the signed-in person. One SQL function (companies_page) is every tab: it runs
// as the caller, joins the person's own kept roles and rows to the verified directory, and hands back 51 rows so the
// page knows whether a next page exists. The numbers on the tab labels come from SQL too (companies_tab_counts, and
// the verified total the directory sweep stores on its heartbeat); nothing here counts rows and calls that a total.

import type { SupabaseClient } from '@supabase/supabase-js'
import { checksStatus } from '@/lib/clock/status'
import { searchCompanies } from '@/lib/companies/directory'
import { readSuggestions } from '@/lib/companies/suggestions-store'
import type { Suggestion } from '@/lib/companies/types'
import { visaFromCuratedList } from '@/lib/dossier/visa'
import sponsorData from '@/lib/dossier/h1b-sponsors.json'
import { normalizeCompanyName } from '@/lib/entities/companies'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { openRolesOnly } from '@/lib/jobs/freshness'
import { getRoleType } from '@/lib/jobs/role-types/taxonomy'
import { resolveConstraints } from '@/lib/scoring/constraints'
import { OnJobs } from '@/lib/scoring/person-roles-query'
import { resolveTargeting } from '@/lib/targeting'
import { PAGE_SIZE, type CheckFacts, type CompaniesQuery, type CompanyItem, type Cursor, type Details, type Found } from '@/components/companies/logic'
import { typeOptionsFor } from '../roles/read'

type Db = SupabaseClient<any, any, any>

export interface CompaniesData {
  items: CompanyItem[]
  /** The cursor of the next page, or null on the last. */
  next: Cursor | null
  counts: { hiring: number; following: number; pinned: number; all: number | null }
  /** The directory sweep's own numbers, while any candidate is still waiting. */
  loading: { verified: number | null; pending: number | null }
  check: CheckFacts | null
  needsSponsorship: boolean
  /** The person has chosen role types. */
  hasTypes: boolean
  typeOptions: { id: string; label: string }[]
  /** Five employers Cello suggests, on Following. */
  suggestions: Suggestion[]
  /** The open row's roles for the person. */
  details: Details | null
  failed: boolean
}

interface PageRow {
  id: string
  company_id: string | null
  name: string
  domain: string | null
  logo_url: string | null
  careers_url: string | null
  open_count: number | null
  last_read_at: string | null
  cannot_read_reason: string | null
  following: boolean
  pinned: boolean
  for_you: number | null
  by_type: Record<string, number> | null
  k: Cursor
}

/** The curated filers as the key the directory stores for a name (company_name_norm). */
const FILER_NAMES = (sponsorData.sponsors as string[]).map((s) => normalizeCompanyName(s))

const labelOf = (id: string) => getRoleType(id)?.label ?? null

export function toItem(r: PageRow, needsSponsorship: boolean): CompanyItem {
  const by = Object.entries(r.by_type ?? {})
    .flatMap(([id, n]) => {
      const label = labelOf(id)
      return label ? [{ label, n: Number(n) }] : []
    })
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
  return {
    id: r.id,
    companyId: r.company_id,
    name: r.name,
    domain: r.domain,
    logoUrl: r.logo_url,
    careersUrl: r.careers_url,
    open: r.open_count,
    lastReadAt: r.last_read_at,
    cannotRead: r.cannot_read_reason,
    following: r.following,
    pinned: r.pinned,
    forYou: r.cannot_read_reason ? null : r.for_you,
    by,
    filings: needsSponsorship && visaFromCuratedList(r.name) === 'likely',
    key: r.k,
  }
}

/** The roles for the person at one employer, up to five, newest first. */
async function readDetails(db: Db, id: string, total: number): Promise<Details> {
  const on = new OnJobs(db.from('person_roles').select('job_id, role_type, jobs!inner(id, title, posted_at, role_type, employer_id, company_id)').is('hidden_reason', null))
  openRolesOnly(on)
  on.or(`employer_id.eq.${id},company_id.eq.${id}`)
  const { data } = await on.query.order('jobs(posted_at)', { ascending: false, nullsFirst: false }).limit(5)
  type Row = { role_type: string | null; jobs: { id: string; title: string; posted_at: string | null; role_type: string | null } | { id: string; title: string; posted_at: string | null; role_type: string | null }[] | null }
  const roles = ((data ?? []) as unknown as Row[]).flatMap((r) => {
    const j = Array.isArray(r.jobs) ? r.jobs[0] : r.jobs
    if (!j) return []
    const type = r.role_type ?? j.role_type
    return [{ id: j.id, title: j.title, type: type ? labelOf(type) : null, postedAt: j.posted_at }]
  })
  return { roles, total }
}

export async function readCompanies(db: Db, userId: string, q: CompaniesQuery): Promise<CompaniesData> {
  const nowMs = Date.now()
  let admin: Db | null = null
  try {
    admin = createAdminClient()
  } catch {
    admin = null
  }
  const { data: profile } = await db.from('profiles').select('preferences, resume_text').eq('id', userId).maybeSingle()
  const prefs = (profile as { preferences?: unknown } | null)?.preferences ?? null
  const needsSponsorship = resolveConstraints(prefs).needsSponsorship
  const hasTypes = (resolveTargeting(prefs).role_types ?? []).length > 0

  const [page, counts, sweep, checks] = await Promise.all([
    db.rpc('companies_page', {
      p_tab: q.tab,
      p_after: q.after,
      p_limit: PAGE_SIZE + 1,
      p_role_type: q.type,
      p_cannot_read: q.cannot,
      p_pinned: q.pinned,
      // ponytail: the filings filter sends the curated names; the row's own line is the same list matched in code (visaFromCuratedList), which also folds a few more suffixes.
      p_names: needsSponsorship && q.h1b ? FILER_NAMES : null,
    }),
    db.rpc('companies_tab_counts'),
    db.from('job_heartbeats').select('found').eq('job', 'directory.sweep').is('user_id', null).maybeSingle(),
    checksStatus(db, admin, new Date(nowMs)).catch(() => null),
  ])
  const found = ((sweep.data as { found?: Record<string, unknown> } | null)?.found ?? {}) as { verified_total?: number; pending_total?: number }
  const c = ((Array.isArray(counts.data) ? counts.data[0] : counts.data) ?? {}) as { hiring?: number | string; following?: number | string; pinned?: number | string }
  const base: Omit<CompaniesData, 'items' | 'next' | 'details' | 'suggestions' | 'failed'> = {
    counts: { hiring: Number(c.hiring ?? 0), following: Number(c.following ?? 0), pinned: Number(c.pinned ?? 0), all: typeof found.verified_total === 'number' ? found.verified_total : null },
    loading: { verified: typeof found.verified_total === 'number' ? found.verified_total : null, pending: typeof found.pending_total === 'number' ? found.pending_total : null },
    check: checks?.rolesCheck ? { lastAt: checks.rolesCheck.lastSucceededAt, nextAt: checks.rolesCheck.nextDueAt, missed: checks.rolesCheck.missed ? checks.rolesCheck.missedText : null } : null,
    needsSponsorship,
    hasTypes,
    typeOptions: typeOptionsFor(prefs),
  }
  if (page.error) {
    console.error('[companies] page failed:', page.error.message)
    return { ...base, items: [], next: null, suggestions: [], details: null, failed: true }
  }

  const rows = (page.data ?? []) as PageRow[]
  const shown = rows.slice(0, PAGE_SIZE)
  const items = shown.map((r) => toItem(r, needsSponsorship))
  const next = rows.length > PAGE_SIZE ? shown[shown.length - 1].k : null

  let suggestions: Suggestion[] = []
  if (q.tab === 'following') {
    try {
      const s = await readSuggestions(db as never, userId, { resume_text: (profile as { resume_text?: string | null } | null)?.resume_text ?? null, preferences: prefs })
      suggestions = s.status === 'ready' ? s.suggestions.slice(0, 5) : []
    } catch {
      suggestions = []
    }
  }
  const open = q.focus ? items.find((i) => i.id === q.focus) : undefined
  const details = open ? await readDetails(db, open.id, open.forYou ?? 0).catch(() => null) : null
  return { ...base, items, next, suggestions, details, failed: false }
}

/** Add or find's type-ahead: every verified employer Cello knows, then candidates it has not checked yet. A hit carries the person's own count and whether they follow it; a candidate never carries either. */
export async function findCompanies(db: Db, userId: string, query: string): Promise<Found> {
  const hits = await searchCompanies(createAdminClient(), query, { limit: 8 })
  const ids = hits.employers.map((e) => e.id).slice(0, 8)
  const [counts, mine, profile] = ids.length
    ? await Promise.all([
        db.rpc('role_counts', { p_by: 'employer' }),
        db.from('companies').select('id, employer_id, watching, is_dream_company').eq('user_id', userId).in('employer_id', ids.slice(0, 8)),
        db.from('profiles').select('preferences').eq('id', userId).maybeSingle(),
      ])
    : [null, null, null]
  const forYou = new Map(((counts?.data ?? []) as { key: string; n: number | string }[]).map((r) => [r.key, Number(r.n)]))
  const own = new Map(((mine?.data ?? []) as { id: string; employer_id: string; watching: boolean; is_dream_company: boolean }[]).map((r) => [r.employer_id, r]))
  const needsSponsorship = resolveConstraints((profile?.data as { preferences?: unknown } | null)?.preferences ?? null).needsSponsorship
  return {
    employers: hits.employers.map((e) => {
      const o = own.get(e.id)
      return {
        id: e.id,
        companyId: o?.id ?? null,
        name: e.name,
        domain: e.domain,
        logoUrl: e.logo_url,
        careersUrl: e.careers_url,
        open: e.open_count,
        lastReadAt: e.last_read_at,
        cannotRead: e.cannot_read_reason,
        following: o?.watching === true,
        pinned: o?.watching === true && o.is_dream_company === true,
        forYou: e.cannot_read_reason ? null : (forYou.get(e.id) ?? 0),
        by: [],
        filings: needsSponsorship && visaFromCuratedList(e.name) === 'likely',
        key: [],
      }
    }),
    notChecked: hits.notChecked,
  }
}
