// One coordinated check of a user's companies.
//
// Per company, under the shared per-company lock: the job board's API when the
// company has one (the nine adapters in lib/ats), else the one reader
// (lib/ingest/reader): its own search, its sitemaps, its server-rendered lists,
// and in the scheduled pass the rendered page and a model. All end in the same
// sync (syncJobs), so a job means the same thing whichever way it was found. Per user, after the
// companies: the requirements pass, then one ingestion_runs row that the app
// shows as "Find new roles".
//
// Pure over injected dependencies (a store, a page fetcher, a model, a clock),
// so every path here is testable without a database, a network or a model.

import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  emptyResult,
  loadStoredJobs,
  mapWithConcurrency,
  providers,
  refreshLocked,
  saveSourceCheck,
  sourcesFor,
  syncJobs,
  withCompanyLock,
  type AtsStore,
  type CompanyInput,
  type CompanyRefreshResult,
  type ExistingJob,
} from '../ats/index'
import { isKnownEmployer } from '../companies/known-companies'
import { dueAt, readSourceCheck } from '../companies/roles-status'
import type { AtsMetadata, AtsProviderId } from '../ats/types'
import { verifyBoard } from '../ats/verify'
import type { FetchPage } from './fetch-page'
import type { ModelBudget, ModelCall } from './model'
import type { ReadReason } from './page-reader'
import { readSite, type SiteDeps, type SiteRead, type Tier } from './reader'
import { makeSiteFetcher, ReaderError, type ReaderMode, type ReaderReason, type SiteFetcher } from './reader/site-fetch'
import { NO_TARGETS, searchTerms, type ReaderTargets } from './reader/targets'
import { recheckStoredRoles } from './reader/recheck'
import { runRequirementsPass, type RequirementsRows } from './requirements-pass'

type Db = SupabaseClient<any, any, any>

export type FailureReason = 'board_error' | ReadReason | Exclude<ReaderReason, 'reading'> | 'time'
export type Reader = AtsProviderId | 'page_reader' | Exclude<Tier, 'board' | 'model' | 'rendered'>

export interface DueCompany extends CompanyInput {
  user_id: string
  scrape_frequency: number | null
  last_scraped_at: string | null
  is_dream_company: boolean | null
}

export interface CompanyOutcome {
  result: CompanyRefreshResult
  /** What read it: a job board's provider, a way of reading the site, or null when nothing could (no board, no careers page). */
  reader: Reader | null
  /** The tier that yielded the roles (board, site_search, sitemap, listing, rendered, model). */
  tier: Tier | null
  /** No board and no careers page to read: nothing to do, which is not a failure. */
  skipped: boolean
  /** Only the rendered tier is left, and it runs in the scheduled pass: the company says Cello is reading its site. */
  reading: boolean
  /** A pasted link of a staffing agency or reposting site, in words. */
  message?: string
  failure: FailureReason | null
}

export interface CompanyDeps {
  /** The rendered page (a browser); used in the scheduled pass only. */
  fetchPage: FetchPage
  model: ModelCall | null
  fetchDetail?: (url: string) => Promise<string>
  /** inline: the person is waiting (plain requests only). scheduled: the background pass. Default inline. */
  mode?: ReaderMode
  /** What the person is looking for: drives every site's search and the cap's ordering. */
  targets?: ReaderTargets
  /** The one door to company sites. Default: a fresh one for the mode. */
  fetcher?: SiteFetcher
}

// --- when a company is due -------------------------------------------------

/** Dream companies after an hour, the rest after a day (a larger scrape_frequency stretches that; the pass itself runs every six hours); a site still to be read in a browser is always due. */
export function isDue(
  company: Pick<DueCompany, 'last_scraped_at' | 'is_dream_company' | 'scrape_frequency'> & { metadata?: unknown },
  now: number
): boolean {
  // A site still to be read in a browser, or whose browser step failed, is tried again at the next scheduled pass.
  const reason = readSourceCheck(company.metadata)?.reason
  if (reason === 'reading' || reason === 'budget' || reason === 'render_failed' || reason === 'read_failed' || reason === 'model_unavailable' || reason === 'model_limit') return true
  return now >= dueAt(company)
}

/** A company has something to read: a careers page, or a board already stored. */
export function hasSource(company: Pick<DueCompany, 'career_url'> & { metadata?: unknown }): boolean {
  return Boolean(company.career_url?.trim()) || Boolean((company.metadata as { ats?: unknown } | null)?.ats)
}

