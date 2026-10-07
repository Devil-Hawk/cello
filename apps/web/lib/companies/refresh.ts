// Build and store "Suggested for you".
//
// Runs as the suggestions.refresh routine on the clock (lib/clock/routines/suggestions-refresh.ts), never on a page
// load, and from a person's own "find suggestions now" request. Every query about a person carries their user id: this
// file uses the service role, which skips row level security, so the filter is the only fence (a test scans for it).
//
// Evidence gathered per person, all of it public or their own:
//   leads            the aggregators Cello already reads, filtered by their targeting. They are evidence of hiring
//                    only: nothing here makes an employer or stores a role (a lead is traced or counted elsewhere)
//   the directory    Y Combinator candidates with their tags (the seed's), and verified employers by name
//   live boards      the verified employers' own boards, read now. A board is only ever one the verifier tied to the
//                    employer; no board is guessed from a name
// Failure never destroys good data: when every source fails the old open rows stay and the state says "failed".

import type { AdminClient } from '../harness/types'
import { providers } from '../ats'
import type { AtsJob, AtsProviderId } from '../ats/types'
import { isDemoProfile } from '../access/guardrails'
import { normalizeCompanyName } from '../entities/companies'
import { logApiError } from '../observability/log'
import { extractSkillsFromText } from '../jobs/skills'
import { queryAllSources, sourceAdapters } from '../sources'
import type { JobLead, SourceId } from '../sources/types'
import { sanitizeLeads } from '../sources/util'
import { resolveTargeting, type Targeting } from '../targeting'
import { resolveTargetTitles } from '../targeting/titles'
import { normalizeDomain } from './identity'
import { prefsFromProfile } from './location'
import { buildVocabulary, tagsFromText } from './similarity'
import { buildSuggestions, leadCompanies, roleMatcher, type ProbeTarget, type SuggestionDraft, type SuggestionInputs } from './suggestions'
import type { BoardHit, YcRow } from './types'

/** The next daily tick should find a list due: 20 hours, not 24. */
export const REFRESH_AFTER_MS = 20 * 3600 * 1000
const SOURCE_TIMEOUT_MS = 60_000
/** Most verified boards read per person per refresh: the best-ranked candidates first, then every other company the aggregators show hiring. */
const BOARDS_MAX = 40
const BOARD_CONCURRENCY = 4
/** Most liked companies read per person: tags and descriptions are fetched for each. */
const MAX_LIKED = 40
const LIKED_DESCRIPTIONS = 3
const LIKED_TEXT_CHARS = 1500
const MAX_BOARD_JOBS = 200

export type RefreshStatus = 'ok' | 'partial' | 'failed' | 'needs_targeting'

export interface RefreshResult {
  status: RefreshStatus
  stored: number
  counts: Record<string, unknown>
}

/** A verified employer with a board, as a suggestion reads it. */
export interface VerifiedEmployer {
  id: string
  name: string
  domain: string | null
  careers_url: string | null
  ats_provider: AtsProviderId | null
  ats_token: string | null
}

export interface RefreshDeps {
  queryAllSources: typeof queryAllSources
  /** The roles a verified board lists right now, or null when it cannot be read. */
  readBoard: (employer: VerifiedEmployer) => Promise<BoardHit | null>
  now: () => Date
}

const BOARD_URLS: Record<AtsProviderId, (token: string) => string> = {
  greenhouse: (t) => `https://boards.greenhouse.io/${t}`,
  lever: (t) => `https://jobs.lever.co/${t}`,
  ashby: (t) => `https://jobs.ashbyhq.com/${t}`,
  workable: (t) => `https://apply.workable.com/${t}`,
  smartrecruiters: (t) => `https://careers.smartrecruiters.com/${t}`,
  recruitee: (t) => `https://${t}.recruitee.com`,
  personio: (t) => `https://${t}.jobs.personio.com`,
  workday: (t) => `https://${t}`,
  eightfold: (t) => `https://${t}.eightfold.ai/careers`,
}

const jobOf = (j: AtsJob) => ({ title: j.title, location: j.location ?? null, url: j.url, postedAt: j.postedAt ?? null })

