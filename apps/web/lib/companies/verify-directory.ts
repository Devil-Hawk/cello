// companies.verify: the one writer of company_directory, and of directory_candidates once a check has decided.
//
// An employer is in the directory because a board was tied to it by evidence (lib/ats/verify.ts), never because
// a name or a slug looked right. A check ends one of seven ways: the employer is verified and written, or it fails
// for one of six reasons that say what the person can do next:
//
//   not_linked         a board exists and nothing ties it to this employer
//   other_owner        the board belongs to another employer (a namesake: "retell" on Workable, "amazon" on Personio)
//   stale              the board's newest posting is older than 120 days, or it lists none
//   no_board           no board was found
//   cannot_read        the board or its provider did not answer
//   not_employer_site  the link is a job site (LinkedIn, Indeed), not the employer's own
//
// Every function takes its network as `deps` so the whole of it is proved without one.

import type { SupabaseClient } from '@supabase/supabase-js'
import { providers } from '../ats'
import { findPageBoards } from '../ats/detect'
import { HttpError } from '../ats/http'
import type { AtsJob, AtsProviderId, FetchContext } from '../ats/types'
import { IDENTIFY, sameEmployerName, verifyBoard, type BoardIdentity, type BoardRef } from '../ats/verify'
import { normalizeCompanyName } from '../entities/companies'
import { faviconForDomain, isKnownEmployer } from './known-companies'

type Db = SupabaseClient<any, any, any>

export type FailReason = 'not_linked' | 'other_owner' | 'stale' | 'no_board' | 'cannot_read' | 'not_employer_site'
export type DirectorySource = 'seed' | 'yc' | 'person' | 'lead' | 'inbox_verified'

/** A board with no posting in this long is held as stale (part 6, Autodiscovery). */
export const STALE_DAYS = 120
const DAY_MS = 86_400_000

/** What the check found that the person can use instead: another employer in the directory, or the employer's own posting. */
export interface Offer {
  kind: 'employer' | 'posting'
  name: string
  domain?: string | null
  employerId?: string
  url?: string
}

export interface VerifyDeps {
  fetchBoard: (provider: AtsProviderId, token: string, ctx?: FetchContext) => Promise<AtsJob[]>
  identify: (provider: AtsProviderId, token: string) => Promise<BoardIdentity | null>
  /** The boards the employer's own site links to (lazy: read only when the check needs them). */
  pageBoards: (input: { careerUrl: string | null; domain: string | null }) => Promise<BoardRef[]>
  now: () => number
}

export const realDeps: VerifyDeps = {
  fetchBoard: (provider, token, ctx) => providers[provider].fetch(token, ctx),
  identify: async (provider, token) => (IDENTIFY[provider] ? IDENTIFY[provider]!(token) : null),
  pageBoards: (input) => findPageBoards(input),
  now: Date.now,
}

export interface BoardCheckInput {
  /** The employer's name as the person or the seed gave it; null for a pasted board, where the board's own record names it. */
  name: string | null
  domain: string | null
  careerUrl?: string | null
  provider: AtsProviderId
  token: string
}

export type BoardCheck =
  | { ok: true; verifiedBy: 'careers_page_link' | 'board_links_home' | 'provider_name' | 'seed_checked' | 'careers_url'; jobs: AtsJob[]; domain: string | null; name: string }
  | { ok: false; reason: FailReason; identity?: BoardIdentity | null; jobs?: AtsJob[] }

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}
const PROVIDER_HOSTS = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|recruitee\.com|personio\.(de|com)|myworkdayjobs\.com|eightfold\.ai)$/

/** The domain a board declares for itself (not the provider's own host), or null. */
export function declaredDomain(identity: BoardIdentity | null | undefined): string | null {
  for (const u of identity?.homeUrls ?? []) {
    const h = hostOf(u)
    if (h && !PROVIDER_HOSTS.test(h)) return h
  }
  return null
}

function newestPosting(jobs: readonly AtsJob[]): number {
  let newest = 0
  for (const j of jobs) {
    const t = j.postedAt ? Date.parse(j.postedAt) : NaN
    if (!Number.isNaN(t) && t > newest) newest = t
  }
  return newest
}

