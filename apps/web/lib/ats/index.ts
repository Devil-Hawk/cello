// ATS registry + per-company refresh core.
//
// refreshCompany() contains all provider/dedup/insert-count logic and talks to
// the database through the small AtsStore interface, so the same code runs in
// the Next.js route (user-scoped supabase-js client, RLS enforced) and in the
// scheduled script (scripts/ingest.ts, service-role client).

import { createHash } from 'node:crypto'
import type { AtsJob, AtsMetadata, AtsProvider, AtsProviderId, FetchContext } from './types'
import { isValidToken } from './types'
import { greenhouse } from './greenhouse'
import { lever } from './lever'
import { ashby } from './ashby'
import { workday } from './workday'
import { smartrecruiters } from './smartrecruiters'
import { workable } from './workable'
import { recruitee } from './recruitee'
import { personio } from './personio'
import { eightfold } from './eightfold'
import { detectAts } from './detect'
import { healStoredBoard, needsVerification } from './heal'
import { isStalePosting } from '../jobs/freshness'
import {
  dedupeRoles,
  emptyExcluded,
  judgeRole,
  orderForCap,
  MAX_DESCRIPTION_CHARS,
  MAX_ROLES_PER_COMPANY,
  type Excluded,
  type JudgeContext,
} from '../ingest/reader/legit'
import { searchTerms, type ReaderTargets } from '../ingest/reader/targets'
import { targetVerdict, type TargetVerdict } from '../targeting/roles'
import { hasPersonTargets, judgeForPerson, prepareTargets, type OutsideReason } from '../jobs/target-relevance'
import type { SourceTier } from '../jobs/relevance-types'
import { EMPTY_TARGETING, type Targeting } from '../targeting'
// Relative import (not `@/...`): lib/ats/* stays framework-free, and
// lib/jobs/classify.ts is itself a zero-dependency pure module, so this is
// safe in both the Next.js route and the plain-tsx scheduled script.
import { classifyJob, isLowQuality } from '../jobs/classify'
// Same reasoning as classify above: lib/jobs/mojibake.ts is pure and
// dependency-free, so importing it here keeps lib/ats framework-free.
import { repairMojibake } from '../jobs/mojibake'
// Pure and import-light too (zod + the classifier): the requirements read at
// ingest, so a row is stored with what it asks for.
import { parseRequirements, type Requirements } from '../jobs/requirements'

export type {
  AtsJob,
  AtsMetadata,
  AtsProvider,
  AtsProviderId,
  DetectInput,
  FetchContext,
} from './types'
export { detectAts, detectFromUrl, probeAts, candidateTokens } from './detect'
export { HttpError, fetchJson, fetchText, assertAllowedHost, assertAllowedHostSuffix } from './http'
export { greenhouse } from './greenhouse'
export { lever } from './lever'
export { ashby } from './ashby'
export { workday } from './workday'
export { smartrecruiters } from './smartrecruiters'
export { workable } from './workable'
export { recruitee } from './recruitee'
export { personio } from './personio'
export { eightfold } from './eightfold'
export { makeSupabaseAtsStore } from './store'

export const providers: Record<AtsProviderId, AtsProvider> = {
  greenhouse,
  lever,
  ashby,
  workday,
  smartrecruiters,
  workable,
  recruitee,
  personio,
  eightfold,
}

/** The company fields refreshCompany needs (subset of the companies row). */
export interface CompanyInput {
  id: string
  name: string
  domain: string | null
  career_url: string | null
  /** companies.metadata jsonb — may be absent when the column doesn't exist yet. */
  metadata?: unknown
  /** The person who follows the company: the roles a read keeps are kept for them. */
  user_id?: string
  /** The shared employer (company_directory), when the company's board passed the verifier. */
  employer_id?: string | null
}

/** Row shape upserted into jobs (onConflict company_id,external_id). */
export interface JobUpsertRow {
  company_id: string
  /** Set only for a company in the directory: its rows are written once per employer, whoever reads first. */
  employer_id?: string
  title: string
  description: string
  url: string
  location: string | null
  salary_range: string | null
  posted_at: string | null
  external_id: string
  is_new: boolean
  discovered_at: string
  /** Classification columns (lib/jobs/classify.ts) — populated at ingest time. */
  job_function: string
  seniority: string
  language: string
  country: string | null
  is_remote: boolean
  job_type: string
  quality_score: number
  /** Ingest provenance: the ATS provider (or 'scraper', the page reader) that produced this row. */
  source: string
  /** Which tier of the reader produced it: a board, the site's search, a sitemap, a listing or the rendered page. */
  source_tier?: SourceTier | null
  /** The refresh that listed this posting; the prune and the closed check read it. */
  last_seen_at: string
  /** What the posting asks for (lib/jobs/requirements.ts), read from the description now. */
  requirements: Requirements
  requirements_extracted_at: string
}