async function readVerifiedBoard(employer: VerifiedEmployer): Promise<BoardHit | null> {
  const provider = employer.ats_provider
  const token = employer.ats_token
  if (!provider || !token || !providers[provider]) return null
  try {
    // hasDescription true: a list is all this read needs, so no request per posting.
    const jobs = await providers[provider].fetch(token, { hasDescription: () => true })
    return { provider, token, boardUrl: employer.careers_url || BOARD_URLS[provider](token), openRoles: jobs.length, jobs: jobs.slice(0, MAX_BOARD_JOBS).map(jobOf) }
  } catch {
    return null
  }
}

const defaultDeps: RefreshDeps = { queryAllSources, readBoard: readVerifiedBoard, now: () => new Date() }

interface OwnCompany {
  id: string
  name: string
  domain: string | null
  name_key: string | null
  canonical_id: string | null
  is_dream_company: boolean | null
  metadata: unknown
}

function isShell(metadata: unknown): boolean {
  return !!metadata && typeof metadata === 'object' && (metadata as { suggested?: unknown }).suggested === true
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase().trim()).filter(Boolean) : []
}

/** Resume skills, lower case, for the last-resort role signal. */
function keywordsFromResume(resume: string | null): string[] {
  if (!resume) return []
  const out = new Set<string>()
  for (const skill of extractSkillsFromText(resume)) {
    const k = skill.name.toLowerCase().trim()
    if (k.length >= 2) out.add(k)
  }
  return [...out].slice(0, 30)
}

/** Free-text places and the remote flag, from the person's own preferences. */
function locationWords(preferences: unknown): { locations: string[]; remote: boolean } {
  const p = (preferences && typeof preferences === 'object' ? preferences : {}) as Record<string, unknown>
  const locations = (Array.isArray(p.preferredLocations) ? p.preferredLocations : [])
    .filter((l): l is string => typeof l === 'string')
    .map((l) => l.toLowerCase().trim())
    .filter(Boolean)
  const pref = typeof p.remotePreference === 'string' ? p.remotePreference : 'any'
  return { locations, remote: pref === 'remote' || pref === 'any' || locations.some((l) => l.includes('remote')) }
}

/** A lead that breaks a hard exclusion (an excluded company or word) is never evidence. */
function violatesHardExclusions(lead: JobLead, targeting: Targeting): boolean {
  if (targeting.excludedCompanies.length > 0 && targeting.excludedCompanies.some((c) => lead.company.toLowerCase().includes(c))) return true
  if (targeting.excludedKeywords.length > 0) {
    const text = `${lead.title} ${lead.description}`.toLowerCase()
    if (targeting.excludedKeywords.some((k) => text.includes(k))) return true
  }
  return false
}

export interface LoadedInputs {
  inputs: SuggestionInputs
  resumeText: string | null
  preferences: unknown
}

