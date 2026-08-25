// ATS registry + per-company refresh core.
//
// refreshCompany() contains all provider/dedup/insert-count logic and talks to
// the database through the small AtsStore interface, so the same code runs in
// the Next.js route (user-scoped supabase-js client, RLS enforced) and in the
// scheduled CI script (service-role PostgREST via plain fetch).

import type { AtsJob, AtsMetadata, AtsProvider, AtsProviderId } from './types'
import { isValidToken } from './types'
import { greenhouse } from './greenhouse'
import { lever } from './lever'
import { ashby } from './ashby'
import { detectAts } from './detect'
// Relative import (not `@/...`): lib/ats/* stays framework-free, and
// lib/jobs/classify.ts is itself a zero-dependency pure module, so this is
// safe in both the Next.js route and the plain-tsx scheduled script.
import { classifyJob, isLowQuality } from '../jobs/classify'

export type {
  AtsJob,
  AtsMetadata,
  AtsProvider,
  AtsProviderId,
  DetectInput,
  FetchContext,
} from './types'
export { detectAts, detectFromUrl, probeAts, candidateTokens } from './detect'
export { HttpError, fetchJson, assertAllowedHost } from './http'
export { greenhouse } from './greenhouse'
export { lever } from './lever'
export { ashby } from './ashby'

export const providers: Record<AtsProviderId, AtsProvider> = {
  greenhouse,
  lever,
  ashby,
}

/** The company fields refreshCompany needs (subset of the companies row). */
export interface CompanyInput {
  id: string
  name: string
  domain: string | null
  career_url: string | null
  /** companies.metadata jsonb — may be absent when the column doesn't exist yet. */
  metadata?: unknown
}

/** Row shape upserted into jobs (onConflict company_id,external_id). */
export interface JobUpsertRow {
  company_id: string
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
  /** Ingest provenance: the ATS provider that produced this row. */
  source: AtsProviderId
}

/**
 * Storage adapter. Implementations: supabase-js client (route) and raw
 * PostgREST fetch (scripts/ats-refresh.ts). All methods may throw; refresh
 * isolates failures per company.
 */
export interface AtsStore {
  /** All existing jobs.external_id values for a company (paged internally). */
  listJobExternalIds(companyId: string): Promise<Set<string>>
  /** Upsert rows with on_conflict company_id,external_id (merge duplicates). */
  upsertJobs(rows: JobUpsertRow[]): Promise<void>
  /**
   * Fill an EMPTY description on an already-stored job. Optional so existing
   * store implementations keep compiling; returns how many rows it changed.
   * Must never overwrite a description that already has content.
   */
  backfillJobDescriptions?(
    rows: { company_id: string; external_id: string; description: string }[]
  ): Promise<number>
  /** Persist the full companies.metadata object. May throw 42703/PGRST204 when the column is missing — callers swallow it. */
  saveCompanyMetadata(companyId: string, metadata: Record<string, unknown>): Promise<void>
  updateCompanyLastScraped(companyId: string): Promise<void>
}

/** Per-company result matching the frozen /api/jobs/refresh contract. */
export interface CompanyRefreshResult {
  companyId: string
  companyName: string
  provider: AtsProviderId | null
  found: number
  inserted: number
  /** Already-known jobs whose empty description was filled in this pass. */
  backfilled?: number
  errors: string[]
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Read a valid cached ATS pointer out of companies.metadata, if any. */
function readCachedAts(metadata: unknown): { provider: AtsProviderId; token: string } | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const ats = (metadata as Record<string, unknown>).ats
  if (!ats || typeof ats !== 'object' || Array.isArray(ats)) return null
  const record = ats as Record<string, unknown>
  const provider = record.provider
  const token = record.token
  if (provider !== 'greenhouse' && provider !== 'lever' && provider !== 'ashby') return null
  if (!isValidToken(token)) return null
  return { provider, token }
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
    clean.push(job)
  }
  return clean
}

/**
 * Refresh one company: resolve its ATS board (cached metadata -> careers URL
 * -> probe), fetch open roles, and insert the ones we haven't seen. Existing
 * rows are left untouched (preserves discovered_at/is_new/match_score).
 * Never throws — failures are reported in result.errors.
 */
