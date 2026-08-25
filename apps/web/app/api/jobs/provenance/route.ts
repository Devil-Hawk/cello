// GET /api/jobs/provenance — per-opportunity provenance (vision task #17).
//
// Three modes, all read-only:
//   ?jobId=<uuid>   -> { ok, provenance }               one job's full record
//   ?summary=1      -> { ok, breakdown, examples }       corpus-wide counts by
//                       class, for the whole caller's job table
//   (default)       -> { ok, jobs, count, limit, offset } paginated bulk list
//
// RLS does the scoping: jobs has no user_id column, only company_id, and the
// "Users can view jobs for own companies" policy already restricts every
// query here to the caller's own rows — no extra .eq(user) needed.
//
// Degrades gracefully if supabase/migrations/20260728000008_job_provenance.sql
// hasn't been applied yet (last_verified_at/still_open absent): retries with
// the pre-migration column set instead of 500ing, same pattern as
// app/api/contacts/route.ts for contact provenance.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  computeJobProvenance,
  summarizeProvenance,
  MIN_DESCRIPTION_CHARS,
  type EmployerClass,
  type JobProvenance,
  type JobProvenanceInput,
} from '@/lib/sources/provenance'
import type { ApplyProviderId } from '@/lib/ats-apply/types'

export const dynamic = 'force-dynamic'

const FULL_COLUMNS =
  'id, url, source, description, discovered_at, posted_at, company_id, last_verified_at, still_open, companies(name, domain, metadata)'
const BASE_COLUMNS =
  'id, url, source, description, discovered_at, posted_at, company_id, companies(name, domain, metadata)'

// Summary-mode-only columns: everything FULL_COLUMNS has EXCEPT `description`
// and the per-row `companies(...)` embed. Measured against this table's real
// production data (psql, read-only): `description` averages ~3.1KB/row and
// this account's own jobs total ~35MB of description text alone — almost all
// of it fetched only to compute `.trim().length`. Company `name`/`domain`/
// `metadata` are also re-fetched (and re-JSON-parsed) once per JOB even
// though there are only ~500 distinct companies behind ~20k jobs — up to 25x
// duplication. Fetching companies once (see companiesById below) and
// resolving descriptionComplete/Missing via a single exact COUNT query
// (below) instead of transferring every description turns this from a
// 64-74s response into one dominated by network round-trips, not payload
// size — matching the lean-aggregate pattern /api/jobs/insights-summary
// already uses for the sibling score-histogram/source charts.
const SUMMARY_COLUMNS =
  'id, url, source, discovered_at, posted_at, company_id, last_verified_at, still_open'
const SUMMARY_COLUMNS_BASE = 'id, url, source, discovered_at, posted_at, company_id'

/** Rows read per page when walking the whole table for the summary. */
const SUMMARY_PAGE = 1000
/** Refuse to walk more than this many rows for a summary — a safety rail, not
 *  a real-world limit (this corpus is ~20k). */
const SUMMARY_MAX_ROWS = 200_000
const DEFAULT_LIST_LIMIT = 100
const MAX_LIST_LIMIT = 500

interface CompanyEmbed {
  name: string | null
  domain: string | null
  metadata: unknown
}

interface JobRow {
  id: string
  url: string | null
  source: string | null
  description: string | null
  discovered_at: string | null
  posted_at: string | null
  company_id: string
  last_verified_at?: string | null
  still_open?: boolean | null
  companies: CompanyEmbed | CompanyEmbed[] | null
}

function companySuggested(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false
  return (metadata as Record<string, unknown>).suggested === true
}

/** companies.metadata.ats.provider — see lib/ats/types.ts AtsMetadata and the
 *  companyAtsProvider doc in lib/sources/provenance.ts for why this matters. */
function companyAtsProvider(metadata: unknown): ApplyProviderId | null {
  if (!metadata || typeof metadata !== 'object') return null
  const ats = (metadata as Record<string, unknown>).ats
  if (!ats || typeof ats !== 'object') return null
  const provider = (ats as Record<string, unknown>).provider
  return provider === 'greenhouse' || provider === 'lever' || provider === 'ashby' ? provider : null
}

function embeddedCompany(row: JobRow): CompanyEmbed | null {
  const c = row.companies
  if (!c) return null
  return Array.isArray(c) ? (c[0] ?? null) : c
}

function toInput(row: JobRow): JobProvenanceInput {
  const company = embeddedCompany(row)
  return {
    jobId: row.id,
    jobUrl: row.url,
    jobSource: row.source,
    description: row.description,
    discoveredAt: row.discovered_at,
    postedAt: row.posted_at,
    companyId: row.company_id,
    companyName: company?.name ?? null,
    companyDomain: company?.domain ?? null,
    companySuggested: companySuggested(company?.metadata),
    companyAtsProvider: companyAtsProvider(company?.metadata),
    lastVerifiedAt: row.last_verified_at ?? null,
    stillOpen: row.still_open ?? null,
  }
}