/** A stored job, as much of it as a refresh needs to decide whether anything changed. */
export interface ExistingJob {
  externalId: string
  title: string
  location: string | null
  salaryRange: string | null
  /** md5 of the stored description (jobs.description_md5); null when it is empty. */
  descriptionMd5: string | null
  /** jobs.source of the stored row. */
  source?: string | null
  /** False once the row is closed (jobs.still_open). */
  open?: boolean
  /** The role's address and when a read last listed it: what a re-check of a role that left a site needs. */
  url?: string | null
  lastSeenAt?: string | null
  /** What the person's targets are judged on, so a full company can tell which stored role to give up (never the description). */
  jobFunction?: string | null
  seniority?: string | null
  country?: string | null
  language?: string | null
  isRemote?: boolean | null
  postedAt?: string | null
}

/** One count of a read: what was found outside the person's targets, at one employer, for one reason. */
export interface CountWrite {
  employer_id: string | null
  company_id: string | null
  kind: 'outside_targets'
  reason: OutsideReason
  n: number
}

/** Column changes for one stored job. Only the fields that differ are present. */
export interface JobUpdate {
  companyId: string
  /** The company's employer, when it has one: the stored row is the employer's, not the company's. */
  employerId?: string
  externalId: string
  fields: Record<string, unknown>
}

export interface SightingResult {
  seen: number
  reopened: number
  missed: number
  closed: number
}

/**
 * Storage adapter. The one implementation is lib/ats/store.ts (supabase-js):
 * with the user's session in the route (row level security applies) and with
 * the service role in scripts/ingest.ts. All methods may throw; refresh
 * isolates failures per company.
 */
export interface AtsStore {
  /** The company's stored jobs (paged internally); the employer's, when the company has one, since a role is shared by everyone who follows it. */
  listJobs(companyId: string, employerId?: string | null): Promise<ExistingJob[]>
  /**
   * Make room in a full company: delete the named stored roles that nothing
   * points at (an application, a draft...) and return the external ids it
   * deleted. Optional so a store that cannot keeps compiling; without it a
   * full company simply drops the roles that do not fit.
   */
  evictJobs?(companyId: string, externalIds: string[]): Promise<string[]>
  /** Insert new rows (on_conflict company_id,external_id, merge; employer rows on_conflict employer_id,posting_key). */
  upsertJobs(rows: JobUpsertRow[]): Promise<void>
  /**
   * Give the person the roles a read kept (person_roles), `hiddenIds` of them hidden because nothing
   * disagreed with their targets but a dimension could not be read. Optional so a store that cannot
   * (a test double) keeps compiling.
   */
  keepForPerson?(input: { userId: string; companyId: string; externalIds: string[]; hiddenIds: string[]; targetsVersion: number }): Promise<void>
  /** Record how many listed roles were outside the person's targets, by reason (person_counts); numbers, never rows. */
  setCounts?(userId: string, rows: CountWrite[]): Promise<void>
  /** Apply column changes to stored rows; returns how many rows changed. Never touches match data. */
  updateJobs(updates: JobUpdate[]): Promise<number>
  /**
   * Stamp what this refresh listed as seen, count a miss for the rest of the
   * given sources, close after two. Optional so a store that cannot (a test
   * double) keeps compiling.
   */
  recordSightings?(companyId: string, externalIds: string[], sources: string[]): Promise<SightingResult>
  /**
   * One refresh of a company at a time, across the scheduled run, the in-app
   * button and the autopilot. Returns false when someone else holds it.
   */
  acquireCompanyLock?(companyId: string): Promise<boolean>
  releaseCompanyLock?(companyId: string): Promise<void>
  /** Persist the full companies.metadata object. May throw 42703/PGRST204 when the column is missing — callers swallow it. */
  saveCompanyMetadata(companyId: string, metadata: Record<string, unknown>): Promise<void>
  updateCompanyLastScraped(companyId: string): Promise<void>
  /**
   * Remove the roles a provider wrote for a company whose board turned out not
   * to be theirs: delete the ones nothing points at, keep (and close) the ones
   * an application or draft references. Throws on failure, and then nothing
   * has changed.
   */
  clearBoardJobs(companyId: string, source: AtsProviderId): Promise<{ deleted: number; closed: number }>
}

