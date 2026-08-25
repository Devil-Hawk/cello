// Strategy analytics — read-only data access.
//
// Two implementations satisfy StrategyDataSource:
//   - createSupabaseStrategyDataSource(admin, userId) reads the REAL tables,
//     explicitly scoped by `.eq('user_id', userId)` / an owned-company-id
//     list — never relies on RLS alone, matching every other service-role
//     agent in this codebase (contact_sourcer, matcher, ...).
//   - lib/strategy/fixtures.ts's buildSyntheticFixture() builds the exact same
//     shape ENTIRELY IN MEMORY, never touching the database. It exists only
//     to demonstrate what the analyzers say once an account crosses the
//     honesty thresholds in thresholds.ts — see the acceptance demo in this
//     workstream's report.
//
// Every query here is a flat select + an in-memory join, not a multi-level
// PostgREST embed — the JOINed shape (application -> job -> company) is
// exactly what lib/harness/agents/matcher.ts's SELECT_COLUMNS already proves
// works via `companies(name)`-style embeds, but flat selects here keep the
// row-shape validation simple and keep each query small enough to reason
// about independently.

import type { AdminClient } from '../harness/types'
import { userCompanyIds } from '../harness/agents/matcher'
import { QUALITY_REJECT_THRESHOLD } from '../jobs/classify'
import type { Targeting } from '../targeting'

export interface ApplicationRow {
  id: string
  jobId: string
  stage: string
  appliedAt: string | null
  createdAt: string
  /** applications.source — HOW this row was created (harness/matcher, cello-autopilot, ...). Not the job board. */
  applicationSource: string | null
  companyId: string
  companyName: string
  /** jobs.source — the ingest channel (greenhouse, lever, arbeitnow, ...). This IS the job board / ATS. */
  jobSource: string | null
  jobPostedAt: string | null
  matchScore: number | null
  jobFunction: string | null
  seniority: string | null
}

export interface ActivityRow {
  id: string
  applicationId: string
  type: string
  occurredAt: string
}

export interface ResumeDocumentRow {
  id: string
  jobId: string | null
  version: number
  source: string | null
  atsScore: number | null
  content: string
  contentJson: { sections?: { heading: string; bullets: string[] }[] } | null
}

export interface OutreachMessageRow {
  id: string
  jobId: string | null
  companyId: string | null
  status: string
  kind: string
  sentAt: string | null
}

export interface JobScopeCounts {
  totalJobs: number
  totalPassingAllConfiguredFilters: number
  jobsWithNoDescription: number
  /** Jobs excluded by ONE dimension alone, holding every other dimension open — for the "why" breakdown. */
  excludedByDimension: Record<string, number>
  /** How many jobs a configured excludedKeywords list WOULD additionally exclude (title+description ILIKE). Null when excludedKeywords is empty (never evaluated, never a fabricated zero). */
  excludedByKeywords: number | null
  /** How many jobs a configured targeting.minScore WOULD exclude, computed for transparency even though nothing in the product enforces targeting.minScore today (see lib/targeting.ts / lib/harness/agents/matcher.ts — only preferences.autopilot.minScore is enforced, a different field). Null when minScore is unset. */
  excludedByMinScoreHypothetical: number | null
}

export interface StrategyDataSource {
  getApplications(): Promise<ApplicationRow[]>
  getActivities(applicationIds: string[]): Promise<ActivityRow[]>
  getResumeDocuments(): Promise<ResumeDocumentRow[]>
  getOutreachMessages(): Promise<OutreachMessageRow[]>
  getJobScopeCounts(targeting: Targeting): Promise<JobScopeCounts>
}

// --- Supabase implementation --------------------------------------------------

interface RawApplication {
  id: string
  job_id: string
  stage: string
  applied_at: string | null
  created_at: string
  source: string | null
}

interface RawJob {
  id: string
  company_id: string
  source: string | null
  posted_at: string | null
  match_score: number | null
  job_function: string | null
  seniority: string | null
}

// NOTE ON "unclassified passes through": the count queries below express this
// in SQL directly (`col.is.null,col.eq.unknown,col.in.(...)`) rather than
// calling a JS predicate — there is no in-memory row to test it against, only
// a COUNT. This mirrors lib/harness/agents/matcher.ts's isUnclassified()
// helper (NULL or the literal 'unknown' sentinel passes every facet filter),
// applied uniformly across facets for the same reason matcher.ts does it: one
// rule instead of a different one per column.