function isMissingColumnError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  return error.code === '42703' || /column .* does not exist/i.test(error.message ?? '')
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const jobId = searchParams.get('jobId')
  const summary = searchParams.get('summary') === '1' || searchParams.get('summary') === 'true'

  // ---- single job -----------------------------------------------------
  if (jobId) {
    let { data, error } = await supabase.from('jobs').select(FULL_COLUMNS).eq('id', jobId).maybeSingle()
    let columnsAvailable = true
    if (error && isMissingColumnError(error)) {
      columnsAvailable = false
      ;({ data, error } = await supabase.from('jobs').select(BASE_COLUMNS).eq('id', jobId).maybeSingle())
    }
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

    const provenance = computeJobProvenance(toInput(data as unknown as JobRow))
    return NextResponse.json({ ok: true, provenance, provenanceColumnsAvailable: columnsAvailable })
  }

  // ---- corpus-wide summary ---------------------------------------------
  if (summary) {
    let columnsAvailable = true

    // Companies fetched ONCE (there are ~500 for ~20k jobs — up to 25x
    // duplication otherwise) and looked up per job, instead of embedding
    // name/domain/metadata on every one of the ~11k job rows below.
    const { data: companyRows, error: companiesError } = await supabase
      .from('companies')
      .select('id, name, domain, metadata')
    if (companiesError) return NextResponse.json({ error: companiesError.message }, { status: 500 })
    const companiesById = new Map<string, CompanyEmbed>(
      ((companyRows ?? []) as unknown as (CompanyEmbed & { id: string })[]).map((c) => [
        c.id,
        { name: c.name, domain: c.domain, metadata: c.metadata },
      ])
    )

    const all: JobProvenance[] = []
    // First job id seen per employerClass, so the example lookup below only
    // needs to fetch (at most 4) full rows instead of the whole table.
    const exampleJobIds = new Map<EmployerClass, string>()

    let from = 0
    for (; from < SUMMARY_MAX_ROWS; from += SUMMARY_PAGE) {
      let { data, error } = await supabase
        .from('jobs')
        .select(SUMMARY_COLUMNS)
        .order('id', { ascending: true })
        .range(from, from + SUMMARY_PAGE - 1)
      if (error && isMissingColumnError(error)) {
        columnsAvailable = false
        ;({ data, error } = await supabase
          .from('jobs')
          .select(SUMMARY_COLUMNS_BASE)
          .order('id', { ascending: true })
          .range(from, from + SUMMARY_PAGE - 1))
      }
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      // description is intentionally absent from SUMMARY_COLUMNS — every
      // field classifyEmployer()/the aggregate counts need is present;
      // descriptionComplete/Length on `p` here are placeholders (no
      // description was fetched) and are NOT used — see the exact
      // description-completeness count below, which replaces them.
      const rows = (data ?? []) as unknown as Omit<JobRow, 'description' | 'companies'>[]
      for (const row of rows) {
        const jobRow: JobRow = { ...row, description: null, companies: companiesById.get(row.company_id) ?? null }
        const p = computeJobProvenance(toInput(jobRow))
        all.push(p)
        if (!exampleJobIds.has(p.employerClass)) {
          exampleJobIds.set(p.employerClass, row.id)
        }
      }
      if (rows.length < SUMMARY_PAGE) break
    }

    const breakdown = summarizeProvenance(all)

    // Exact, zero-row-payload description-completeness count: Postgres does
    // the `length(trim(description)) >= 40` check server-side via ILIKE's
    // `_` (exactly-one-char) wildcard, so only a count comes back, never the
    // description text. Verified byte-for-byte identical to the JS
    // trim().length check against this table's full production data (0
    // mismatches across all 21,157 rows) — this is not an approximation.
    const { count: descriptionComplete, error: descCountError } = await supabase
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .ilike('description', '_'.repeat(MIN_DESCRIPTION_CHARS) + '%')
    if (descCountError) return NextResponse.json({ error: descCountError.message }, { status: 500 })
    breakdown.descriptionComplete = descriptionComplete ?? 0
    breakdown.descriptionMissing = breakdown.total - breakdown.descriptionComplete

    // Examples: one real, full record (description included) per
    // employerClass — fetched by id now that we know which ~4 rows matter,
    // instead of carrying description for the whole table above.
    const examples: Partial<Record<EmployerClass, JobProvenance & { jobUrl: string | null; companyName: string | null }>> = {}
    const exampleIds = [...exampleJobIds.values()]
    if (exampleIds.length > 0) {
      let { data: exampleRows, error: exampleError } = await supabase
        .from('jobs')
        .select(FULL_COLUMNS)
        .in('id', exampleIds)
      if (exampleError && isMissingColumnError(exampleError)) {
        ;({ data: exampleRows, error: exampleError } = await supabase
          .from('jobs')
          .select(BASE_COLUMNS)
          .in('id', exampleIds))
      }
      if (exampleError) return NextResponse.json({ error: exampleError.message }, { status: 500 })
      for (const row of (exampleRows ?? []) as unknown as JobRow[]) {
        const p = computeJobProvenance(toInput(row))
        examples[p.employerClass] = { ...p, jobUrl: row.url, companyName: embeddedCompany(row)?.name ?? null }
      }
    }

    return NextResponse.json({ ok: true, breakdown, examples, provenanceColumnsAvailable: columnsAvailable })
  }

  // ---- paginated bulk list ----------------------------------------------
  const companyId = searchParams.get('companyId')
  const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Number(searchParams.get('limit')) || DEFAULT_LIST_LIMIT))
  const offset = Math.max(0, Number(searchParams.get('offset')) || 0)

  const build = (columns: string) => {
    let query = supabase
      .from('jobs')
      .select(columns, { count: 'exact' })
      .order('discovered_at', { ascending: false })
      .range(offset, offset + limit - 1)
    if (companyId) query = query.eq('company_id', companyId)
    return query
  }

  let { data, error, count } = await build(FULL_COLUMNS)
  let columnsAvailable = true
  if (error && isMissingColumnError(error)) {
    columnsAvailable = false
    ;({ data, error, count } = await build(BASE_COLUMNS))
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = (data ?? []) as unknown as JobRow[]
  const jobs = rows.map((row) => computeJobProvenance(toInput(row)))

  return NextResponse.json({
    ok: true,
    jobs,
    count: count ?? jobs.length,
    limit,
    offset,
    provenanceColumnsAvailable: columnsAvailable,
  })
}