/** Per-company result matching the frozen /api/jobs/refresh contract. */
export interface CompanyRefreshResult {
  companyId: string
  companyName: string
  provider: AtsProviderId | null
  found: number
  inserted: number
  /** Stored jobs whose description, title, location or pay changed at the source. */
  updated: number
  /** Jobs marked closed this refresh (two consecutive refreshes did not list them). */
  closed: number
  /** Closed jobs the source listed again. */
  reopened: number
  /** True when another refresh of this company was already running, so this one did nothing. */
  busy?: boolean
  /** Set when a stored guessed board failed verification and its roles were cleared. */
  cleared?: { deleted: number; closed: number }
  /** Listed roles not stored, by why (see ingest/reader/legit.ts), and roles left out by the per-company cap. */
  excluded?: Excluded & { capped: number }
  /** Stored roles given up to make room for better ones in a full company. */
  evicted?: number
  errors: string[]
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Read a valid cached ATS pointer out of companies.metadata, if any. */
export function readCachedAts(
  metadata: unknown
): { provider: AtsProviderId; token: string; source?: string; verifiedBy?: string } | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const ats = (metadata as Record<string, unknown>).ats
  if (!ats || typeof ats !== 'object' || Array.isArray(ats)) return null
  const record = ats as Record<string, unknown>
  const provider = record.provider
  const token = record.token
  // Checked against the registry rather than a hand-written literal list, so
  // adding a provider cannot silently leave stored pointers unreadable.
  if (typeof provider !== 'string' || !Object.prototype.hasOwnProperty.call(providers, provider)) return null
  if (!isValidToken(token)) return null
  return {
    provider: provider as AtsProviderId,
    token,
    source: typeof record.source === 'string' ? record.source : undefined,
    verifiedBy: typeof record.verified_by === 'string' ? record.verified_by : undefined,
  }
}

/**
 * Undo an upstream UTF-8-as-Latin-1 mis-decode in every text field.
 *
 * Cello's own transport is not what breaks this text — fetchJson()'s
 * Response.json() is a UTF-8 decode even when the server's Content-Type lies
 * about the charset, and the Greenhouse HTML→text chain round-trips "– · ’"
 * byte-exactly (both verified). What arrives already broken is what some
 * boards and every aggregator that republishes them *send*: "9:00 AM â[80][93]
 * 6:00 PM" instead of "9:00 AM – 6:00 PM". Repairing here — at the one choke
 * point every provider's jobs pass through, before classification and before
 * any row is written — means the classifier, the matcher, the stored row and
 * the UI all see the same repaired text. repairMojibake() returns text that is
 * already correct unchanged, so this is a no-op for the boards that get it
 * right (verified against 2,500+ stored Greenhouse/Lever/Ashby descriptions:
 * zero of them are touched).
 */
function repairJobText(job: AtsJob): AtsJob {
  return {
    ...job,
    title: repairMojibake(job.title),
    description: repairMojibake(job.description),
    location: repairMojibake(job.location),
    salary: repairMojibake(job.salary),
  }
}

/** Keep only http(s) jobs with a title and an absolute URL; dedup by URL. */
function sanitizeJobs(jobs: AtsJob[]): AtsJob[] {
  const seen = new Set<string>()
  const clean: AtsJob[] = []
  for (const job of jobs) {
    if (!job || typeof job.url !== 'string' || !job.url) continue
    if (typeof job.title !== 'string' || !job.title.trim()) continue
    let parsed: URL
    try {
      parsed = new URL(job.url)
    } catch {
      continue
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue
    const key = job.externalId || job.url
    if (seen.has(key)) continue
    seen.add(key)
    clean.push(repairJobText(job))
  }
  return clean
}

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex')
}

/** The sources whose rows one refresh of `provider` may count as missed. */
export function sourcesFor(provider: AtsProviderId): string[] {
  // The other readers' rows for this company are superseded once a board exists:
  // the ones the board does not list close, instead of lingering until the prune.
  return [provider, 'scraper', 'site_search', 'sitemap', 'listing']
}