/** Is this one board the employer's, and alive? */
export async function checkBoard(input: BoardCheckInput, deps: VerifyDeps = realDeps): Promise<BoardCheck> {
  const { name, domain, provider, token } = input
  let jobs: AtsJob[]
  try {
    jobs = await deps.fetchBoard(provider, token)
  } catch (error) {
    return { ok: false, reason: error instanceof HttpError && (error.status === 404 || error.status === 410) ? 'no_board' : 'cannot_read' }
  }
  // Nothing posted, or nothing posted lately (an undated board is not shown to be alive): held as stale.
  const newest = newestPosting(jobs)
  if (jobs.length === 0 || newest === 0 || deps.now() - newest > STALE_DAYS * DAY_MS) return { ok: false, reason: 'stale', jobs }

  let identity: BoardIdentity | null = null
  try {
    identity = await deps.identify(provider, token)
  } catch (error) {
    if (!(error instanceof HttpError && (error.status === 404 || error.status === 410))) return { ok: false, reason: 'cannot_read', jobs }
  }
  const owner = identity
  const home = declaredDomain(owner)

  if (!domain) {
    // A board with no employer domain (the seed, a pasted board): the provider's own record must name the employer.
    if (!identity?.name) return { ok: false, reason: 'not_linked', identity, jobs }
    if (name && !sameEmployerName(identity.name, name)) return { ok: false, reason: home ? 'other_owner' : 'not_linked', identity, jobs }
    return { ok: true, verifiedBy: name ? 'seed_checked' : 'provider_name', jobs, domain: home, name: identity.name }
  }

  // An employer's domain is known: a home the board declares elsewhere, or a different name on a big employer's board, is another owner.
  if (home && !(home === domain || home.endsWith(`.${domain}`) || domain.endsWith(`.${home}`))) return { ok: false, reason: 'other_owner', identity, jobs }
  const known = isKnownEmployer({ domain, name, careerUrl: input.careerUrl })
  const page = await deps.pageBoards({ careerUrl: input.careerUrl ?? null, domain }).catch(() => [] as BoardRef[])
  // A page that links boards of two employers (a parent and what it bought): the provider's name decides which is this one.
  if (page.length > 1 && name && identity?.name && !sameEmployerName(identity.name, name)) return { ok: false, reason: 'other_owner', identity, jobs }
  const verifiedBy = await verifyBoard({ provider, token, jobs, company: { name, domain }, pageBoards: page, knownEmployer: known, now: deps.now(), identify: owner ? async () => owner : null })
  // The provider's own name for the board is the best name for the employer; the given one is the fallback.
  if (verifiedBy) return { ok: true, verifiedBy, jobs, domain, name: identity?.name || name || domain }
  if (known || (name && identity?.name && !sameEmployerName(identity.name, name))) return { ok: false, reason: 'other_owner', identity, jobs }
  return { ok: false, reason: 'not_linked', identity, jobs }
}

// --- the writer ------------------------------------------------------------

export interface EmployerWrite {
  name: string
  domain: string | null
  careersUrl: string | null
  provider: AtsProviderId | null
  token: string | null
  verifiedBy: string
  source: DirectorySource
  openCount: number | null
  readTier: string | null
}

const MS_AFTER_VERIFY = 6 * 3_600_000

/**
 * Write one verified employer: the only place a row of company_directory is made or changed. An employer already
 * there (by board, then by domain) is updated, never doubled. Returns its id.
 */