/** Read everything the ranking needs about one person. Every query is scoped to them. */
export async function loadSuggestionInputs(admin: AdminClient, userId: string, yc?: YcRow[]): Promise<LoadedInputs> {
  const { data: profile } = await admin.from('profiles').select('resume_text, preferences').eq('id', userId).maybeSingle()
  const resumeText = (profile?.resume_text as string | null) ?? null
  const preferences = profile?.preferences ?? null
  const targeting = resolveTargeting(preferences)
  const targets = resolveTargetTitles(preferences)

  const { data: ownRows } = await admin
    .from('companies')
    .select('id, name, domain, name_key, canonical_id, is_dream_company, metadata')
    .eq('user_id', userId)
  const own = (ownRows as OwnCompany[] | null) ?? []
  const watched = own.filter((c) => !isShell(c.metadata)).map((c) => ({ name: c.name, domain: c.domain }))

  const { data: acted } = await admin
    .from('company_suggestions')
    .select('company_key, name, domain, status, company_id')
    .eq('user_id', userId)
    .in('status', ['added', 'dismissed'])
  const actedRows = (acted as { company_key: string; name: string; domain: string | null; status: string; company_id: string | null }[] | null) ?? []
  // A dismissed or added company stays out by key AND by name, in case its key changed.
  for (const a of actedRows) watched.push({ name: a.name, domain: a.domain })

  // Companies the person likes: dream companies, applications past "discovered", and companies they added from suggestions.
  const likedIds = new Set(own.filter((c) => c.is_dream_company && !c.canonical_id).map((c) => c.id))
  for (const a of actedRows) if (a.status === 'added' && a.company_id) likedIds.add(a.company_id)
  // An application past "discovered" says the person wants this company. The role is read through the person's own
  // view of it (person_jobs), which names the person's company for a role shared with another follower.
  const { data: apps } = await admin
    .from('applications')
    .select('job_id')
    .eq('user_id', userId)
    .in('stage', ['applied', 'screen', 'interview', 'offer'])
  const appliedJobs = ((apps as { job_id: string | null }[] | null) ?? []).map((a) => a.job_id).filter((id): id is string => !!id)
  if (appliedJobs.length > 0) {
    const { data: viewed } = await admin.from('person_jobs').select('viewer_company_id').eq('viewer_id', userId).in('id', appliedJobs.slice(0, 500))
    const ownIds = new Set(own.map((c) => c.id))
    for (const v of (viewed as { viewer_company_id: string | null }[] | null) ?? []) if (v.viewer_company_id && ownIds.has(v.viewer_company_id)) likedIds.add(v.viewer_company_id)
  }
  const likedCompanies = own.filter((c) => likedIds.has(c.id)).slice(0, MAX_LIKED)

  // Tags for each liked company: the directory's tags by domain, else vocabulary words in its newest job descriptions.
  const dirRows = yc ?? (await loadYc(admin))
  const vocab = buildVocabulary(dirRows)
  const byDomain = new Map(dirRows.filter((r) => r.domain).map((r) => [r.domain as string, r]))
  const texts = new Map<string, string>()
  const needText = likedCompanies.filter((c) => !(normalizeDomain(c.domain) && byDomain.get(normalizeDomain(c.domain) as string)?.tags.length))
  if (needText.length > 0) {
    const { data: jobs } = await admin
      .from('person_jobs')
      .select('viewer_company_id, description, discovered_at')
      .eq('viewer_id', userId)
      .in('viewer_company_id', needText.slice(0, MAX_LIKED).map((c) => c.id))
      .order('discovered_at', { ascending: false })
      .limit(MAX_LIKED * 20)
    const seen = new Map<string, number>()
    for (const j of (jobs as { viewer_company_id: string; description: string }[] | null) ?? []) {
      const n = seen.get(j.viewer_company_id) ?? 0
      if (n >= LIKED_DESCRIPTIONS) continue
      seen.set(j.viewer_company_id, n + 1)
      texts.set(j.viewer_company_id, `${texts.get(j.viewer_company_id) ?? ''} ${(j.description ?? '').slice(0, LIKED_TEXT_CHARS)}`)
    }
  }
  const liked = likedCompanies.map((c) => {
    const dom = normalizeDomain(c.domain)
    const row = dom ? byDomain.get(dom) : undefined
    const tags = row && row.tags.length > 0 ? row.tags.map((t) => t.toLowerCase()) : [...tagsFromText(texts.get(c.id) ?? '', vocab)]
    return { name: c.name, domain: dom, tags }
  })

  // Disliked: the targeting list, and the scoring package's constraints list (read as plain json).
  const constraints = (preferences as { constraints?: { excludedCompanies?: unknown } } | null)?.constraints
  const excludedNames = [...new Set([...targeting.excludedCompanies, ...stringList(constraints?.excludedCompanies)])]

  const inputs: SuggestionInputs = {
    targets,
    targeting,
    keywords: keywordsFromResume(resumeText),
    prefs: prefsFromProfile(preferences),
    watched,
    excludedNames,
    actedKeys: actedRows.map((a) => a.company_key),
    liked,
  }
  return { inputs, resumeText, preferences }
}

/** The Y Combinator candidates with their tags, for similarity and as the vocabulary. */
async function loadYc(admin: AdminClient): Promise<YcRow[]> {
  const { data } = await admin.from('directory_candidates').select('name, name_norm, domain, tags, profile_url, regions, locations').eq('source', 'yc').limit(5000)
  return ((data as { name: string; name_norm: string; domain: string | null; tags: string[] | null; profile_url: string | null; regions: string[] | null; locations: string | null }[] | null) ?? []).map((r) => ({
    name: r.name,
    name_key: r.name_norm,
    domain: r.domain,
    source: 'yc' as const,
    profile_url: r.profile_url,
    tags: r.tags ?? [],
    regions: r.regions ?? [],
    locations: r.locations,
  }))
}

