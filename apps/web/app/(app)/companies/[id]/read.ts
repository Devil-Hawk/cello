// What the Company page reads, as the signed-in person. A directory id opens whether or not the person has a
// companies row; a person's own id redirects to the directory when it has an employer and opens the "known only from
// email" state when it has none. The first screen reads stored rows only. The whole list of open roles is a live
// read of the employer's board (liveRoles): nothing from it is stored, and browsing writes no row anywhere. The
// preview of one posting is the same: it reads the posting live and stores nothing until the person acts.

import type { SupabaseClient } from '@supabase/supabase-js'
import { checksStatus } from '@/lib/clock/status'
import { rpcSlotStore } from '@/lib/commands/slots'
import { getEmployer, type DirectoryRow } from '@/lib/companies/directory'
import { liveRoles, reasonText, type LiveCompany, type LiveRoles } from '@/lib/companies/live-roles'
import { previewPosting, type PostingPreview } from '@/lib/companies/preview'
import { visaFromCuratedList } from '@/lib/dossier/visa'
import { codeVerdicts } from '@/lib/fit/code'
import { loadMaterial } from '@/lib/fit/material'
import { requirementKey, stripOf } from '@/lib/fit'
import type { FitRequirement, RoleFitView } from '@/lib/fit/types'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { PROVIDER_SUBMIT_FACTS } from '@/lib/ats-apply/capability'
import { loadTargets } from '@/lib/ingest/reader/targets'
import { openRolesOnly } from '@/lib/jobs/freshness'
import { getRoleType } from '@/lib/jobs/role-types/taxonomy'
import { companyHref } from '@/lib/routes/companies'
import { resolveConstraints } from '@/lib/scoring/constraints'
import { OnJobs } from '@/lib/scoring/person-roles-query'
import { fromReaderRequirements } from '@/lib/scoring/posting-requirements'
import { resolveTargeting } from '@/lib/targeting'
import type { CheckFacts } from '@/components/companies/logic'
import type { Fact, FieldFacts, HistoryItem } from '@/components/companies/company-logic'
import { LIVE_PAGE, type CompanyQuery } from '@/components/companies/company-logic'
import type { RoleItem } from '@/components/roles/types'
import { LIST, toItem, typeOptionsFor, type ListRow } from '../../roles/read'

type Db = SupabaseClient<any, any, any>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const OWN_COLUMNS = 'id, name, domain, logo_url, career_url, employer_id, watching, is_dream_company, notes, metadata, created_at'

export interface OwnRow {
  id: string
  name: string
  domain: string | null
  logo_url: string | null
  career_url: string | null
  employer_id: string | null
  watching: boolean
  is_dream_company: boolean
  notes: string | null
  metadata: unknown
  created_at: string
}

export type Resolved =
  | { kind: 'directory'; employer: DirectoryRow; own: OwnRow | null }
  | { kind: 'redirect'; to: string }
  | { kind: 'email'; own: OwnRow }
  | { kind: 'missing' }

function adminOrNull(): Db | null {
  try {
    return createAdminClient()
  } catch {
    return null
  }
}

/** The person's own row for an employer: the followed one first. */
export async function ownFor(db: Db, userId: string, employerId: string): Promise<OwnRow | null> {
  const { data } = await db.from('companies').select(OWN_COLUMNS).eq('user_id', userId).eq('employer_id', employerId).order('watching', { ascending: false }).limit(1).maybeSingle()
  return (data as OwnRow | null) ?? null
}