export async function writeEmployer(db: Db, w: EmployerWrite, now: () => number = Date.now): Promise<string> {
  const at = new Date(now()).toISOString()
  const fields = {
    name: w.name.slice(0, 200),
    name_norm: normalizeCompanyName(w.name),
    // a check that knows less than the row (no domain, no careers address) leaves what the row has
    ...(w.domain ? { domain: w.domain, logo_url: faviconForDomain(w.domain) } : {}),
    ...(w.careersUrl ? { careers_url: w.careersUrl } : {}),
    ats_provider: w.provider,
    ats_token: w.token,
    verified_by: w.verifiedBy,
    verified_at: at,
    last_read_at: at,
    next_read_at: new Date(now() + MS_AFTER_VERIFY).toISOString(),
    read_tier: w.readTier ?? (w.provider ? 'board' : null),
    cannot_read_reason: null,
    failed_reads: 0,
    open_count: w.openCount,
    open_count_at: w.openCount === null ? null : at,
    updated_at: at,
  }
  let existing: { id: string; source: string } | null = null
  if (w.provider && w.token) {
    const { data } = await db.from('company_directory').select('id, source').eq('ats_provider', w.provider).eq('ats_token', w.token).maybeSingle()
    existing = (data as { id: string; source: string } | null) ?? null
  }
  if (!existing && w.domain) {
    const { data } = await db.from('company_directory').select('id, source').eq('domain', w.domain).maybeSingle()
    existing = (data as { id: string; source: string } | null) ?? null
  }
  if (existing) {
    // a person's own add or a traced lead outranks the seed's label for how the employer came
    const source = existing.source === 'seed' || existing.source === 'yc' ? w.source : existing.source
    const { error } = await db.from('company_directory').update({ ...fields, source }).eq('id', existing.id)
    if (error) throw new Error('could not write the employer')
    return existing.id
  }
  const { data, error } = await db.from('company_directory').insert({ ...fields, source: w.source }).select('id').single()
  if (error || !data) throw new Error('could not write the employer')
  return (data as { id: string }).id
}

// --- what a read of a verified board did to its row ----------------------------

/** A board is read again after this long, or after RETRY_READ_HOURS when it did not answer. */
export const READ_EVERY_HOURS = 24
export const RETRY_READ_HOURS = 6
const HOUR_MS = 3_600_000

export type ReadRecord =
  | { ok: true; openCount: number }
  | { ok: false; reason: FailReason; permanent: boolean }

/**
 * The employer's row after a read: its "of N open" and the next read, or why it left the rotation. A board that did
 * not answer is counted; at the third such read it leaves, and so does one that is gone or that no longer checks
 * out. Roles kept from a board that left stay until prune.
 */
export async function recordRead(db: Db, employer: { id: string; failed_reads?: number | null }, r: ReadRecord, now: () => number = Date.now): Promise<void> {
  const at = new Date(now()).toISOString()
  let patch: Record<string, unknown>
  if (r.ok) {
    patch = { open_count: r.openCount, open_count_at: at, last_read_at: at, next_read_at: new Date(now() + READ_EVERY_HOURS * HOUR_MS).toISOString(), failed_reads: 0, cannot_read_reason: null }
  } else {
    const reads = (employer.failed_reads ?? 0) + 1
    const leaves = r.permanent || reads >= MAX_UNREAD
    patch = { last_read_at: at, failed_reads: reads, ...(leaves ? { cannot_read_reason: r.reason, next_read_at: null } : { next_read_at: new Date(now() + RETRY_READ_HOURS * HOUR_MS).toISOString() }) }
  }
  const { error } = await db.from('company_directory').update({ ...patch, updated_at: at }).eq('id', employer.id)
  if (error) throw new Error('could not record the read')
}

/** Employers in the directory a person could mean by this name, domain or board token: what a failed check offers. */
export async function directoryOffers(db: Db, query: { name?: string | null; domain?: string | null; token?: string | null; exceptId?: string }): Promise<Offer[]> {
  const out = new Map<string, Offer>()
  for (const q of [query.name, query.domain, query.token]) {
    if (!q || !q.trim()) continue
    const { data } = await db.rpc('search_company_directory', { p_query: q.trim(), p_limit: 3 })
    for (const row of (data ?? []) as { id: string; name: string; domain: string | null }[]) {
      if (row.id !== query.exceptId) out.set(row.id, { kind: 'employer', name: row.name, domain: row.domain, employerId: row.id })
    }
  }
  return [...out.values()].slice(0, 3)
}

// --- a candidate's turn ------------------------------------------------------

/** Days until a failed candidate is tried again, and until a verified one is looked at again (part 6). */
export const RETRY_DAYS = 90