export function createSupabaseStrategyDataSource(admin: AdminClient, userId: string): StrategyDataSource {
  return {
    async getApplications() {
      const { data: apps, error } = await admin
        .from('applications')
        .select('id, job_id, stage, applied_at, created_at, source')
        .eq('user_id', userId)
      if (error) {
        console.error('[strategy] getApplications: applications query failed', error)
        return []
      }
      const rawApps = (apps as RawApplication[] | null) ?? []
      if (rawApps.length === 0) return []

      const jobIds = [...new Set(rawApps.map((a) => a.job_id))]
      const { data: jobs, error: jobsErr } = await admin
        .from('jobs')
        .select('id, company_id, source, posted_at, match_score, job_function, seniority')
        .in('id', jobIds)
      if (jobsErr) console.error('[strategy] getApplications: jobs query failed', jobsErr)
      const jobById = new Map<string, RawJob>(((jobs as RawJob[] | null) ?? []).map((j) => [j.id, j]))

      const companyIds = [...new Set([...jobById.values()].map((j) => j.company_id))]
      const { data: companies, error: companiesErr } = await admin.from('companies').select('id, name').in('id', companyIds)
      if (companiesErr) console.error('[strategy] getApplications: companies query failed', companiesErr)
      const nameByCompany = new Map<string, string>(
        (((companies as { id: string; name: string }[] | null) ?? []).map((c) => [c.id, c.name]))
      )

      return rawApps
        .map((a): ApplicationRow | null => {
          const job = jobById.get(a.job_id)
          if (!job) return null // job deleted out from under an application row — skip rather than fabricate
          return {
            id: a.id,
            jobId: a.job_id,
            stage: a.stage,
            appliedAt: a.applied_at,
            createdAt: a.created_at,
            applicationSource: a.source,
            companyId: job.company_id,
            companyName: nameByCompany.get(job.company_id) ?? 'Unknown company',
            jobSource: job.source,
            jobPostedAt: job.posted_at,
            matchScore: job.match_score,
            jobFunction: job.job_function,
            seniority: job.seniority,
          }
        })
        .filter((r): r is ApplicationRow => r !== null)
    },

    async getActivities(applicationIds) {
      if (applicationIds.length === 0) return []
      const { data, error } = await admin
        .from('activities')
        .select('id, application_id, type, occurred_at')
        .in('application_id', applicationIds)
      if (error) {
        console.error('[strategy] getActivities query failed', error)
        return []
      }
      return ((data as { id: string; application_id: string; type: string; occurred_at: string }[] | null) ?? []).map((r) => ({
        id: r.id,
        applicationId: r.application_id,
        type: r.type,
        occurredAt: r.occurred_at,
      }))
    },

    async getResumeDocuments() {
      const { data, error } = await admin
        .from('resume_documents')
        .select('id, job_id, version, source, ats_score, content, content_json')
        .eq('user_id', userId)
      if (error) {
        console.error('[strategy] getResumeDocuments query failed', error)
        return []
      }
      return (
        (data as {
          id: string
          job_id: string | null
          version: number
          source: string | null
          ats_score: number | null
          content: string
          content_json: unknown
        }[] | null) ?? []
      ).map((r) => ({
        id: r.id,
        jobId: r.job_id,
        version: r.version,
        source: r.source,
        atsScore: r.ats_score,
        content: r.content,
        contentJson: (r.content_json ?? null) as ResumeDocumentRow['contentJson'],
      }))
    },

    async getOutreachMessages() {
      const { data, error } = await admin
        .from('outreach_messages')
        .select('id, job_id, company_id, status, kind, sent_at')
        .eq('user_id', userId)
      if (error) {
        console.error('[strategy] getOutreachMessages query failed', error)
        return []
      }
      return (
        (data as { id: string; job_id: string | null; company_id: string | null; status: string; kind: string; sent_at: string | null }[] | null) ?? []
      ).map((r) => ({
        id: r.id,
        jobId: r.job_id,
        companyId: r.company_id,
        status: r.status,
        kind: r.kind,
        sentAt: r.sent_at,
      }))
    },

    async getJobScopeCounts(targeting) {
      const companyIds = await userCompanyIds(admin, userId)
      if (companyIds.length === 0) {
        return {
          totalJobs: 0,
          totalPassingAllConfiguredFilters: 0,
          jobsWithNoDescription: 0,
          excludedByDimension: {},
          excludedByKeywords: null,
          excludedByMinScoreHypothetical: null,
        }
      }

      // `admin` is an untyped service-role client (see ../harness/types.ts's
      // AdminClient doc) so the query-builder chain below is `any` end to
      // end, matching every other admin-client query in this codebase.
      const count = async (build: (q: any) => any): Promise<number> => {
        const base = admin.from('jobs').select('id', { count: 'exact', head: true }).in('company_id', companyIds)
        const { count: n, error } = await build(base)
        if (error) {
          console.error('[strategy] getJobScopeCounts count query failed', error)
          return 0
        }
        return n ?? 0
      }

      const totalJobs = await count((q) => q)
      // "No description" means empty string in THIS database, not SQL NULL —
      // verified directly: `select count(*) from jobs where description is
      // null` returns 0 while `description = ''` returns 14,298 (2026-07-28).
      // description is NOT NULL in the schema (initial_schema.sql), so every
      // scraper that has nothing to say writes '' rather than leaving it
      // unset. Checking both keeps this correct even if that ever changes.
      const jobsWithNoDescription = await count((q) => q.or('description.is.null,description.eq.'))

      // Quality gate mirrors matcher.ts's own reject threshold (jobs the
      // scorer would never even look at, before targeting is applied at all).
      const passingQuality = await count((q) => q.or(`quality_score.is.null,quality_score.gte.${QUALITY_REJECT_THRESHOLD}`))

      // Structural dimensions: mirror matcher.ts's passesQualityAndTargeting
      // semantics exactly — a configured facet only excludes a job that HAS a
      // classified value disagreeing with it; unclassified (NULL/'unknown')
      // rows pass through every facet filter.
      const excludedByDimension: Record<string, number> = {}
      let passingAll = passingQuality

      if (targeting.functions.length > 0) {
        const passingFn = await count((q) =>
          q.or(`quality_score.is.null,quality_score.gte.${QUALITY_REJECT_THRESHOLD}`).or(`job_function.is.null,job_function.eq.unknown,job_function.in.(${targeting.functions.join(',')})`)
        )
        excludedByDimension.functions = passingQuality - passingFn
        passingAll = Math.min(passingAll, passingFn)
      }
      if (targeting.seniority.length > 0) {
        const passingSen = await count((q) =>
          q.or(`quality_score.is.null,quality_score.gte.${QUALITY_REJECT_THRESHOLD}`).or(`seniority.is.null,seniority.eq.unknown,seniority.in.(${targeting.seniority.join(',')})`)
        )
        excludedByDimension.seniority = passingQuality - passingSen
        passingAll = Math.min(passingAll, passingSen)
      }
      if (targeting.countries.length > 0) {
        const passingCountry = await count((q) =>
          q.or(`quality_score.is.null,quality_score.gte.${QUALITY_REJECT_THRESHOLD}`).or(`country.is.null,country.eq.unknown,country.in.(${targeting.countries.join(',')})`)
        )
        excludedByDimension.countries = passingQuality - passingCountry
        passingAll = Math.min(passingAll, passingCountry)
      }
      if (targeting.languages.length > 0) {
        const passingLang = await count((q) =>
          q.or(`quality_score.is.null,quality_score.gte.${QUALITY_REJECT_THRESHOLD}`).or(`language.is.null,language.eq.unknown,language.in.(${targeting.languages.join(',')})`)
        )
        excludedByDimension.languages = passingQuality - passingLang
        passingAll = Math.min(passingAll, passingLang)
      }
      if (targeting.remoteOnly) {
        const passingRemote = await count((q) =>
          q.or(`quality_score.is.null,quality_score.gte.${QUALITY_REJECT_THRESHOLD}`).or('is_remote.is.null,is_remote.eq.true')
        )
        excludedByDimension.remoteOnly = passingQuality - passingRemote
        passingAll = Math.min(passingAll, passingRemote)
      }

      // Now compute the TRUE combined pass count (every configured dimension
      // AND'd together, not just the min of the individual passes above,
      // which can overstate the combined pass rate when dimensions overlap).
      let combined: any = admin.from('jobs').select('id', { count: 'exact', head: true }).in('company_id', companyIds)
      combined = combined.or(`quality_score.is.null,quality_score.gte.${QUALITY_REJECT_THRESHOLD}`)
      if (targeting.functions.length > 0) combined = combined.or(`job_function.is.null,job_function.eq.unknown,job_function.in.(${targeting.functions.join(',')})`)
      if (targeting.seniority.length > 0) combined = combined.or(`seniority.is.null,seniority.eq.unknown,seniority.in.(${targeting.seniority.join(',')})`)
      if (targeting.countries.length > 0) combined = combined.or(`country.is.null,country.eq.unknown,country.in.(${targeting.countries.join(',')})`)
      if (targeting.languages.length > 0) combined = combined.or(`language.is.null,language.eq.unknown,language.in.(${targeting.languages.join(',')})`)
      if (targeting.remoteOnly) combined = combined.or('is_remote.is.null,is_remote.eq.true')
      const { count: combinedCount, error: combinedErr } = await combined
      if (combinedErr) console.error('[strategy] getJobScopeCounts combined query failed', combinedErr)

      // excludedCompanies / excludedKeywords need substring matching over
      // free text (company name / title+description) that PostgREST filters
      // can't express safely for an arbitrary user-entered list — fetch the
      // already-narrowed (quality+structural-filter-passing) id/title/company
      // set and match in JS, exactly like matcher.ts's own fallback path does.
      let excludedByKeywords: number | null = null
      if (targeting.excludedKeywords.length > 0 || targeting.excludedCompanies.length > 0) {
        let textQuery: any = admin.from('jobs').select('id, title, description, companies(name)').in('company_id', companyIds)
        textQuery = textQuery.or(`quality_score.is.null,quality_score.gte.${QUALITY_REJECT_THRESHOLD}`)
        if (targeting.functions.length > 0) textQuery = textQuery.or(`job_function.is.null,job_function.eq.unknown,job_function.in.(${targeting.functions.join(',')})`)
        if (targeting.seniority.length > 0) textQuery = textQuery.or(`seniority.is.null,seniority.eq.unknown,seniority.in.(${targeting.seniority.join(',')})`)
        const { data: textRows, error: textErr } = await textQuery.limit(20000)
        if (textErr) {
          console.error('[strategy] getJobScopeCounts keyword-scan query failed', textErr)
        } else {
          const rows = (textRows as { id: string; title: string | null; description: string | null; companies: { name: string } | { name: string }[] | null }[] | null) ?? []
          let excluded = 0
          for (const r of rows) {
            const companyName = Array.isArray(r.companies) ? r.companies[0]?.name : r.companies?.name
            const nameLower = (companyName ?? '').toLowerCase()
            if (targeting.excludedCompanies.length > 0 && targeting.excludedCompanies.some((c) => nameLower.includes(c))) {
              excluded++
              continue
            }
            if (targeting.excludedKeywords.length > 0) {
              const haystack = `${r.title ?? ''} ${r.description ?? ''}`.toLowerCase()
              if (targeting.excludedKeywords.some((k) => haystack.includes(k))) excluded++
            }
          }
          excludedByKeywords = excluded
        }
      }

      // targeting.minScore is validated/stored but NOT enforced by any
      // filtering code path today (see the field comment in datasource.ts /
      // lib/targeting.ts) — computed here purely as a "what if it were"
      // transparency number, never folded into totalPassingAllConfiguredFilters.
      let excludedByMinScoreHypothetical: number | null = null
      if (targeting.minScore !== null) {
        const passingScore = await count((q) => q.gte('match_score', targeting.minScore as number))
        excludedByMinScoreHypothetical = totalJobs - passingScore
      }

      return {
        totalJobs,
        totalPassingAllConfiguredFilters: combinedCount ?? passingAll,
        jobsWithNoDescription,
        excludedByDimension,
        excludedByKeywords,
        excludedByMinScoreHypothetical,
      }
    },
  }
}