/** A read that listed nothing and reported errors, or listed postings it could not store. */
function boardFailed(result: CompanyRefreshResult): boolean {
  if (result.errors.length === 0) return false
  return result.found === 0 || result.errors.some((e) => e.startsWith('upsert failed'))
}

// --- what the reader remembers about a company ------------------------------

const MAX_CHECKED = 2000
const CHECKED_TTL_MS = 14 * 86_400_000
const short = (id: string) => createHash('sha1').update(id).digest('hex').slice(0, 12)

interface ReaderState {
  /** Short hashes of the role addresses already read or rejected (at most MAX_CHECKED, oldest dropped). */
  checked: string[]
  /** The search words the list was built under: a new target starts a new list. */
  targets_key: string
  at: string
  /** Role pages read so far under these targets (for "Read N of about M"). Not reset with the checked list. */
  read: number
  /** Roles the site's own list named at the last read, when the way of reading sees a list. */
  listed?: number
  /** The list carries no titles, so roles are known only once their pages are read. */
  untitled?: boolean
  /** The read saw a window onto the site (its search, a few listing pages), not all of it. */
  window?: boolean
}

function readerState(metadata: unknown, targetsKey: string, now: number): ReaderState {
  const raw = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).reader : null
  const r = raw && typeof raw === 'object' ? (raw as Partial<ReaderState>) : {}
  const fresh = r.targets_key === targetsKey && typeof r.at === 'string' && now - Date.parse(r.at) < CHECKED_TTL_MS && Array.isArray(r.checked)
  return {
    checked: fresh ? (r.checked as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    targets_key: targetsKey,
    at: fresh ? (r.at as string) : new Date(now).toISOString(),
    read: r.targets_key === targetsKey && typeof r.read === 'number' && r.read >= 0 ? r.read : 0,
    // What the last read saw of the site's own list, kept while a later read cannot see it again.
    ...(typeof r.listed === 'number' ? { listed: r.listed } : {}),
    ...(r.untitled === true ? { untitled: true } : {}),
    ...(r.window === true ? { window: true } : {}),
  }
}

// --- one company -----------------------------------------------------------

/** Verify a board the company's own site pointed at, and read its roles with the person's search words. */
function boardReader(company: DueCompany, stored: Map<string, ExistingJob>): NonNullable<SiteDeps['readBoard']> {
  return async (candidate, query) => {
    const provider = providers[candidate.provider]
    if (!provider) return null
    let jobs
    try {
      jobs = await provider.fetch(candidate.token, { hasDescription: (id) => stored.get(id)?.descriptionMd5 != null, ...(query.length ? { query } : {}) })
    } catch (error) {
      // The board answered with an error (a rate limit, a timeout): not "no board", so the company says it did not answer rather than "reading".
      // A robots.txt rule or a bot check keeps its own reason.
      throw error instanceof ReaderError && (error.reason === 'robots' || error.reason === 'bot_check') ? error : new ReaderError('unreachable')
    }
    if (jobs.length === 0) return null
    if (candidate.via === 'url') return { ...candidate, jobs, verifiedBy: 'careers_url' }
    // Found through the company's own site, then held to the same proof as any board.
    const verifiedBy = await verifyBoard({
      provider: candidate.provider,
      token: candidate.token,
      jobs,
      company: { name: company.name, domain: company.domain },
      pageBoards: [{ provider: candidate.provider, token: candidate.token }],
      knownEmployer: isKnownEmployer({ domain: company.domain, name: company.name, careerUrl: company.career_url }),
    })
    return verifiedBy ? { ...candidate, jobs, verifiedBy } : null
  }
}

const SOURCE_OF: Record<Exclude<Tier, 'board'>, string> = {
  site_search: 'site_search',
  sitemap: 'sitemap',
  listing: 'listing',
  rendered: 'scraper',
  model: 'scraper',
}