/** A board that did not answer is tried again after this long, and fails for good at this many such reads. */
export const RETRY_AFTER_UNREAD_DAYS = 1
export const MAX_UNREAD = 3

export interface CandidateRow {
  id: string
  name: string
  domain: string | null
  ats_provider: AtsProviderId | null
  ats_token: string | null
  source: 'kalil' | 'yc'
  failed_reads: number
}

export type Settled = { state: 'verified'; employerId: string } | { state: 'failed'; reason: FailReason; offers: Offer[] } | { state: 'retry'; reason: 'cannot_read' }

export type Verified = { ok: true; employerId: string } | { ok: false; reason: FailReason }

/**
 * Tie an employer to a board by evidence and write it (companies.verify). The boards to try are the ones given, else
 * the boards the employer's own site links to when its domain is known, never a guess by name. The first board that
 * passes the verifier is the employer's; otherwise the first failure says why.
 */
export async function verifyEmployer(
  db: Db,
  input: { name: string | null; domain: string | null; boards: BoardRef[]; source: DirectorySource },
  deps: VerifyDeps = realDeps
): Promise<Verified> {
  // The site is read once for the whole check.
  let page: Promise<BoardRef[]> | null = null
  const once: VerifyDeps = { ...deps, pageBoards: (i) => (page ??= deps.pageBoards(i)) }
  let boards = input.boards
  if (boards.length === 0 && input.domain) boards = await once.pageBoards({ careerUrl: null, domain: input.domain }).catch(() => [] as BoardRef[])

  let failed: Extract<BoardCheck, { ok: false }> | null = null
  for (const b of boards) {
    const check = await checkBoard({ name: input.name, domain: input.domain, provider: b.provider, token: b.token }, once)
    if (check.ok) {
      const employerId = await writeEmployer(
        db,
        { name: check.name, domain: check.domain ?? input.domain, careersUrl: null, provider: b.provider, token: b.token, verifiedBy: check.verifiedBy, source: input.source, openCount: check.jobs.length, readTier: 'board' },
        deps.now
      )
      return { ok: true, employerId }
    }
    failed ??= check
  }
  return { ok: false, reason: failed?.reason ?? 'no_board' }
}

/**
 * Check one candidate and settle it: verified (the employer is written and linked), or failed with its reason and
 * the next try in 90 days. A board that did not answer is tried again soon, and fails for good after 3 such reads.
 * A row with a website and no board is checked through the boards its own site links to, never a guess by name.
 */
export async function settleCandidate(db: Db, c: CandidateRow, deps: VerifyDeps = realDeps): Promise<Settled> {
  const now = deps.now()
  const at = new Date(now).toISOString()
  const later = (days: number) => new Date(now + days * DAY_MS).toISOString()

  const v = await verifyEmployer(db, { name: c.name, domain: c.domain, boards: c.ats_provider && c.ats_token ? [{ provider: c.ats_provider, token: c.ats_token }] : [], source: c.source === 'yc' ? 'yc' : 'seed' }, deps)
  if (v.ok) {
    await db.from('directory_candidates').update({ state: 'verified', employer_id: v.employerId, fail_reason: null, failed_reads: 0, checked_at: at, next_check_at: later(RETRY_DAYS) }).eq('id', c.id)
    return { state: 'verified', employerId: v.employerId }
  }
  const reason = v.reason
  if (reason === 'cannot_read') {
    const reads = c.failed_reads + 1
    const final = reads >= MAX_UNREAD
    await db
      .from('directory_candidates')
      .update({ state: final ? 'failed' : 'pending', fail_reason: final ? 'cannot_read' : null, failed_reads: reads, checked_at: at, next_check_at: later(final ? RETRY_DAYS : RETRY_AFTER_UNREAD_DAYS) })
      .eq('id', c.id)
    return final ? { state: 'failed', reason, offers: [] } : { state: 'retry', reason }
  }
  await db.from('directory_candidates').update({ state: 'failed', fail_reason: reason, checked_at: at, next_check_at: later(RETRY_DAYS) }).eq('id', c.id)
  return { state: 'failed', reason, offers: reason === 'other_owner' ? await directoryOffers(db, { name: c.name, domain: c.domain }) : [] }
}