export async function refreshCompany(store: AtsStore, company: CompanyInput): Promise<CompanyRefreshResult> {
  const result: CompanyRefreshResult = {
    companyId: company.id,
    companyName: company.name,
    provider: null,
    found: 0,
    inserted: 0,
    errors: [],
  }

  // 1. Resolve board + fetch jobs.
  let jobs: AtsJob[] | null = null
  const cached = readCachedAts(company.metadata)
  if (cached) {
    result.provider = cached.provider
    try {
      jobs = await providers[cached.provider].fetch(cached.token)
    } catch (error) {
      // Cached board may have moved — fall through to fresh detection.
      result.errors.push(`cached ${cached.provider} board "${cached.token}" failed: ${errorMessage(error)}`)
      result.provider = null
      jobs = null
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
      return result
    }
    if (!detected) {
      // provider stays null — callers may fall back to the HTML scraper.
      return result
    }
    result.provider = detected.provider
    try {
      jobs = detected.jobs ?? (await providers[detected.provider].fetch(detected.token))
    } catch (error) {
      result.errors.push(`${detected.provider} fetch failed: ${errorMessage(error)}`)
      return result
    }
    // Persist the discovery so future runs skip probing. Best-effort: the
    // metadata column may not exist yet (42703/PGRST204) — fall back silently.
    const baseMetadata =
      company.metadata && typeof company.metadata === 'object' && !Array.isArray(company.metadata)
        ? (company.metadata as Record<string, unknown>)
        : {}
    const ats: AtsMetadata = {
      provider: detected.provider,
      token: detected.token,
      source: detected.source,
      discovered_at: new Date().toISOString(),
    }
    try {
      await store.saveCompanyMetadata(company.id, { ...baseMetadata, ats })
    } catch {
      /* tolerated — URL/probe detection will simply run again next time */
    }
  }

  // Every path that reaches here set result.provider (cached or detected)
  // before assigning a non-null `jobs`; every path that leaves it null
  // returned early above.
  const provider: AtsProviderId = result.provider as AtsProviderId

  // 2. Dedup intra-run and count.
  const clean = sanitizeJobs(jobs)
  result.found = clean.length
  if (clean.length === 0) {
    try {
      await store.updateCompanyLastScraped(company.id)
    } catch (error) {
      result.errors.push(`last_scraped_at update failed: ${errorMessage(error)}`)
    }
    return result
  }

  // 3. Insert only unseen rows so re-runs create 0 duplicates and existing
  //    rows keep their discovered_at / is_new / match data.
  let existing: Set<string>
  try {
    existing = await store.listJobExternalIds(company.id)
  } catch (error) {
    result.errors.push(`listing existing jobs failed: ${errorMessage(error)}`)
    return result
  }

  const now = new Date().toISOString()
  // ATS boards are structured/official data, so garbage titles are rare — but
  // a badly-configured board (a "location" page listed as a posting, etc.)
  // can still slip through, so every row runs through the same classifier
  // gate as the scraper/aggregator paths rather than trusting the source.
  const newRows: JobUpsertRow[] = clean
    .filter((job) => !existing.has(job.externalId))
    .map((job) => {
      const title = job.title.trim()
      const c = classifyJob({
        title,
        description: job.description,
        location: job.location,
        companyName: company.name,
      })
      return { job, title, c }
    })
    .filter(({ c }) => !c.rejectReason && !isLowQuality(c))
    .map(({ job, title, c }) => ({
      company_id: company.id,
      title,
      description: job.description ?? '',
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
      source: provider,
    }))

  if (newRows.length > 0) {
    try {
      await store.upsertJobs(newRows)
      result.inserted = newRows.length
    } catch (error) {
      result.errors.push(`upsert failed: ${errorMessage(error)}`)
      return result
    }
  }

  // BACKFILL ALREADY-KNOWN JOBS.
  //
  // Refresh used to insert new postings and nothing else, so a row stored once
  // could never improve. That mattered the moment the Greenhouse adapter began
  // requesting posting bodies: 13,043 already-stored jobs had an empty
  // description and, without this, would have stayed empty forever while the
  // refresh reported success and inserted nothing.
  //
  // Deliberately conservative: fill ONLY fields that are currently empty, and
  // never overwrite something already stored. Refresh should improve a row, not
  // rewrite it.
  const backfill = clean
    .filter((job) => existing.has(job.externalId))
    .filter((job) => (job.description ?? '').trim().length > 0)
    .map((job) => ({
      company_id: company.id,
      external_id: job.externalId,
      description: job.description as string,
    }))

  if (backfill.length > 0 && typeof store.backfillJobDescriptions === 'function') {
    try {
      result.backfilled = await store.backfillJobDescriptions(backfill)
    } catch (error) {
      result.errors.push(`backfill failed: ${errorMessage(error)}`)
    }
  }

  try {
    await store.updateCompanyLastScraped(company.id)
  } catch (error) {
    result.errors.push(`last_scraped_at update failed: ${errorMessage(error)}`)
  }

  return result
}

/** Run fn over items with bounded concurrency, preserving input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}