const COLUMNS = 'id, name, name_norm, domain, careers_url, ats_provider, ats_token'
interface DirectoryRow {
  id: string
  name: string
  name_norm: string
  domain: string | null
  careers_url: string | null
  ats_provider: AtsProviderId | null
  ats_token: string | null
}

/** Verified employers the leads name, by name: their domain says which company a lead without one means. */
async function loadEmployerRows(admin: AdminClient, leads: JobLead[]): Promise<{ rows: YcRow[]; employers: DirectoryRow[] }> {
  const keys = [...new Set(leads.map((l) => normalizeCompanyName(l.company)).filter(Boolean))]
  const employers: DirectoryRow[] = []
  for (let i = 0; i < keys.length; i += 100) {
    const { data } = await admin.from('company_directory').select(COLUMNS).not('verified_at', 'is', null).in('name_norm', keys.slice(i, i + 100))
    employers.push(...((data as DirectoryRow[] | null) ?? []))
  }
  const rows: YcRow[] = employers.map((e) => ({ name: e.name, name_key: e.name_norm, domain: e.domain, source: 'directory', profile_url: null, tags: [], regions: [], locations: null }))
  return { rows, employers }
}

/** The verified employers a set of candidates are: by domain, or by a name only one verified employer has. */
async function verifiedFor(admin: AdminClient, targets: ProbeTarget[], byName: DirectoryRow[]): Promise<Map<string, VerifiedEmployer>> {
  const out = new Map<string, VerifiedEmployer>()
  const domains = [...new Set(targets.map((t) => normalizeDomain(t.domain)).filter((d): d is string => !!d))]
  const byDomain = new Map<string, DirectoryRow>()
  for (let i = 0; i < domains.length; i += 100) {
    const { data } = await admin.from('company_directory').select(COLUMNS).not('verified_at', 'is', null).in('domain', domains.slice(i, i + 100))
    for (const r of (data as DirectoryRow[] | null) ?? []) if (r.domain) byDomain.set(r.domain, r)
  }
  const counts = new Map<string, number>()
  for (const e of byName) counts.set(e.name_norm, (counts.get(e.name_norm) ?? 0) + 1)
  for (const t of targets) {
    const d = normalizeDomain(t.domain)
    const hit = (d ? byDomain.get(d) : undefined) ?? byName.find((e) => e.name_norm === normalizeCompanyName(t.name) && counts.get(e.name_norm) === 1)
    if (hit) out.set(t.key, hit)
  }
  return out
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
      while (true) {
        const i = next++
        if (i >= items.length) return
        await fn(items[i])
      }
    })
  )
}

async function writeState(admin: AdminClient, userId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await admin
    .from('company_suggestion_state')
    .upsert({ user_id: userId, updated_at: new Date().toISOString(), ...patch }, { onConflict: 'user_id' })
  if (error) throw new Error(`company_suggestion_state: ${error.message}`)
}