export async function ingestCompany(store: AtsStore, company: DueCompany, deps: CompanyDeps): Promise<CompanyOutcome> {
  const outcome: CompanyOutcome = { result: emptyResult(company), reader: null, tier: null, skipped: false, reading: false, failure: null }
  const mode = deps.mode ?? 'inline'
  const targets = deps.targets ?? NO_TARGETS

  outcome.result = await withCompanyLock(store, company, async (result) => {
    // 1. A job board: the one stored, the one the careers link names, or one the
    //    company's own pages link to, each verified as the company's (lib/ats).
    const board = await refreshLocked(store, company, result, targets)
    if (result.provider) {
      outcome.reader = result.provider
      outcome.tier = 'board'
      if (boardFailed(result)) outcome.failure = 'board_error'
      // A board searched with the person's words (Workday, Eightfold) shows a window onto it, never the whole board: say so. Any note left by an earlier way of reading goes.
      const words = searchTerms(targets)
      const stale = board.meta.reader && typeof board.meta.reader === 'object' ? (board.meta.reader as Record<string, unknown>) : null
      if (providers[result.provider].searchesByQuery === true && words.length > 0) {
        board.meta.reader = { checked: [], targets_key: words.join('|'), at: new Date().toISOString(), read: 0, window: true, tier: 'board', tried: [] }
      } else if (stale) {
        const { window: _w, listed: _l, untitled: _u, ...rest } = stale
        board.meta.reader = rest
      }
      await saveSourceCheck(store, company, board, { tier: 'board' })
      return
    }
    if (result.errors.length > 0) {
      // A board that is known and failed, or a store that could not be read: not a reason to switch to reading the site.
      outcome.failure = 'board_error'
      await saveSourceCheck(store, company, board)
      return
    }

    // 2. No board. Read the site, if there is one. A throw here must not leave the company on a stale
    //    status ("Cello is reading this site" for ever): it is recorded as a failed read the next pass retries.
    try {
      const careerUrl = company.career_url?.trim()
      if (!careerUrl) {
        outcome.skipped = true
        try {
          await store.updateCompanyLastScraped(company.id)
        } catch {
          /* checked again next time */
        }
        await saveSourceCheck(store, company, board)
        return
      }
      const stored = await loadStoredJobs(store, company.id, result)
      if (!stored) {
        outcome.failure = 'board_error'
        return
      }

      const now = Date.now()
      const state = readerState(company.metadata, searchTerms(targets).join('|'), now)
      const checkedSet = new Set(state.checked)
      // A stored role with no description or no place is read again once per window (marked 'h'), so rows stored before the reader learned a site's data fill in.
      const incomplete = new Set([...stored.values()].filter((s) => !s.descriptionMd5 || !s.location).map((s) => s.externalId))
      const mark = (id: string) => (incomplete.has(id) ? `${short(id)}h` : short(id))
      const fetcher = deps.fetcher ?? makeSiteFetcher({ mode })
      const read: SiteRead = await readSite(
        {
          company: { name: company.name, domain: company.domain, careerUrl },
          targets,
          checked: { has: (id: string) => checkedSet.has(mark(id)) } as ReadonlySet<string>,
          storedIds: new Set([...stored.keys()].filter((id) => !incomplete.has(id))),
        },
        { fetcher, readBoard: boardReader(company, stored), fetchPage: mode === 'scheduled' ? deps.fetchPage : undefined, model: deps.model, renderedLater: mode === 'inline' }
      )

      outcome.tier = read.tier
      for (const id of read.checked) if (!checkedSet.has(mark(id))) state.checked.push(mark(id))
      state.checked = state.checked.slice(-MAX_CHECKED)
      if (read.tier) {
        state.read += read.checked.length
        // Whether the person has seen the whole site or part of it, and how big the part is: a partial read must say so.
        state.listed = read.listed
        state.untitled = read.untitled === true ? true : undefined
        // A board searched with the person's words (Eightfold, a few pages of each word) shows a window too, never the whole board.
        const searched = read.tier === 'board' && read.board ? providers[read.board.provider].searchesByQuery === true && searchTerms(targets).length > 0 : false
        state.window = read.tier === 'site_search' || read.tier === 'listing' || searched ? true : undefined
        if (state.listed === undefined) delete state.listed
        if (state.untitled === undefined) delete state.untitled
        if (state.window === undefined) delete state.window
      }
      board.meta.reader = { ...state, tier: read.tier, tried: read.tried.slice(0, 8) }

      if (!read.tier) {
        outcome.message = read.message
        outcome.reading = read.reason === 'reading'
        if (read.reason && read.reason !== 'reading') outcome.failure = read.reason as FailureReason
        board.unreadable = read.reason ?? 'no_roles'
        try {
          await store.updateCompanyLastScraped(company.id)
        } catch {
          /* checked again next time */
        }
        await saveSourceCheck(store, company, board, { requests: read.requests, ...(read.message ? { message: read.message } : {}) })
        return
      }

      board.unreadable = undefined
      // A pasted posting says what it could not read (no place on its page).
      if (read.message) outcome.message = read.message
      const judge = { name: company.name, domain: company.domain ?? null, careerUrl }
      if (read.board) {
        const b = read.board
        const at = new Date().toISOString()
        const ats: AtsMetadata = {
          provider: b.provider,
          token: b.token,
          source: 'probe',
          discovered_at: at,
          verified_by: b.verifiedBy as AtsMetadata['verified_by'],
          verified_at: at,
        }
        board.meta.ats = ats
        result.provider = b.provider
        outcome.reader = b.provider
        await syncJobs(
          store,
          company,
          read.jobs,
          {
            source: b.provider,
            sightingSources: sourcesFor(b.provider),
            cap: providers[b.provider].maxJobs,
            stored,
            judge,
            targeting: targets.targeting,
            windowed: providers[b.provider].searchesByQuery === true && searchTerms(targets).length > 0,
          },
          result
        )
      } else {
        const tier = read.tier as Exclude<Tier, 'board'>
        const source = SOURCE_OF[tier]
        outcome.reader = tier === 'rendered' || tier === 'model' ? 'page_reader' : tier
        // A page's rows close only on a complete read of it; a sitemap lists every role even when few were read.
        await syncJobs(
          store,
          company,
          read.jobs,
          { source, sightingSources: read.complete ? [source] : [], stored, judge, targeting: targets.targeting, listedIds: read.listedIds, windowed: !read.complete },
          result
        )
        // A window onto the site never counts a role as missed, so the scheduled pass asks a few stored roles' own pages whether they are still there.
        if (mode === 'scheduled' && !read.complete) {
          const seen = new Set(read.listedIds ?? read.jobs.map((j) => j.externalId))
          const again = await recheckStoredRoles(store, company.id, stored, fetcher, { sources: [source], seen, byTitle: source === 'listing' || source === 'sitemap' })
          result.closed += again.closed
        }
      }
      if (boardFailed(result)) outcome.failure = 'board_error'
      await saveSourceCheck(store, company, board, { tier: read.tier, requests: read.requests })
    } catch {
      outcome.failure = 'board_error'
      board.unreadable = 'read_failed'
      await saveSourceCheck(store, company, board)
    }
  })

  return outcome
}