/** 4.7's rule: a directory id is looked up first; a person's own id whose row has an employer redirects to it; one without opens by itself. */
export async function resolveCompany(db: Db, admin: Db, userId: string, id: string): Promise<Resolved> {
  if (!UUID.test(id)) return { kind: 'missing' }
  const employer = await getEmployer(admin, id)
  if (employer) return { kind: 'directory', employer, own: await ownFor(db, userId, id) }
  const { data } = await db.from('companies').select(OWN_COLUMNS).eq('id', id).eq('user_id', userId).maybeSingle()
  const own = data as OwnRow | null
  if (!own) return { kind: 'missing' }
  if (own.employer_id && (await getEmployer(admin, own.employer_id))) return { kind: 'redirect', to: companyHref(own.employer_id) }
  return { kind: 'email', own }
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export interface CompanyData {
  /** The address of this page. */
  id: string
  state: 'directory' | 'email'
  employerId: string | null
  name: string
  domain: string | null
  logoUrl: string | null
  careersUrl: string | null
  /** The person's own companies row, when they have one. */
  companyId: string | null
  following: boolean
  pinned: boolean
  open: number | null
  /** Roles kept for the person here, from SQL. */
  forYou: number
  cannotRead: string | null
  /** How the site is read: a board, its own site, or only in the background (rendered). */
  tier: string | null
  lastReadAt: string | null
  check: CheckFacts | null
  /** The top five roles kept for the person. */
  kept: RoleItem[]
  field: FieldFacts | null
  facts: Fact[]
  history: HistoryItem[]
  notes: string | null
  /** "You applied here in March": the date of the first application with the employer, for the email state. */
  appliedAt: string | null
  remove: { applications: number; conversations: number; people: number; notes: boolean } | null
  needsSponsorship: boolean
  typeOptions: { id: string; label: string }[]
}

const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const labelOf = (id: string) => getRoleType(id)?.label ?? null
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

interface StatRow {
  role_type: string | null
  open_count: number
  opened_30d: number
  opened_90d: number
  closed_count: number
  median_lifetime_days: number | string | null
  stated_pay: { stated?: number } | null
  read_at: string | null
}

/** Hiring in the person's field, from the employer's own counters: code only, each number with what it counts. */
export function fieldFrom(stats: StatRow[], types: readonly string[], fill: string | null): FieldFacts | null {
  const mine = stats.filter((s) => s.role_type !== null && types.includes(s.role_type))
  const open = new Map<string, number>()
  const closed = new Map<string, { n: number; best: number; days: number | null }>()
  for (const s of mine) {
    const t = s.role_type as string
    open.set(t, (open.get(t) ?? 0) + s.open_count)
    const c = closed.get(t) ?? { n: 0, best: -1, days: null }
    c.n += s.closed_count
    // ponytail: the median of the level with the most closed roles stands for the type; the true median of all its levels needs the lifetimes themselves.
    if (s.closed_count > c.best && s.median_lifetime_days !== null) {
      c.best = s.closed_count
      c.days = Math.round(Number(s.median_lifetime_days))
    }
    closed.set(t, c)
  }
  const out: FieldFacts = {
    n90: mine.reduce((n, s) => n + s.opened_90d, 0),
    n30: mine.reduce((n, s) => n + s.opened_30d, 0),
    byType: [...open.entries()]
      .flatMap(([id, n]) => (n > 0 && labelOf(id) ? [{ id, label: labelOf(id)!, n }] : []))
      .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label)),
    // A rate from fewer than five closed roles is never shown.
    medians: [...closed.entries()].flatMap(([id, c]) => (c.n >= 5 && c.days !== null && labelOf(id) ? [{ label: labelOf(id)!, days: c.days }] : [])),
    pay: stats.reduce((n, s) => n + (s.stated_pay?.stated ?? 0), 0),
    fill,
  }
  return out.n90 > 0 || out.byType.length > 0 || out.medians.length > 0 || out.pay > 0 || out.fill ? out : null
}

/** The roles kept for the person at one employer, newest first or by want. Words, when given, narrow by title. */
export async function keptRoles(db: Db, employerId: string | null, ownId: string | null, opts: { limit: number; words?: string | null }): Promise<RoleItem[]> {
  const ids = [employerId ? `employer_id.eq.${employerId}` : null, ownId ? `company_id.eq.${ownId}` : null].filter((x): x is string => x !== null)
  if (ids.length === 0) return []
  const on = new OnJobs(db.from('person_roles').select(LIST).is('hidden_reason', null))
  openRolesOnly(on)
  on.or(ids.join(','))
  for (const w of (opts.words ?? '').split(/\s+/).map((x) => x.replace(/[%_,()*]/g, '')).filter(Boolean).slice(0, 6)) on.ilike('title', `%${w}%`)
  const { data } = await on.query.order('want_p', { ascending: false, nullsFirst: false }).order('jobs(posted_at)', { ascending: false, nullsFirst: false }).limit(opts.limit)
  return ((data ?? []) as unknown as ListRow[]).map(toItem).filter((i): i is RoleItem => i !== null)
}