/**
 * Refresh one company: resolve its ATS board (cached metadata -> careers URL
 * -> probe), fetch open roles, insert the ones we haven't seen, update the
 * stored ones whose description, title, location or pay changed at the source,
 * and record what was listed so a posting that stops being listed closes.
 *
 * Existing rows keep discovered_at, is_new and their match data; only the
 * columns that differ are written. Only one refresh of a company runs at a
 * time (the store's lock). Never throws: failures are reported in result.errors.
 */
export async function refreshCompany(store: AtsStore, company: CompanyInput, targets?: ReaderTargets): Promise<CompanyRefreshResult> {
  return withCompanyLock(store, company, async (result) => {
    const board = await refreshLocked(store, company, result, targets)
    await saveSourceCheck(store, company, board)
  })
}

/** A fresh result for `company`, before anything has been read. */
export function emptyResult(company: CompanyInput): CompanyRefreshResult {
  return {
    companyId: company.id,
    companyName: company.name,
    provider: null,
    found: 0,
    inserted: 0,
    updated: 0,
    closed: 0,
    reopened: 0,
    errors: [],
  }
}

/**
 * Run `fn` while holding the company's lock, so the scheduled run, the in-app
 * button and the autopilot never read the same company at once. When someone
 * else holds it, `fn` does not run and the result says `busy`.
 */
export async function withCompanyLock(
  store: AtsStore,
  company: CompanyInput,
  fn: (result: CompanyRefreshResult) => Promise<void>
): Promise<CompanyRefreshResult> {
  const result = emptyResult(company)
  if (store.acquireCompanyLock) {
    let got = false
    try {
      got = await store.acquireCompanyLock(company.id)
    } catch (error) {
      result.errors.push(`lock failed: ${errorMessage(error)}`)
      return result
    }
    if (!got) {
      result.busy = true
      return result
    }
  }
  try {
    await fn(result)
  } finally {
    try {
      await store.releaseCompanyLock?.(company.id)
    } catch {
      /* the lease expires on its own */
    }
  }
  return result
}

/** The company's stored jobs by external id; null (and an error on the result) when they cannot be listed. */
export async function loadStoredJobs(
  store: AtsStore,
  companyId: string,
  result: CompanyRefreshResult,
  employerId?: string | null
): Promise<Map<string, ExistingJob> | null> {
  try {
    return new Map((await store.listJobs(companyId, employerId)).map((job) => [job.externalId, job]))
  } catch (error) {
    result.errors.push(`listing existing jobs failed: ${errorMessage(error)}`)
    return null
  }
}

/**
 * What a board check learned about the company, for the metadata write that
 * ends a refresh (see saveSourceCheck): the metadata to keep, why no roles
 * could be read (or undefined), and whether the write must be skipped because
 * nothing was decided.
 */
export interface BoardCheck {
  meta: Record<string, unknown>
  unreadable?: string
  skipSave: boolean
}

/** Record what the attempt found in metadata.source_check, with any board it discovered: one metadata write per refresh. */
export async function saveSourceCheck(
  store: AtsStore,
  company: CompanyInput,
  board: BoardCheck,
  extra?: Record<string, unknown>
): Promise<void> {
  if (board.skipSave) return
  const check: Record<string, unknown> = { checked_at: new Date().toISOString(), readable: !board.unreadable, ...extra }
  if (board.unreadable) check.reason = board.unreadable
  board.meta.source_check = check
  try {
    await store.saveCompanyMetadata(company.id, board.meta)
  } catch {
    /* tolerated: the metadata column may not exist yet; detection simply runs again */
  }
}