// --- one user --------------------------------------------------------------

export interface RunRow {
  batch_id: string
  user_id: string
  trigger: 'schedule' | 'manual'
  companies_total: number
}

export interface RunPatch {
  status: 'succeeded' | 'partial' | 'failed'
  partial_reason: 'time' | 'model_limit' | 'errors' | null
  finished_at: string
  duration_ms: number
  companies_checked: number
  companies_failed: number
  jobs_found: number
  jobs_new: number
  jobs_updated: number
  jobs_closed: number
  by_provider: Record<string, ProviderTotals>
  failures_by_provider: Record<string, number>
  failed_companies: { company_id: string; provider: string; reason: FailureReason }[]
  model_calls: number
}

export interface ProviderTotals {
  companies: number
  found: number
  new: number
  updated: number
  closed: number
  failed: number
}

export interface RunsStore {
  /** Insert the row as 'running' and return its id, or null when it could not be written (the check goes on). */
  start(row: RunRow): Promise<string | null>
  finish(id: string, patch: RunPatch): Promise<void>
}

export function makeSupabaseRunsStore(db: Db, dryRun = false): RunsStore {
  return {
    async start(row) {
      if (dryRun) return null
      // Status lines older than 30 days are of no use: about 4 rows a day per person, so at most about 120 are kept.
      const keepSince = new Date(Date.now() - 30 * 86_400_000).toISOString()
      await db.from('ingestion_runs').delete().eq('user_id', row.user_id).lt('started_at', keepSince)
      const { data, error } = await db.from('ingestion_runs').insert({ ...row, status: 'running' }).select('id').single()
      if (error) return null
      return (data as { id: string }).id
    },
    async finish(id, patch) {
      if (dryRun) return
      await db.from('ingestion_runs').update(patch as never).eq('id', id)
    },
  }
}

export interface UserDeps extends CompanyDeps {
  store: AtsStore
  runs: RunsStore
  requirements: RequirementsRows | null
  budget: ModelBudget
  /** Epoch ms; companies not started by then are reported as not reached. */
  deadlineAt: number
  now?: () => number
  concurrency?: number
}

export interface UserSummary {
  runId: string | null
  patch: RunPatch
  outcomes: CompanyOutcome[]
}

const MAX_FAILED_LISTED = 50