export async function readCompany(db: Db, userId: string, r: Extract<Resolved, { kind: 'directory' | 'email' }>): Promise<CompanyData> {
  const nowMs = Date.now()
  const admin = adminOrNull()
  const employer = r.kind === 'directory' ? r.employer : null
  const own = r.own
  const employerId = employer?.id ?? null
  const [profile, counts, checks, stats, kept] = await Promise.all([
    db.from('profiles').select('preferences').eq('id', userId).maybeSingle(),
    db.rpc('role_counts', { p_by: 'employer' }),
    checksStatus(db, admin, new Date(nowMs)).catch(() => null),
    employerId && admin ? admin.from('employer_stats').select('role_type, open_count, opened_30d, opened_90d, closed_count, median_lifetime_days, stated_pay, read_at').eq('employer_id', employerId).limit(500) : Promise.resolve({ data: [] }),
    keptRoles(db, employerId, own?.id ?? null, { limit: 5 }),
  ])
  const prefs = (profile.data as { preferences?: unknown } | null)?.preferences ?? null
  const targeting = resolveTargeting(prefs)
  const needsSponsorship = resolveConstraints(prefs).needsSponsorship
  const byKey = new Map(((counts.data ?? []) as { key: string; n: number | string }[]).map((c) => [c.key, Number(c.n)]))
  const forYou = (employerId ? (byKey.get(employerId) ?? 0) : 0) + (own && own.id !== employerId ? (byKey.get(own.id) ?? 0) : 0)
  const name = employer?.name ?? own?.name ?? 'Company'

  const provider = employer?.ats_provider ?? null
  const fill = provider ? (provider in PROVIDER_SUBMIT_FACTS ? `Cello can fill ${name}'s form.` : 'Applying here needs an account on their site.') : null
  const statRows = ((stats.data ?? []) as StatRow[]).map((s) => ({ ...s, open_count: Number(s.open_count), opened_30d: Number(s.opened_30d), opened_90d: Number(s.opened_90d), closed_count: Number(s.closed_count) }))
  const field = fieldFrom(statRows, targeting.role_types ?? [], fill)

  const readAt = statRows.map((s) => s.read_at).filter((x): x is string => !!x).sort().pop() ?? employer?.last_read_at ?? null
  const facts: Fact[] = []
  const split = Object.entries(statRows.reduce<Record<string, number>>((m, s) => (s.role_type ? { ...m, [s.role_type]: (m[s.role_type] ?? 0) + s.open_count } : m, {})))
    .flatMap(([id, n]) => (n > 0 && labelOf(id) ? [{ label: labelOf(id)!, n }] : []))
    .sort((a, b) => b.n - a.n)
    .slice(0, 6)
  if (split.length > 0 && readAt) facts.push({ text: `Open roles by type: ${split.map((t) => `${t.label} ${t.n}`).join(', ')}.`, source: `Read of ${name}'s job board on ${day(readAt)}` })
  const pay = statRows.reduce((n, s) => n + (s.stated_pay?.stated ?? 0), 0)
  if (pay > 0 && readAt) facts.push({ text: `${pay} of its postings state pay.`, source: `Read of ${name}'s job board on ${day(readAt)}` })
  if (needsSponsorship && visaFromCuratedList(name) === 'likely') facts.push({ text: 'Past H-1B filings.', source: 'Public U.S. Department of Labor filings' })
  if (provider) facts.push({ text: `Applies through ${cap(provider)}.`, source: `${name}'s own job board` })

  // Your history and what Remove will touch: stored rows of the person's own, read from the foreign keys before anything is removed.
  let history: HistoryItem[] = []
  let appliedAt: string | null = null
  let remove: CompanyData['remove'] = null
  if (own || employerId) {
    const filter = [employerId ? `employer_id.eq.${employerId}` : null, own ? `company_id.eq.${own.id}` : null].filter((x): x is string => x !== null).join(',')
    const [apps, passes, interactions, people, conversations, appCount] = await Promise.all([
      db.from('applications').select('stage, applied_at, created_at, jobs!inner(title, company_id, employer_id)').or(filter, { referencedTable: 'jobs' }).limit(20),
      db.from('role_reactions').select('reason, job_title, updated_at').eq('reaction', 'not_for_me').eq('company_name', name).limit(20),
      own ? db.from('interactions').select('kind, occurred_at, title').eq('company_id', own.id).order('occurred_at', { ascending: false }).limit(20) : Promise.resolve({ data: [] }),
      own ? db.from('contacts').select('id', { count: 'exact', head: true }).eq('company_id', own.id) : Promise.resolve({ count: 0 }),
      own ? db.from('interactions').select('id', { count: 'exact', head: true }).eq('company_id', own.id) : Promise.resolve({ count: 0 }),
      own ? db.from('applications').select('id, jobs!inner(company_id)', { count: 'exact', head: true }).eq('jobs.company_id', own.id) : Promise.resolve({ count: 0 }),
    ])
    type AppRow = { stage: string; applied_at: string | null; created_at: string; jobs: { title: string } | { title: string }[] }
    const appRows = (apps.data ?? []) as unknown as AppRow[]
    history = [
      ...appRows.map((a) => {
        const title = Array.isArray(a.jobs) ? a.jobs[0]?.title : a.jobs?.title
        return { at: a.applied_at ?? a.created_at, text: a.stage === 'discovered' ? `You saved ${title}.` : `You applied to ${title}. Status: ${a.stage}.` }
      }),
      ...((passes.data ?? []) as { reason: string | null; job_title: string; updated_at: string }[]).map((p) => ({ at: p.updated_at, text: `You passed on ${p.job_title}.` })),
      ...((interactions.data ?? []) as { kind: string; occurred_at: string; title: string | null }[]).filter((i) => i.title).map((i) => ({ at: i.occurred_at, text: i.title as string })),
    ].sort((a, b) => b.at.localeCompare(a.at))
    appliedAt = appRows.map((a) => a.applied_at ?? a.created_at).sort()[0] ?? null
    if (own) remove = { applications: appCount.count ?? 0, conversations: conversations.count ?? 0, people: people.count ?? 0, notes: Boolean(own.notes?.trim()) }
  }

  return {
    id: employerId ?? own!.id,
    state: r.kind,
    employerId,
    name,
    domain: employer?.domain ?? own?.domain ?? null,
    logoUrl: employer?.logo_url ?? own?.logo_url ?? null,
    careersUrl: employer?.careers_url ?? (own?.career_url || null),
    companyId: own?.id ?? null,
    following: own?.watching === true,
    pinned: own?.watching === true && own.is_dream_company === true,
    open: employer?.open_count ?? null,
    forYou,
    cannotRead: employer?.cannot_read_reason ?? null,
    tier: employer?.read_tier ?? null,
    lastReadAt: employer?.last_read_at ?? null,
    check: checks?.rolesCheck ? { lastAt: checks.rolesCheck.lastSucceededAt, nextAt: checks.rolesCheck.nextDueAt, missed: checks.rolesCheck.missed ? checks.rolesCheck.missedText : null } : null,
    kept,
    field,
    facts,
    history,
    notes: own?.notes?.trim() ? own.notes : null,
    appliedAt,
    remove,
    needsSponsorship,
    typeOptions: typeOptionsFor(prefs),
  }
}

