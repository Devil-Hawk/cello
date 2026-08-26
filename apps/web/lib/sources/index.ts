// Job-aggregator sources — registry, fan-out query, and DB ingestion.
//
// `queryAllSources` runs every adapter in parallel and merges/dedupes the leads.
// `ingestLeads` inserts the new jobs with a service-role Supabase client
// (bypasses RLS), deduping against jobs already in the user's workspace by
// external_id/url. Companies an aggregator lead names but the user does not
// already track are created as SUGGESTIONS (companies.metadata.suggested =
// true) rather than silently promoted to fully-tracked — see ingestLeads.

import type { SupabaseClient } from '@supabase/supabase-js'
import { classifyJob } from '../jobs/classify'
import { repairMojibake } from '../jobs/mojibake'
import type { JobLead, SourceAdapter, SourceId, SourceQuery } from './types'
import { rankAndLimit, sanitizeLeads } from './util'
import { ownedJobsQuery } from '../harness/agents/matcher'
import { normalizeCompanyName, resolveCompany, scanMergeCandidates, type ResolvedCompany } from '../entities/companies'

import { themuse } from './themuse'
import { arbeitnow } from './arbeitnow'
import { remoteok } from './remoteok'
import { hackernews } from './hackernews'
import { ycombinator } from './ycombinator'
import { echojobs } from './echojobs'
import { remotive } from './remotive'
import { weworkremotely } from './weworkremotely'
import { himalayas } from './himalayas'
import { workingnomads } from './workingnomads'
import { jobicy } from './jobicy'

export type { JobLead, SourceAdapter, SourceId, SourceQuery } from './types'
export { themuse } from './themuse'
export { arbeitnow } from './arbeitnow'
export { remoteok } from './remoteok'
export { hackernews } from './hackernews'
export { ycombinator } from './ycombinator'
export { echojobs } from './echojobs'
export { remotive } from './remotive'
export { weworkremotely } from './weworkremotely'
export { himalayas } from './himalayas'
export { workingnomads } from './workingnomads'
export { jobicy } from './jobicy'

// Keyless aggregators that each fan out across MANY employers from a single
// endpoint — the highest-leverage way to grow the reachable job pool without
// an LLM call or a per-employer ATS integration. See the per-file header
// comments for the live-verified employer/job counts behind each one.
export const sourceAdapters: SourceAdapter[] = [
  themuse,
  arbeitnow,
  remoteok,
  hackernews,
  ycombinator,
  echojobs,
  remotive,
  weworkremotely,
  himalayas,
  workingnomads,
  jobicy,
]

export interface QueryAllOptions {
  /** Restrict to a subset of sources (defaults to all). */
  only?: SourceId[]
  /**
   * Total leads to keep after the global merge. Default is deliberately
   * modest (not a firehose): when the caller has no real targeting signal
   * (empty keywords, no SourceQuery.targeting), tracked-company ATS feeds
   * (lib/ats) are the primary/preferred source of jobs — aggregators are a
   * supplement, not the main pipeline.
   */
  totalLimit?: number
}

export interface QueryAllResult {
  leads: JobLead[]
  perSource: Record<string, { found: number; error?: string }>
}

/** Run all (or `only`) adapters in parallel and merge into a deduped, ranked list. */
export async function queryAllSources(
  query: Omit<SourceQuery, 'limit'>,
  opts: QueryAllOptions = {}
): Promise<QueryAllResult> {
  const active = opts.only?.length
    ? sourceAdapters.filter((a) => opts.only!.includes(a.id))
    : sourceAdapters
  const totalLimit = opts.totalLimit ?? 50
  // Give each source a fair share; over-fetch a little, then globally re-rank.
  const perSourceLimit = Math.min(60, Math.max(10, Math.ceil((totalLimit * 1.5) / active.length)))

  const perSource: Record<string, { found: number; error?: string }> = {}
  const settled = await Promise.allSettled(
    active.map((a) => a.fetchLeads({ ...query, limit: perSourceLimit }))
  )

  const merged: JobLead[] = []
  active.forEach((adapter, i) => {
    const r = settled[i]
    if (r.status === 'fulfilled') {
      perSource[adapter.id] = { found: r.value.length }
      merged.push(...r.value)
    } else {
      perSource[adapter.id] = { found: 0, error: errMsg(r.reason) }
    }
  })

  const deduped = sanitizeLeads(merged, query.targeting)
  const leads = rankAndLimit(deduped, { ...query, limit: totalLimit } as SourceQuery)
  return { leads, perSource }
}