export async function refreshLocked(
  store: AtsStore,
  company: CompanyInput,
  result: CompanyRefreshResult,
  targets?: ReaderTargets
): Promise<BoardCheck> {
  const meta: Record<string, unknown> =
    company.metadata && typeof company.metadata === 'object' && !Array.isArray(company.metadata)
      ? { ...(company.metadata as Record<string, unknown>) }
      : {}
  const board: BoardCheck = { meta, skipSave: false }

  // 0. What is stored already. Read first so a provider that needs a second
  //    request per posting (Workday, SmartRecruiters) spends it on the postings
  //    that have no description yet.
  const stored = await loadStoredJobs(store, company.id, result, company.employer_id)
  if (!stored) {
    board.skipSave = true
    return board
  }
  const query = targets ? searchTerms(targets) : []
  const ctx: FetchContext = { hasDescription: (id) => stored.get(id)?.descriptionMd5 != null, ...(query.length ? { query } : {}) }

  // 1. Resolve board + fetch jobs.
  let jobs: AtsJob[] | null = null
  let cachedFailed = false
  const cached = readCachedAts(company.metadata)
  if (cached) {
    result.provider = cached.provider
    try {
      jobs = await providers[cached.provider].fetch(cached.token, ctx)
    } catch (error) {
      // Cached board may have moved — fall through to fresh detection.
      result.errors.push(`cached ${cached.provider} board "${cached.token}" failed: ${errorMessage(error)}`)
      result.provider = null
      jobs = null
      cachedFailed = true
    }
  }

  // A board stored by an old guess is verified now. A pass records how; a fail
  // clears the mapping and its roles, then detection runs as for a new company.
  if (cached && jobs !== null && needsVerification(cached)) {
    try {
      const healed = await healStoredBoard(store, company, cached, jobs)
      if (healed.kept) {
        if (healed.verifiedBy) {
          const ats = meta.ats as Record<string, unknown>
          meta.ats = { ...ats, verified_by: healed.verifiedBy, verified_at: new Date().toISOString() }
        }
      } else {
        result.cleared = healed.cleared
        delete meta.ats
        result.provider = null
        jobs = null
        // The rows the board wrote are gone, so what is stored is stale.
        stored.clear()
      }
    } catch (error) {
      // Nothing was decided (the clear failed or could not run): change nothing, retry next refresh.
      result.errors.push(`board verification failed: ${errorMessage(error)}`)
      result.provider = null
      board.skipSave = true
      return board
    }
  }

  if (jobs === null) {
    let detected
    try {
      detected = await detectAts({
        careerUrl: company.career_url ?? null,
        domain: company.domain ?? null,
        name: company.name ?? null,
      })
    } catch (error) {
      // detectAts never throws by contract, but stay defensive.
      result.errors.push(`detection failed: ${errorMessage(error)}`)
      board.unreadable = 'no_supported_board'
      return board
    }
    if (!detected) {
      // provider stays null, so callers fall back to reading the site.
      board.unreadable = cachedFailed ? 'board_unreachable' : company.career_url?.trim() ? 'no_supported_board' : 'no_careers_url'
      return board
    }
    result.provider = detected.provider
    try {
      jobs = detected.jobs ?? (await providers[detected.provider].fetch(detected.token, ctx))
    } catch (error) {
      result.errors.push(`${detected.provider} fetch failed: ${errorMessage(error)}`)
      board.unreadable = 'board_unreachable'
      return board
    }
    // Persist the discovery (with how it was verified) so future runs skip probing.
    const ats: AtsMetadata = {
      provider: detected.provider,
      token: detected.token,
      source: detected.source,
      discovered_at: new Date().toISOString(),
      verified_by: detected.verifiedBy,
      verified_at: new Date().toISOString(),
    }
    meta.ats = ats
  }

  // Every path that reaches here set result.provider (cached or detected)
  // before assigning a non-null `jobs`; every path that leaves it null
  // returned early above.
  const provider: AtsProviderId = result.provider as AtsProviderId

  await syncJobs(store, company, jobs, {
    source: provider,
    sightingSources: sourcesFor(provider),
    cap: providers[provider].maxJobs,
    stored,
    judge: { name: company.name, domain: company.domain ?? null, careerUrl: company.career_url },
    targeting: targets?.targeting,
    ...(company.user_id ? { owner: { userId: company.user_id, targetsVersion: targets?.version ?? 0 }, titles: targets?.titles } : {}),
    windowed: providers[provider].searchesByQuery === true && query.length > 0,
  }, result)
  return board
}

export interface SyncOptions {
  /** jobs.source of rows this sync inserts. */
  source: string
  /** The sources whose stored rows a miss may be counted against. */
  sightingSources: string[]
  /** A channel that returns at most this many postings (see AtsProvider.maxJobs). */
  cap?: number
  stored: Map<string, ExistingJob>
  /** The company, so every role is judged the employer's own, open, unique and real before it is stored. */
  judge?: JudgeContext['company']
  /** The person's targets: roles inside them are stored first when the cap leaves some out. */
  targeting?: Targeting
  /** Every role the source listed, when that is more than `listed` (a sitemap lists what only a few pages were read for). Sightings use it. */
  listedIds?: string[]
  /** The list is a window onto the board (a search, a few pages): a role missing from it is not thereby gone. */
  windowed?: boolean
  /** The person the roles are kept for, and the version of their targets. Without it nothing is kept per person. */
  owner?: { userId: string; targetsVersion: number }
  /** The role titles the person typed: with the targets, they decide what is kept. */
  titles?: readonly string[]
}