// ---------------------------------------------------------------------------
// The live list
// ---------------------------------------------------------------------------

export interface LiveItem {
  key: string
  title: string
  location: string | null
  postedAt: string | null
  type: string | null
  level: string | null
  /** Why Cello did not keep it ("Other role type: Product Manager"); null for a role inside the person's search. */
  reason: string | null
  /** The stored role the person holds; its title opens the record. */
  jobId: string | null
}

export interface LiveData {
  items: LiveItem[]
  kept: number
  total: number
  matched: number
  pages: number
  page: number
  counts: Record<string, number>
  window: boolean
  /** Why nothing could be read, in the reader's own word. */
  failure: string | null
  /** The employer's site is read only in the background, so its list is not shown. */
  rendered: boolean
  /** Too many reads just now. */
  limited: boolean
  /** The roles kept before, shown when the site cannot be read. */
  keptBefore: RoleItem[]
}

const EMPTY_LIVE: LiveData = { items: [], kept: 0, total: 0, matched: 0, pages: 1, page: 0, counts: {}, window: false, failure: null, rendered: false, limited: false, keptBefore: [] }

const LEVEL_WORD: Record<string, string> = { intern: 'Intern', junior: 'Junior', mid: 'Mid', senior: 'Senior', staff: 'Staff', principal: 'Principal', manager: 'Manager', director: 'Director', exec: 'Executive' }

