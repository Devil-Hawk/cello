// The one supabase-js implementation of AtsStore.
//
// The in-app refresh (user session, row level security), the autopilot and the
// scheduled ingestion (service role) used to carry three near-identical copies
// of this, which is how one of them came to lack the description backfill and
// none of them could record a sighting. The client decides who is acting; the
// code is the same.

import type { SupabaseClient } from '@supabase/supabase-js'
import { mapWithConcurrency } from './concurrency'
import { clearBoardJobsRpc } from './heal'
import type { AtsStore, ExistingJob, JobUpdate, SightingResult } from './index'

// The generated Database type does not cover the columns added by the ingestion
// migrations, and callers pass clients typed both ways.
type Db = SupabaseClient<any, any, any>

const PAGE_SIZE = 1000
const UPDATE_CONCURRENCY = 4
/** md5('') : jobs.description_md5 of a row with no description. */
const EMPTY_MD5 = 'd41d8cd98f00b204e9800998ecf8427e'
/** Longer than any refresh of one company takes; a crashed holder frees itself. */
const LOCK_LEASE_MINUTES = 15

export interface AtsStoreOptions {
  /** Service-role client used only for the per-company lock (the lock functions are not callable by a signed-in user). */
  lockClient?: Db
  /** Who holds the lock; unique per process so a second process cannot release the first one's lock. */
  holder?: string
  /** Read, detect and count, but write nothing. */
  dryRun?: boolean
}

function fail(error: { message: string } | null): void {
  if (error) throw new Error(error.message)
}

export function makeSupabaseAtsStore(client: Db, opts: AtsStoreOptions = {}): AtsStore {
  const holder = opts.holder ?? `ingest-${Math.random().toString(36).slice(2)}`
  const dry = opts.dryRun === true
  const lock = opts.lockClient

  return {
    async listJobs(companyId: string, employerId?: string | null): Promise<ExistingJob[]> {
      const rows: ExistingJob[] = []
      // Pagination within a company is always sequential.
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await client
          .from('jobs')
          .select('external_id, title, location, salary_range, description_md5, source, still_open, url, last_seen_at, job_function, seniority, country, language, is_remote, posted_at')
          // A role is one row per posting, shared by everyone who follows its employer.
          .eq(employerId ? 'employer_id' : 'company_id', employerId ?? companyId)
          .order('external_id')
          .range(from, from + PAGE_SIZE - 1)
        fail(error)
        for (const row of (data ?? []) as {
          external_id: string | null
          title: string
          location: string | null
          salary_range: string | null
          description_md5: string | null
          source: string | null
          still_open: boolean | null
          url: string | null
          last_seen_at: string | null
          job_function: string | null
          seniority: string | null
          country: string | null
          language: string | null
          is_remote: boolean | null
          posted_at: string | null
        }[]) {
          if (!row.external_id) continue
          rows.push({
            externalId: row.external_id,
            title: row.title,
            location: row.location,
            salaryRange: row.salary_range,
            descriptionMd5: !row.description_md5 || row.description_md5 === EMPTY_MD5 ? null : row.description_md5,
            source: row.source,
            open: row.still_open !== false,
            url: row.url,
            lastSeenAt: row.last_seen_at,
            jobFunction: row.job_function,
            seniority: row.seniority,
            country: row.country,
            language: row.language,
            isRemote: row.is_remote,
            postedAt: row.posted_at,
          })
        }
        if (!data || data.length < PAGE_SIZE) break
      }
      return rows
    },

    async evictJobs(companyId, externalIds): Promise<string[]> {
      if (dry) return externalIds
      const { data, error } = await client.rpc('evict_company_jobs', { p_company_id: companyId, p_external_ids: externalIds })
      fail(error)
      return Array.isArray(data) ? (data as string[]) : []
    },

    async upsertJobs(rows): Promise<void> {
      if (dry) return
      const shared = rows.filter((r) => r.employer_id)
      const own = rows.filter((r) => !r.employer_id)
      if (shared.length > 0) {
        // One row per (employer, posting): the first follower's company stays, later reads update it.
        const { error } = await client.rpc('upsert_shared_jobs', { p_rows: shared })
        // Before the contract migration the function does not exist yet: the company's own row is written as it always was.
        if (error?.code === 'PGRST202') own.push(...shared)
        else fail(error)
      }
      if (own.length > 0) {
        const { error } = await client.from('jobs').upsert(own as never, { onConflict: 'company_id,external_id', ignoreDuplicates: false })
        fail(error)
      }
    },

    async keepForPerson({ userId, companyId, externalIds, hiddenIds, targetsVersion }): Promise<void> {
      if (dry || externalIds.length === 0) return
      const { error } = await client.rpc('sync_person_roles', {
        p_user: userId,
        p_company: companyId,
        p_external_ids: externalIds,
        p_targets_version: targetsVersion,
        p_hidden: hiddenIds,
      })
      fail(error)
    },

    async setCounts(userId, rows): Promise<void> {
      if (dry) return
      const { error } = await client.rpc('set_person_counts', { p_user: userId, p_rows: rows })
      fail(error)
    },

    async updateJobs(updates: JobUpdate[]): Promise<number> {
      if (dry) return updates.length
      const changed = await mapWithConcurrency(updates, UPDATE_CONCURRENCY, async (u) => {
        const { data, error } = await client
          .from('jobs')
          .update(u.fields as never)
          .eq(u.employerId ? 'employer_id' : 'company_id', u.employerId ?? u.companyId)
          .eq('external_id', u.externalId)
          .select('id')
        fail(error)
        return (data as unknown[] | null)?.length ?? 0
      })
      return changed.reduce((sum, n) => sum + n, 0)
    },

    async recordSightings(companyId, externalIds, sources): Promise<SightingResult> {
      if (dry) return { seen: 0, reopened: 0, missed: 0, closed: 0 }
      const { data, error } = await client.rpc('record_job_sightings', {
        p_company_id: companyId,
        p_external_ids: externalIds,
        p_sources: sources,
        p_close_after: 2,
      })
      fail(error)
      const r = (data ?? {}) as Partial<SightingResult>
      return { seen: r.seen ?? 0, reopened: r.reopened ?? 0, missed: r.missed ?? 0, closed: r.closed ?? 0 }
    },

    ...(lock
      ? {
          async acquireCompanyLock(companyId: string): Promise<boolean> {
            const { data, error } = await lock.rpc('acquire_ingestion_lock', {
              p_name: `company:${companyId}`,
              p_holder: holder,
              p_lease_minutes: LOCK_LEASE_MINUTES,
            })
            fail(error)
            return data === true
          },
          async releaseCompanyLock(companyId: string): Promise<void> {
            await lock.rpc('release_ingestion_lock', { p_name: `company:${companyId}`, p_holder: holder })
          },
        }
      : {}),

    async saveCompanyMetadata(companyId: string, metadata: Record<string, unknown>): Promise<void> {
      if (dry) return
      const { error } = await client.from('companies').update({ metadata: metadata as never }).eq('id', companyId)
      // Throw so refreshCompany's tolerant catch handles a missing column
      // (42703 / PGRST204) the same as any other metadata write failure.
      fail(error)
    },

    async clearBoardJobs(companyId, source) {
      if (dry) return { deleted: 0, closed: 0 }
      return clearBoardJobsRpc(client, companyId, source)
    },

    async updateCompanyLastScraped(companyId: string): Promise<void> {
      if (dry) return
      const { error } = await client
        .from('companies')
        .update({ last_scraped_at: new Date().toISOString() })
        .eq('id', companyId)
      fail(error)
    },
  }
}
