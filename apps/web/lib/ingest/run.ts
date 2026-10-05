// One coordinated check of a user's companies.
//
// Per company, under the shared per-company lock: the job board's API when the
// company has one (all eight adapters in lib/ats), else the careers page
// (lib/ingest/page-reader.ts). Both end in the same sync (syncJobs), so a job
// means the same thing whichever way it was found. Per user, after the
// companies: the requirements pass, then one ingestion_runs row that the app
// shows as "Find new roles".
//
// Pure over injected dependencies (a store, a page fetcher, a model, a clock),
// so every path here is testable without a database, a network or a model.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  emptyResult,
  loadStoredJobs,
  mapWithConcurrency,
  refreshLocked,
  syncJobs,
  withCompanyLock,
  type AtsStore,
  type CompanyInput,
  type CompanyRefreshResult,
} from '../ats/index'
import type { AtsProviderId } from '../ats/types'
import type { FetchPage } from './fetch-page'
import type { ModelBudget, ModelCall } from './model'
import { readCareersPage, type ReadReason } from './page-reader'
import { runRequirementsPass, type RequirementsRows } from './requirements-pass'

type Db = SupabaseClient<any, any, any>

export type FailureReason = 'board_error' | ReadReason | 'time'
export type Reader = AtsProviderId | 'page_reader'

export interface DueCompany extends CompanyInput {
  user_id: string
  scrape_frequency: number | null
  last_scraped_at: string | null
  is_dream_company: boolean | null
}

export interface CompanyOutcome {
  result: CompanyRefreshResult
  /** What read it: a job board's provider, the page reader, or null when nothing could (no board, no careers page). */
  reader: Reader | null
  /** No board and no careers page to read: nothing to do, which is not a failure. */
  skipped: boolean
  failure: FailureReason | null
}

export interface CompanyDeps {
  fetchPage: FetchPage
  model: ModelCall | null
  fetchDetail?: (url: string) => Promise<string>
}

// --- when a company is due -------------------------------------------------

// Slack so a cron that drifts a few minutes still counts as "due".
const DUE_SLACK_MINUTES = 5
const DREAM_INTERVAL_MINUTES = 60
const DEFAULT_INTERVAL_MINUTES = 1440

/** Dream companies hourly, the rest daily; a larger scrape_frequency (minutes) stretches that, never shortens it. */
export function isDue(company: Pick<DueCompany, 'last_scraped_at' | 'is_dream_company' | 'scrape_frequency'>, now: number): boolean {
  if (!company.last_scraped_at) return true
  const last = Date.parse(company.last_scraped_at)
  if (Number.isNaN(last)) return true
  const base = company.is_dream_company ? DREAM_INTERVAL_MINUTES : DEFAULT_INTERVAL_MINUTES
  const freq = typeof company.scrape_frequency === 'number' && Number.isFinite(company.scrape_frequency) ? company.scrape_frequency : 0
  return now - last >= (Math.max(base, freq) - DUE_SLACK_MINUTES) * 60_000
}

/** A read that listed nothing and reported errors, or listed postings it could not store. */
function boardFailed(result: CompanyRefreshResult): boolean {
  if (result.errors.length === 0) return false
  return result.found === 0 || result.errors.some((e) => e.startsWith('upsert failed'))
}

// --- one company -----------------------------------------------------------

export async function ingestCompany(store: AtsStore, company: DueCompany, deps: CompanyDeps): Promise<CompanyOutcome> {
  const outcome: CompanyOutcome = { result: emptyResult(company), reader: null, skipped: false, failure: null }

  outcome.result = await withCompanyLock(store, company, async (result) => {
    // 1. The job board, when the company has one.
    await refreshLocked(store, company, result)
    if (result.provider) {
      outcome.reader = result.provider
      if (boardFailed(result)) outcome.failure = 'board_error'
      return
    }
    if (result.errors.length > 0) {
      // A board that is known and failed, or a store that could not be read: not a reason to switch to scraping the page.
      outcome.failure = 'board_error'
      return
    }

    // 2. No board. Read the careers page, if there is one.
    const careerUrl = company.career_url?.trim()
    if (!careerUrl) {
      outcome.skipped = true
      try {
        await store.updateCompanyLastScraped(company.id)
      } catch {
        /* checked again next time */
      }
      return
    }
    outcome.reader = 'page_reader'
    const stored = await loadStoredJobs(store, company.id, result)
    if (!stored) {
      outcome.failure = 'board_error'
      return
    }
    const read = await readCareersPage(
      { name: company.name, career_url: careerUrl },
      {
        fetchPage: deps.fetchPage,
        model: deps.model,
        fetchDetail: deps.fetchDetail,
        needsDescription: (id) => stored.get(id)?.descriptionMd5 == null,
      }
    )
    if (read.reason) {
      outcome.failure = read.reason
      return
    }
    // A board supersedes the page, but the page's rows only close on a complete read of it.
    await syncJobs(store, company, read.jobs, { source: 'scraper', sightingSources: read.complete ? ['scraper'] : [], stored }, result)
    if (boardFailed(result)) outcome.failure = 'board_error'
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
      return { result: emptyResult(company), reader: null, skipped: false, failure: 'time' }
    }
    try {
      return await ingestCompany(deps.store, company, deps)
    } catch {
      // ingestCompany isolates its own failures; this is the last guard so one company cannot end the pass.
      return { result: emptyResult(company), reader: null, skipped: false, failure: 'board_error' }
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