/** The employer as the live read wants it: the board the verifier tied to it, or its careers page. */
export function liveCompany(employer: DirectoryRow, own: OwnRow | null): LiveCompany {
  return {
    id: own?.id ?? employer.id,
    name: employer.name,
    domain: employer.domain,
    career_url: employer.careers_url ?? own?.career_url ?? null,
    metadata: employer.ats_provider && employer.ats_token ? { ats: { provider: employer.ats_provider, token: employer.ats_token } } : (own?.metadata ?? null),
    employer_id: employer.id,
  }
}

function toLiveItem(r: LiveRoles['rows'][number]): LiveItem {
  return {
    key: r.key,
    title: r.title,
    location: r.location,
    postedAt: r.postedAt,
    type: r.role_type ? labelOf(r.role_type) : null,
    level: LEVEL_WORD[r.level] ?? null,
    reason: reasonText(r),
    jobId: r.jobId,
  }
}

async function take(admin: Db | null, userId: string, bucket: string): Promise<boolean> {
  if (!admin) return true
  try {
    return await rpcSlotStore(admin as never).take({ userId, channel: 'page', bucket, limit: 30, windowSeconds: 600 })
  } catch {
    // A limit that cannot be counted is a refusal.
    return false
  }
}

/** The whole open list (or the search in it) as the person sees it, kept roles first, 25 a page. A site that cannot be read answers with the roles kept before. */
export async function readLive(db: Db, userId: string, employer: DirectoryRow, own: OwnRow | null, q: CompanyQuery): Promise<LiveData> {
  const admin = adminOrNull()
  if (employer.read_tier === 'rendered') return { ...EMPTY_LIVE, rendered: true }
  if (employer.cannot_read_reason) return { ...EMPTY_LIVE, keptBefore: await keptRoles(db, employer.id, own?.id ?? null, { limit: LIVE_PAGE, words: q.q }) }
  if (!(await take(admin, userId, 'companies.roles'))) return { ...EMPTY_LIVE, limited: true }
  const targets = await loadTargets((admin ?? db) as never, userId)
  const out = await liveRoles({ db, userId, company: liveCompany(employer, own), targets, page: q.page, match: { words: q.q ?? undefined, type: q.type ?? undefined, place: q.place ?? undefined } })
  return {
    items: out.rows.map(toLiveItem),
    kept: out.kept,
    total: out.total,
    matched: out.matched,
    pages: out.pages,
    page: out.page,
    counts: out.counts,
    window: out.window,
    failure: out.failure,
    rendered: false,
    limited: false,
    // A read that listed nothing falls back to what was kept before, so the page is never empty of what Cello holds.
    keptBefore: out.total === 0 ? await keptRoles(db, employer.id, own?.id ?? null, { limit: LIVE_PAGE, words: q.q }) : [],
  }
}

// ---------------------------------------------------------------------------
// The preview of one posting
// ---------------------------------------------------------------------------