export interface IngestResult {
  /** Ids of jobs that now exist for the user (newly inserted + already-present matches). */
  jobIds: string[]
  /** Total distinct leads considered. */
  found: number
  /** Jobs newly inserted this run. */
  inserted: number
  /** Companies auto-created this run. */
  createdCompanies: number
  errors: string[]
}

// Re-exported for backward compatibility — the identity chokepoint
// (lib/entities/companies.ts) is now its canonical home, since resolveCompany
// and scanMergeCandidates need it too and this module depends on THAT one
// (not the other way around, which would cycle).
export { normalizeCompanyName } from '../entities/companies'

function faviconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`
}

/**
 * Persist leads: dedup against existing jobs, create missing companies, insert
 * new jobs. Uses a service-role client (server-side only). Never throws — DB
 * errors are collected into `errors`.
 */
export async function ingestLeads(
  admin: SupabaseClient,
  userId: string,
  leads: JobLead[]
): Promise<IngestResult> {
  const result: IngestResult = {
    jobIds: [],
    found: leads.length,
    inserted: 0,
    createdCompanies: 0,
    errors: [],
  }
  if (leads.length === 0) return result

  // 0. Repair mojibake on every text field, for every adapter, in one place.
  //
  //    stripHtml() already covers descriptions, but company and title are only
  //    .trim()ed by the adapters — which is how "UniversitÃ© de Bordeaux" and
  //    "CoâStar" reached the companies table as employer names, and a company
  //    name is not a cosmetic field: it is what the user reads on the row, what
  //    dedupe keys off, and what outreach addresses. Doing it HERE rather than
  //    in each of the twelve adapters means a new adapter inherits the repair
  //    instead of having to remember it.
  //
  //    repairMojibake only rewrites text carrying the corruption signature and
  //    leaves correct text untouched, so this is safe to apply blanket-wise.
  //    See lib/jobs/mojibake.ts.
  leads = leads.map((lead) => ({
    ...lead,
    company: repairMojibake(lead.company),
    title: repairMojibake(lead.title),
    location: repairMojibake(lead.location),
    description: repairMojibake(lead.description),
  }))

  // 1. Resolve every distinct company named in this batch through the
  //    identity chokepoint (lib/entities/companies.ts) instead of a
  //    per-request map rebuilt from a raw name/domain scan — a company that
  //    was merged into a survivor resolves straight to the survivor, so a
  //    later ingest never recreates the duplicate. One resolveCompany() call
  //    per DISTINCT company in the batch (deduped below), run in parallel —
  //    not per-lead, and not a single all-companies-for-user fetch.
  interface LeadCompany {
    name: string
    domain: string | null
    /** The specific lead's own URL — see the create-if-absent comment below for why. */
    careerUrl: string
  }
  const distinct = new Map<string, LeadCompany>() // normalizeCompanyName(name) -> company
  for (const lead of leads) {
    const norm = normalizeCompanyName(lead.company)
    if (!norm) continue
    const domain = lead.companyDomain?.toLowerCase().replace(/^www\./, '') || null
    if (!distinct.has(norm)) {
      distinct.set(norm, { name: lead.company.trim().slice(0, 200), domain, careerUrl: lead.url })
    } else if (domain && !distinct.get(norm)!.domain) {
      distinct.get(norm)!.domain = domain // upgrade with a domain if a later lead has one
    }
  }

  const resolved = new Map<string, ResolvedCompany>() // norm -> company
  await Promise.all(
    [...distinct.entries()].map(async ([norm, c]) => {
      const match = await resolveCompany(admin, userId, { name: c.name, domain: c.domain ?? undefined })
      if (match) resolved.set(norm, match)
    })
  )

  // 2. Create any companies we don't have yet (deduped across the batch).
  //
  // These are aggregator-sourced leads, not companies the user chose to
  // track — so they're created as SUGGESTIONS (metadata.suggested = true),
  // never as a fully-tracked company the ATS refresher/HTML scraper treats
  // as ready to crawl. career_url is deliberately never a guessed bare
  // homepage (`https://${domain}`): that guess is what pointed the HTML
  // scraper at homepages and produced nav-link garbage ("epias GmbH").
  // Instead career_url is the specific lead's own URL — a real page that
  // exists, not a guess.
  const toCreate = [...distinct.entries()].filter(([norm]) => !resolved.has(norm))
  if (toCreate.length > 0) {
    const rows = toCreate.map(([norm, c]) => ({
      user_id: userId,
      name: c.name,
      name_key: norm,
      domain: c.domain,
      career_url: c.careerUrl,
      logo_url: c.domain ? faviconUrl(c.domain) : null,
      metadata: { suggested: true },
    }))
    // ignoreDuplicates + idx_companies_user_name_key_unique (migration
    // 20260816000002): a concurrent ingestLeads for the same user racing this
    // one creates its row first, this upsert silently skips that norm instead
    // of inserting a second live company for it — the check-then-insert race
    // a plain .insert() couldn't close. Skipped norms come back re-resolved
    // below so their leads still attach to the row that won.
    const { data, error } = await admin
      .from('companies')
      .upsert(rows, { onConflict: 'user_id,name_key', ignoreDuplicates: true })
      .select('id, name, domain, name_key')
    if (error) {
      result.errors.push(`create companies: ${error.message}`)
    } else {
      const created = (data ?? []) as { id: string; name: string; domain: string | null; name_key: string }[]
      result.createdCompanies = created.length
      for (const c of created) resolved.set(c.name_key, { id: c.id, name: c.name, domain: c.domain })

      const stillMissing = toCreate.filter(([norm]) => !resolved.has(norm))
      if (stillMissing.length > 0) {
        await Promise.all(
          stillMissing.map(async ([norm, c]) => {
            const match = await resolveCompany(admin, userId, { name: c.name, domain: c.domain ?? undefined })
            if (match) resolved.set(norm, match)
          })
        )
      }

      // Enqueue a merge-candidate scan now that new companies exist — a
      // best-effort background step (identical semantics to how the rest of
      // this function collects errors instead of throwing): a scan failure
      // must never fail the ingest that already committed real job rows.
      try {
        await scanMergeCandidates(admin, userId)
      } catch (e) {
        result.errors.push(`scan merge candidates: ${errMsg(e)}`)
      }
    }
  }

  // 3. Existing jobs (by external_id AND url) across the user's companies.
  const companyIds = [...new Set([...resolved.values()].map((c) => c.id))]
  const existing = new Map<string, string>() // dedup-key -> job id
  if (companyIds.length > 0) {
    // Ownership via the companies FK join (ownedJobsQuery), not an
    // .in('company_id', companyIds) array — that breaks past ~600 companies.
    const { data, error } = await ownedJobsQuery(admin, userId, 'id, external_id, url, companies!inner(user_id)')
    if (error) {
      result.errors.push(`load jobs: ${error.message}`)
    }
    for (const j of (data ?? []) as unknown as { id: string; external_id: string | null; url: string | null }[]) {
      if (j.external_id) existing.set(j.external_id, j.id)
      if (j.url) existing.set(j.url, j.id)
    }
  }

  // 4. Split leads into already-present (collect id) vs new (insert).
  const now = new Date().toISOString()
  const seenKeys = new Set<string>()
  const toInsert: Record<string, unknown>[] = []
  for (const lead of leads) {
    const norm = normalizeCompanyName(lead.company)
    const company = resolved.get(norm)
    if (!company) continue // company creation failed
    const existingId = existing.get(lead.externalId) ?? existing.get(lead.url)
    if (existingId) {
      if (!seenKeys.has(existingId)) {
        seenKeys.add(existingId)
        result.jobIds.push(existingId)
      }
      continue
    }
    if (seenKeys.has(lead.externalId)) continue
    seenKeys.add(lead.externalId)
    const c = classifyJob({
      title: lead.title,
      description: lead.description,
      location: lead.location,
      companyName: lead.company,
    })
    toInsert.push({
      company_id: company.id,
      title: lead.title.slice(0, 300),
      description: lead.description,
      url: lead.url,
      location: lead.location,
      salary_range: lead.salary,
      posted_at: lead.postedAt ?? null,
      external_id: lead.externalId,
      is_new: true,
      discovered_at: now,
      job_function: c.jobFunction,
      seniority: c.seniority,
      language: c.language,
      country: c.country,
      is_remote: c.isRemote,
      job_type: c.jobType,
      quality_score: c.qualityScore,
      source: lead.source,
    })
  }

  // 5. Bulk upsert new jobs (onConflict company_id,external_id) and collect ids.
  if (toInsert.length > 0) {
    const { data, error } = await admin
      .from('jobs')
      .upsert(toInsert, { onConflict: 'company_id,external_id', ignoreDuplicates: false })
      .select('id')
    if (error) {
      result.errors.push(`insert jobs: ${error.message}`)
    } else {
      const ids = (data ?? []) as { id: string }[]
      result.inserted = ids.length
      for (const j of ids) if (!seenKeys.has(j.id)) result.jobIds.push(j.id)
    }
  }

  return result
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