function totalsFor(outcomes: CompanyOutcome[]): Record<string, ProviderTotals> {
  const out: Record<string, ProviderTotals> = {}
  for (const o of outcomes) {
    if (!o.reader || o.result.busy) continue
    const t = (out[o.reader] ??= { companies: 0, found: 0, new: 0, updated: 0, closed: 0, failed: 0 })
    t.companies++
    t.found += o.result.found
    t.new += o.result.inserted
    t.updated += o.result.updated
    t.closed += o.result.closed
    if (o.failure) t.failed++
  }
  return out
}

export async function ingestUser(
  userId: string,
  companies: DueCompany[],
  deps: UserDeps,
  opts: { batchId: string; trigger?: 'schedule' | 'manual' }
): Promise<UserSummary> {
  const now = deps.now ?? Date.now
  const startedAt = now()
  const startBudget = deps.budget.n
  const runId = await deps.runs.start({
    batch_id: opts.batchId,
    user_id: userId,
    trigger: opts.trigger ?? 'schedule',
    companies_total: companies.length,
  })

  // Dream companies first, so a deadline cuts the least wanted ones.
  const ordered = [...companies].sort((a, b) => Number(Boolean(b.is_dream_company)) - Number(Boolean(a.is_dream_company)))
  const outcomes = await mapWithConcurrency(ordered, deps.concurrency ?? 4, async (company): Promise<CompanyOutcome> => {
    if (now() >= deps.deadlineAt) {
      return { result: emptyResult(company), reader: null, tier: null, skipped: false, reading: false, failure: 'time' }
    }
    try {
      return await ingestCompany(deps.store, company, deps)
    } catch {
      // ingestCompany isolates its own failures; this is the last guard so one company cannot end the pass.
      // The company still gets a status, so it never stays on "Cello is reading this site".
      const meta = company.metadata && typeof company.metadata === 'object' && !Array.isArray(company.metadata) ? { ...(company.metadata as Record<string, unknown>) } : {}
      await saveSourceCheck(deps.store, company, { meta, unreadable: 'read_failed', skipSave: false }).catch(() => undefined)
      return { result: emptyResult(company), reader: null, tier: null, skipped: false, reading: false, failure: 'board_error' }
    }
  })

  let reqLimited = false
  if (deps.requirements && deps.model && now() < deps.deadlineAt) {
    const pass = await runRequirementsPass(deps.requirements, deps.model, deps.budget)
    reqLimited = pass.limited
  }

  const failed = outcomes.filter((o) => o.failure)
  const timed = failed.some((o) => o.failure === 'time')
  const limited = deps.budget.hit || reqLimited || failed.some((o) => o.failure === 'model_limit')
  const failuresByProvider: Record<string, number> = {}
  for (const o of failed) {
    const key = o.failure === 'time' ? 'not_reached' : (o.reader ?? 'unknown')
    failuresByProvider[key] = (failuresByProvider[key] ?? 0) + 1
  }

  const patch: RunPatch = {
    status: companies.length > 0 && failed.length === companies.length ? 'failed' : failed.length > 0 || timed || limited ? 'partial' : 'succeeded',
    partial_reason: timed ? 'time' : limited ? 'model_limit' : failed.length > 0 ? 'errors' : null,
    finished_at: new Date(now()).toISOString(),
    duration_ms: Math.max(0, now() - startedAt),
    companies_checked: outcomes.length - failed.length,
    companies_failed: failed.length,
    jobs_found: outcomes.reduce((n, o) => n + o.result.found, 0),
    jobs_new: outcomes.reduce((n, o) => n + o.result.inserted, 0),
    jobs_updated: outcomes.reduce((n, o) => n + o.result.updated, 0),
    jobs_closed: outcomes.reduce((n, o) => n + o.result.closed, 0),
    by_provider: totalsFor(outcomes),
    failures_by_provider: failuresByProvider,
    failed_companies: failed
      .slice(0, MAX_FAILED_LISTED)
      .map((o) => ({
        company_id: o.result.companyId,
        provider: o.failure === 'time' ? 'not_reached' : (o.reader ?? 'unknown'),
        reason: o.failure as FailureReason,
      })),
    model_calls: Math.max(0, startBudget - deps.budget.n),
  }
  if (runId) {
    try {
      await deps.runs.finish(runId, patch)
    } catch {
      /* the row stays 'running' and the app reads a stale one as failed */
    }
  }
  return { runId, patch, outcomes }
}