/** Leads from every aggregator except Y Combinator (the directory covers it), filtered by the person's targeting. */
export async function gatherLeads(
  inputs: SuggestionInputs,
  resumeText: string | null,
  preferences: unknown,
  deps: Pick<RefreshDeps, 'queryAllSources'> = defaultDeps,
  userId?: string
): Promise<{ leads: JobLead[]; perSource: Record<string, { found: number; error?: string }> }> {
  const { locations, remote } = locationWords(preferences)
  const only = sourceAdapters.map((a) => a.id).filter((id): id is SourceId => id !== 'ycombinator')
  try {
    const keywords = [...new Set([...inputs.targets.join(' ').toLowerCase().split(/[^a-z0-9+#.]+/).filter((w) => w.length >= 3), ...keywordsFromResume(resumeText)])].slice(0, 30)
    const res = await deps.queryAllSources(
      { keywords, locations, remote, targeting: inputs.targeting, signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) },
      { only, totalLimit: 200 }
    )
    return {
      leads: sanitizeLeads(res.leads, inputs.targeting).filter((l) => !violatesHardExclusions(l, inputs.targeting)),
      perSource: res.perSource,
    }
  } catch (e) {
    logApiError('companies/suggestions:sources', e, userId ? { userId } : undefined)
    return { leads: [], perSource: {} }
  }
}

/**
 * Rank without boards, then read the verified employers' own boards and rank again so a matching role on a company's
 * own board lifts it to tier 1. A company that is not a verified employer gets no board evidence: its board is not guessed.
 */
export async function rankWithBoards(
  admin: AdminClient,
  inputs: SuggestionInputs,
  leads: JobLead[],
  yc: YcRow[],
  deps: Pick<RefreshDeps, 'readBoard' | 'now'> = defaultDeps
): Promise<{ drafts: SuggestionDraft[]; first: SuggestionDraft[]; boardHits: Map<string, BoardHit>; probed: number }> {
  const named = await loadEmployerRows(admin, leads)
  const directory = [...yc, ...named.rows]
  const now = deps.now()
  const first = buildSuggestions(inputs, leads, directory, new Map(), now) ?? []
  const targets = new Map<string, ProbeTarget>(first.map((d) => [d.key, { key: d.key, name: d.name, domain: d.domain }]))
  for (const t of leadCompanies(inputs, leads, directory)) if (!targets.has(t.key)) targets.set(t.key, t)
  const toRead = [...targets.values()].slice(0, BOARDS_MAX)
  const employers = await verifiedFor(admin, toRead, named.employers)
  const boardHits = new Map<string, BoardHit>()
  await pool(toRead.filter((t) => employers.get(t.key)?.ats_provider), BOARD_CONCURRENCY, async (target) => {
    const hit = await deps.readBoard(employers.get(target.key) as VerifiedEmployer)
    if (hit) boardHits.set(target.key, hit)
  })
  return { drafts: buildSuggestions(inputs, leads, directory, boardHits, now) ?? [], first, boardHits, probed: toRead.length }
}

/**
 * Rebuild one person's suggestions. Never throws on a source failure: the old
 * open rows stay and the state says failed. Throws only when the database
 * itself fails.
 */
export async function refreshSuggestionsForUser(
  admin: AdminClient,
  userId: string,
  deps: RefreshDeps = defaultDeps
): Promise<RefreshResult> {
  const now = deps.now()
  const nextRefreshAt = new Date(now.getTime() + REFRESH_AFTER_MS).toISOString()
  const yc = await loadYc(admin)
  const { inputs, resumeText, preferences } = await loadSuggestionInputs(admin, userId, yc)

  if (!roleMatcher(inputs)) {
    await writeState(admin, userId, { status: 'needs_targeting', next_refresh_at: nextRefreshAt, counts: {} })
    return { status: 'needs_targeting', stored: 0, counts: {} }
  }

  const { leads, perSource } = await gatherLeads(inputs, resumeText, preferences, deps, userId)
  const errored = Object.values(perSource).filter((s) => s.error).length
  const sourceCount = Object.keys(perSource).length
  if (sourceCount === 0 || errored === sourceCount) {
    await writeState(admin, userId, { status: 'failed', next_refresh_at: nextRefreshAt, counts: { sources: sourceCount, errored } })
    return { status: 'failed', stored: 0, counts: { sources: sourceCount, errored } }
  }

  const { drafts, first, boardHits, probed } = await rankWithBoards(admin, inputs, leads, yc, deps)

  // 3. Store: upsert the new rows, then remove open rows that fell out. Acted rows are never touched.
  const computedAt = now.toISOString()
  if (drafts.length > 0) {
    const rows = drafts.map((d) => ({
      user_id: userId,
      company_key: d.key,
      name: d.name,
      domain: d.domain,
      logo_url: d.logoUrl,
      tier: d.tier,
      rank: d.rank,
      reason: d.reason,
      source_url: d.sourceUrl,
      source_label: d.sourceLabel,
      signals: d.signals,
      ats: d.ats,
      status: 'open',
      computed_at: computedAt,
    }))
    const { error } = await admin.from('company_suggestions').upsert(rows, { onConflict: 'user_id,company_key' })
    if (error) throw new Error(`company_suggestions upsert: ${error.message}`)
  }
  const keep = new Set(drafts.map((d) => d.key))
  const { data: open } = await admin.from('company_suggestions').select('id, company_key').eq('user_id', userId).eq('status', 'open')
  const stale = ((open as { id: string; company_key: string }[] | null) ?? []).filter((r) => !keep.has(r.company_key)).map((r) => r.id)
  if (stale.length > 0) await admin.from('company_suggestions').delete().eq('user_id', userId).eq('status', 'open').in('id', stale.slice(0, 100))

  const status: RefreshStatus = errored > 0 ? 'partial' : 'ok'
  const counts = {
    leads: leads.length,
    sources: sourceCount,
    errored,
    candidates: first.length,
    boardsRead: probed,
    boardsFound: boardHits.size,
    stored: drafts.length,
    removed: stale.length,
  }
  await writeState(admin, userId, { status, computed_at: computedAt, next_refresh_at: nextRefreshAt, counts })
  return { status, stored: drafts.length, counts }
}

// ---------------------------------------------------------------------------
// The routine's pass
// ---------------------------------------------------------------------------

export interface DueDeps {
  refreshUser: typeof refreshSuggestionsForUser
  now: () => number
}

const defaultDueDeps: DueDeps = { refreshUser: refreshSuggestionsForUser, now: () => Date.now() }

export interface DueResult {
  refreshed: number
  failed: number
  /** People whose list is due that this pass did not reach: the routine carries on in its next slice. */
  skipped: number
}

interface ProfileRow {
  id: string
  resume_text: string | null
  preferences: unknown
  is_demo: boolean | null
  demo_expires_at: string | null
}

/**
 * One pass of the routine: people whose list is due, never-built first. People with no role signal are skipped (the
 * page says "tell Cello which roles you want"), demos are skipped, and no new person starts after the deadline. The
 * Y Combinator list is the seed's (directory.seed), not this pass's.
 */
export async function refreshDueSuggestions(
  admin: AdminClient,
  opts: { deadlineAt: number; maxUsers?: number; concurrency?: number },
  deps: DueDeps = defaultDueDeps
): Promise<DueResult> {
  const maxUsers = opts.maxUsers ?? 6

  const { data: profiles } = await admin.from('profiles').select('id, resume_text, preferences, is_demo, demo_expires_at')
  const { data: states } = await admin.from('company_suggestion_state').select('user_id, next_refresh_at')
  const nextBy = new Map(((states as { user_id: string; next_refresh_at: string }[] | null) ?? []).map((s) => [s.user_id, s.next_refresh_at]))
  const nowMs = deps.now()

  const due = ((profiles as ProfileRow[] | null) ?? [])
    .filter((p) => !isDemoProfile({ is_demo: p.is_demo ?? null, demo_expires_at: p.demo_expires_at ?? null }))
    .filter((p) => {
      const next = nextBy.get(p.id)
      return !next || Date.parse(next) <= nowMs
    })
    .filter((p) => hasRoleSignal(p))
    .sort((a, b) => Date.parse(nextBy.get(a.id) ?? '1970-01-01') - Date.parse(nextBy.get(b.id) ?? '1970-01-01'))

  const result: DueResult = { refreshed: 0, failed: 0, skipped: 0 }
  const batch = due.slice(0, maxUsers)
  result.skipped = due.length - batch.length
  let next = 0
  const worker = async () => {
    while (true) {
      const i = next++
      if (i >= batch.length) return
      if (deps.now() >= opts.deadlineAt) {
        result.skipped += 1
        continue
      }
      try {
        const r = await deps.refreshUser(admin, batch[i].id)
        if (r.status === 'failed') result.failed += 1
        else result.refreshed += 1
      } catch (e) {
        logApiError('companies/suggestions:user', e, { userId: batch[i].id })
        result.failed += 1
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 2, batch.length)) }, worker))
  return result
}

/** Does this profile give the ranking anything to match roles against? */
export function hasRoleSignal(p: Pick<ProfileRow, 'resume_text' | 'preferences'>): boolean {
  const targeting = resolveTargeting(p.preferences)
  return roleMatcher({ targets: resolveTargetTitles(p.preferences), targeting, keywords: keywordsFromResume(p.resume_text) }) !== null
}