export interface PreviewData {
  employerId: string
  company: { name: string; domain: string | null; logoUrl: string | null }
  key: string
  title: string
  url: string
  level: string | null
  type: string | null
  typeId: string | null
  location: string | null
  postedAt: string | null
  pay: string | null
  description: string
  partial: boolean
  tier: string | null
  fit: RoleFitView
  kinds: Record<string, 'must' | 'nice' | 'other'>
}

export type PreviewResult =
  | { kind: 'held'; id: string }
  | { kind: 'missing' }
  | { kind: 'limited' }
  | { kind: 'closed'; company: { name: string } }
  | { kind: 'ok'; data: PreviewData }

/** The posting's requirements as the fit reads them: an id from the text, must or nice, and which ones are about authorization. */
export function previewRequirements(preview: Pick<PostingPreview, 'requirements'>): { reqs: FitRequirement[]; authorizationIds: Set<string>; kinds: Record<string, 'must' | 'nice' | 'other'> } {
  const outcome = fromReaderRequirements(preview.requirements)
  const reqs: FitRequirement[] = []
  const authorizationIds = new Set<string>()
  const seen = new Set<string>()
  if (outcome.kind === 'ok') {
    for (const r of outcome.requirements) {
      const id = requirementKey(r.text)
      if (seen.has(id)) continue
      seen.add(id)
      reqs.push({ id, text: r.text, skills: [], kind: r.mustHave ? 'must' : 'nice' })
      if (r.kind === 'authorization') authorizationIds.add(id)
    }
  }
  return { reqs, authorizationIds, kinds: Object.fromEntries(reqs.map((r) => [r.id, r.kind])) }
}

/** Finds a posting by the employer's own key in the live read. The address never carries a link: no row, no preview. */
export async function findPosting(db: Db, userId: string, employer: DirectoryRow, own: OwnRow | null, key: string) {
  const admin = adminOrNull()
  const targets = await loadTargets((admin ?? db) as never, userId)
  const out = await liveRoles({ db, userId, company: liveCompany(employer, own), targets, match: { key } })
  const row = out.rows[0]
  return row ? { row, tier: out.tier } : null
}

export async function readPreview(db: Db, userId: string, employer: DirectoryRow, own: OwnRow | null, key: string): Promise<PreviewResult> {
  // A role the person already holds here lives on its record.
  const { data: held } = await db.from('person_jobs').select('id').eq('viewer_id', userId).eq('employer_id', employer.id).eq('external_id', key).limit(1).maybeSingle()
  if (held) return { kind: 'held', id: (held as { id: string }).id }
  const admin = adminOrNull()
  if (!(await take(admin, userId, 'roles.preview'))) return { kind: 'limited' }
  const found = await findPosting(db, userId, employer, own, key)
  if (!found) return { kind: 'missing' }
  const preview = await previewPosting({ url: found.row.url, title: found.row.title })
  if (!preview) return { kind: 'closed', company: { name: employer.name } }
  const { reqs, authorizationIds, kinds } = previewRequirements(preview)
  const material = admin ? await loadMaterial(admin as never, userId).catch(() => null) : null
  const items = codeVerdicts(reqs, material?.sources ?? [], authorizationIds)
  const body = preview.description_md ?? ''
  return {
    kind: 'ok',
    data: {
      employerId: employer.id,
      company: { name: employer.name, domain: employer.domain, logoUrl: employer.logo_url },
      key,
      title: preview.title || found.row.title,
      url: found.row.url,
      level: LEVEL_WORD[found.row.level] ?? null,
      type: found.row.role_type ? labelOf(found.row.role_type) : null,
      typeId: found.row.role_type,
      location: preview.location ?? found.row.location,
      postedAt: found.row.postedAt,
      pay: preview.salary_range?.trim() || null,
      description: body,
      partial: preview.description_state === 'partial' || preview.description_state === 'none',
      tier: found.tier,
      fit: { items, strip: stripOf(items), needsModel: reqs.some((r, n) => items[n].origin === 'code' && items[n].verdict === 'unknown' && !authorizationIds.has(r.id)), readAt: null },
      kinds,
    },
  }
}