/** jobs.source_tier of what a source wrote. */
export function tierOfSource(source: string): SourceTier {
  if (source === 'site_search' || source === 'sitemap' || source === 'listing') return source
  if (source === 'scraper') return 'rendered'
  return Object.prototype.hasOwnProperty.call(providers, source) ? 'board' : 'listing'
}

/**
 * Everything after a source has listed a company's postings: dedupe, insert the
 * new ones with their requirements read, update stored ones that changed, and
 * record what was listed so a posting that stops being listed closes. The ATS
 * refresh and the page reader both end here, so a job means the same thing
 * whichever way it was found.
 */
export async function syncJobs(
  store: AtsStore,
  company: CompanyInput,
  listed: AtsJob[],
  opts: SyncOptions,
  result: CompanyRefreshResult
): Promise<void> {
  const { stored } = opts
  // Dedup intra-run and count.
  // A posting dated more than ROLE_MAX_AGE_DAYS ago is not an open role.
  // Roles the source lists that are not open roles of this employer (stale, expired, agency, repost, other employer, non-role)
  // are not sighted either, so a stored one of them misses and closes instead of being kept open by the listing.
  const notOpen = new Set<string>()
  let tooOld = 0
  const clean = sanitizeJobs(listed).filter((job) => {
    if (!isStalePosting(job.postedAt)) return true
    notOpen.add(job.externalId)
    tooOld++
    return false
  })
  result.found = clean.length
  const excluded = { ...emptyExcluded(), capped: 0 }
  if (opts.judge) result.excluded = excluded
  if (clean.length === 0 && notOpen.size === 0) {
    // Nothing listed is not evidence that anything closed: an empty answer looks
    // the same as a board that failed to load, so no sighting is recorded.
    try {
      await store.updateCompanyLastScraped(company.id)
    } catch (error) {
      result.errors.push(`last_scraped_at update failed: ${errorMessage(error)}`)
    }
    return
  }

  const now = new Date().toISOString()
  // ATS boards are structured/official data, so garbage titles are rare — but
  // a badly-configured board (a "location" page listed as a posting, etc.)
  // can still slip through, so every row runs through the same classifier
  // gate as the scraper/aggregator paths rather than trusting the source.
  const classify = (job: AtsJob) => {
    const title = job.title.trim()
    const c = classifyJob({ title, description: job.description, location: job.location, companyName: company.name })
    return { job, title, c }
  }

  // 3. Insert only unseen rows, so re-runs create 0 duplicates and existing
  //    rows keep their discovered_at / is_new / match data.
  // Judged the employer's own, open, unique and real (once, here, whatever tier read it).
  let candidates = clean
  if (opts.judge) {
    const ctx: JudgeContext = { company: opts.judge }
    candidates = candidates.filter((job) => {
      const verdict = judgeRole(job, ctx)
      if (!verdict.keep) {
        excluded[verdict.why]++
        notOpen.add(job.externalId)
      }
      return verdict.keep
    })
    const storedRoles = [...stored.values()].map((s) => ({ title: s.title, location: s.location, source: s.source, open: s.open, externalId: s.externalId }))
    const deduped = dedupeRoles(candidates, storedRoles, opts.source)
    excluded.duplicate += deduped.duplicates
    candidates = deduped.kept
  }

  // At most MAX_ROLES_PER_COMPANY rows per company, open and closed together, the ones inside the person's targets first.
  // A closed row holds a slot until it is given up, so churn cannot pile rows up on top of the cap.
  const openStoredRows = [...stored.values()].filter((s) => s.open !== false)
  let room = Math.max(0, MAX_ROLES_PER_COMPANY - stored.size)
  const targeting = opts.targeting ?? EMPTY_TARGETING
  const fresh = candidates.filter((job) => !stored.has(job.externalId)).map(classify).filter(({ c }) => !c.rejectReason && !isLowQuality(c))
  let ranked = orderForCap(fresh, ({ job, c }) =>
    targetVerdict(
      { title: job.title, description: job.description, job_function: c.jobFunction, seniority: c.seniority, country: c.country, language: c.language, is_remote: c.isRemote },
      targeting,
      company.name
    ),
    ({ job }) => job.postedAt
  )
  // Only roles inside the person's stated targets are stored, and the rest are counted by why. With no
  // targets stated the followed employer keeps up to the cap, as before, and those roles are marked
  // by targets version 0. A role nothing disagrees with, whose place or level could not be read, is
  // kept hidden for the person.
  const personTargets = { targeting, titles: opts.titles ?? [] }
  const filtering = Boolean(opts.owner) && hasPersonTargets(personTargets)
  const outside: Record<OutsideReason, number> = { place: 0, age: tooOld, excluded: 0, level: 0, title: 0 }
  const hiddenIds = new Set<string>()
  if (filtering) {
    const prepared = prepareTargets(personTargets.titles)
    ranked = ranked.filter(({ job, c }) => {
      const verdict = judgeForPerson(
        { title: job.title, description: job.description, job_function: c.jobFunction, seniority: c.seniority, country: c.country, language: c.language, is_remote: c.isRemote, postedAt: job.postedAt },
        personTargets,
        company.name,
        prepared
      )
      if (!verdict.keep) {
        outside[verdict.reason]++
        return false
      }
      if (verdict.hidden) hiddenIds.add(job.externalId)
      return true
    })
  }
  // Closed roles go first, oldest first: the ones nothing points at are deleted, the rest stay and count.
  const closedStoredRows = [...stored.values()].filter((s) => s.open === false)
  if (ranked.length > room && store.evictJobs && closedStoredRows.length > 0) {
    const oldest = closedStoredRows
      .sort((a, b) => (a.lastSeenAt ?? '').localeCompare(b.lastSeenAt ?? ''))
      .slice(0, ranked.length - room)
      .map((s) => s.externalId)
    try {
      const gone = await store.evictJobs(company.id, oldest)
      room += gone.length
      for (const id of gone) stored.delete(id)
      result.evicted = (result.evicted ?? 0) + gone.length
    } catch (error) {
      result.errors.push(`making room failed: ${errorMessage(error)}`)
    }
  }
  // A full company still takes a role inside the targets: new and stored open roles are ranked together,
  // and the stored ones that lose are given up (those nothing points at; the others stay and count).
  if (ranked.length > room && store.evictJobs && ranked.length > 0) {
    type Entry = { id: string; stored: boolean }
    const pool: { entry: Entry; verdict: TargetVerdict; at?: string }[] = [
      ...openStoredRows.map((s) => ({
        entry: { id: s.externalId, stored: true },
        verdict: targetVerdict(
          { title: s.title, description: '', job_function: s.jobFunction, seniority: s.seniority, country: s.country, language: s.language, is_remote: s.isRemote },
          targeting,
          company.name
        ),
        // A stored role with no date is not older than a new one: it has been listed as recently as anything.
        at: s.postedAt ?? now,
      })),
      ...ranked.map(({ job, c }) => ({
        entry: { id: job.externalId, stored: false },
        verdict: targetVerdict(
          { title: job.title, description: job.description, job_function: c.jobFunction, seniority: c.seniority, country: c.country, language: c.language, is_remote: c.isRemote },
          targeting,
          company.name
        ),
        at: job.postedAt,
      })),
    ]
    // Stored first, so on a tie nothing is swapped.
    const closedLeft = stored.size - openStoredRows.length
    const kept = new Set(orderForCap(pool, (p) => p.verdict, (p) => p.at).slice(0, Math.max(0, MAX_ROLES_PER_COMPANY - closedLeft)).map((p) => p.entry.id))
    const losers = openStoredRows.filter((s) => !kept.has(s.externalId)).map((s) => s.externalId)
    if (losers.length > 0) {
      try {
        const gone = await store.evictJobs(company.id, losers)
        room += gone.length
        for (const id of gone) stored.delete(id)
        result.evicted = (result.evicted ?? 0) + gone.length
      } catch (error) {
        result.errors.push(`making room failed: ${errorMessage(error)}`)
      }
    }
  }
  excluded.capped = Math.max(0, ranked.length - room)
  const newRows: JobUpsertRow[] = ranked
    .slice(0, room)
    .map(({ job, title, c }) => ({
      company_id: company.id,
      ...(company.employer_id ? { employer_id: company.employer_id } : {}),
      title,
      description: (job.description ?? '').slice(0, MAX_DESCRIPTION_CHARS),
      url: job.url,
      location: job.location ?? null,
      salary_range: job.salary ?? null,
      posted_at: job.postedAt ?? null,
      external_id: job.externalId,
      is_new: true,
      discovered_at: now,
      job_function: c.jobFunction,
      seniority: c.seniority,
      language: c.language,
      country: c.country,
      is_remote: c.isRemote,
      job_type: c.jobType,
      quality_score: c.qualityScore,
      source: opts.source,
      source_tier: tierOfSource(opts.source),
      last_seen_at: now,
      requirements: parseRequirements({
        title,
        description: job.description ?? '',
        location: job.location,
        salaryRange: job.salary,
      }),
      requirements_extracted_at: now,
    }))

  if (newRows.length > 0) {
    try {
      await store.upsertJobs(newRows)
      result.inserted = newRows.length
    } catch (error) {
      result.errors.push(`upsert failed: ${errorMessage(error)}`)
      return
    }
  }

  // The roles this read kept are the person's: one person_roles row each, beside the old reads.
  if (opts.owner && store.keepForPerson && newRows.length > 0) {
    try {
      await store.keepForPerson({
        userId: opts.owner.userId,
        companyId: company.id,
        externalIds: newRows.map((r) => r.external_id),
        hiddenIds: [...hiddenIds],
        targetsVersion: filtering ? opts.owner.targetsVersion : 0,
      })
    } catch (error) {
      result.errors.push(`person roles failed: ${errorMessage(error)}`)
    }
  }
  // What was left out is a number. A read of the employer replaces that day's numbers for it, every reason sent so a zero resets.
  if (filtering && opts.owner && store.setCounts) {
    const employerId = company.employer_id ?? null
    try {
      await store.setCounts(
        opts.owner.userId,
        (Object.keys(outside) as OutsideReason[]).map((reason) => ({
          employer_id: employerId,
          company_id: employerId ? null : company.id,
          kind: 'outside_targets' as const,
          reason,
          n: outside[reason],
        }))
      )
    } catch (error) {
      result.errors.push(`counts failed: ${errorMessage(error)}`)
    }
  }

  // 4. Update stored rows that changed at the source. The source is the
  //    employer's own posting, so its text wins over what an aggregator or an
  //    older version of this code stored; a field the source did not supply is
  //    left alone rather than blanked.
  const updates: JobUpdate[] = []
  for (const job of clean) {
    if (notOpen.has(job.externalId)) continue
    const have = stored.get(job.externalId)
    if (!have) continue
    const fields: Record<string, unknown> = {}
    const title = job.title.trim()
    if (title && title !== have.title) fields.title = title
    if (job.location && job.location !== have.location) fields.location = job.location
    if (job.salary && job.salary !== have.salaryRange) fields.salary_range = job.salary
    const description = (job.description ?? '').trim().slice(0, MAX_DESCRIPTION_CHARS)
    if (description && md5(description) !== have.descriptionMd5) {
      fields.description = description
      fields.requirements = parseRequirements({
        title: title || have.title,
        description,
        location: job.location ?? have.location,
        salaryRange: job.salary ?? have.salaryRange,
      })
      fields.requirements_extracted_at = now
    }
    if (Object.keys(fields).length > 0) updates.push({ companyId: company.id, ...(company.employer_id ? { employerId: company.employer_id } : {}), externalId: job.externalId, fields })
  }
  if (updates.length > 0) {
    try {
      result.updated = await store.updateJobs(updates)
    } catch (error) {
      result.errors.push(`update failed: ${errorMessage(error)}`)
    }
  }

  // 5. Record what was listed. A provider that returns a capped window (Workday,
  //    SmartRecruiters) cannot say a posting past the cap is gone, so a list that
  //    reached the cap stamps what it saw and counts no misses.
  if (store.recordSightings) {
    const windowed = opts.windowed === true || (typeof opts.cap === 'number' && clean.length >= opts.cap)
    try {
      const sighted = await store.recordSightings(
        company.id,
        (opts.listedIds ?? clean.map((j) => j.externalId)).filter((id) => !notOpen.has(id)),
        windowed ? [] : opts.sightingSources
      )
      result.closed = sighted.closed
      result.reopened = sighted.reopened
    } catch (error) {
      result.errors.push(`recording sightings failed: ${errorMessage(error)}`)
    }
  }

  try {
    await store.updateCompanyLastScraped(company.id)
  } catch (error) {
    result.errors.push(`last_scraped_at update failed: ${errorMessage(error)}`)
  }
}

// Implementation moved to ./concurrency.ts so the adapters can use it without
// importing this module back; re-exported here so every existing caller
// (`import { mapWithConcurrency } from '@/lib/ats'`) keeps working.
export { mapWithConcurrency } from './concurrency'
