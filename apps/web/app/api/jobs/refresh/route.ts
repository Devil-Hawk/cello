// POST /api/jobs/refresh — refresh jobs from public ATS APIs (Greenhouse,
// Lever, Ashby) for one company ({ companyId }) or all of the caller's
// companies (empty body).
//
// Frozen contract:
//   request:  { companyId?: string }
//   200:      { ok, results: [{ companyId, companyName, provider, found,
//               inserted, errors[] }], totals: { found, inserted, companiesWithAts } }
// provider:null means no ATS board was detected (UI may fall back to
// POST /api/scraper/trigger). Per-company failures land in errors[] — one
// failing company never fails the run.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  mapWithConcurrency,
  refreshCompany,
  type AtsStore,
  type CompanyInput,
  type CompanyRefreshResult,
  type JobUpsertRow,
} from '@/lib/ats'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const COMPANY_CONCURRENCY = 5
const PAGE_SIZE = 1000

type ServerSupabase = Awaited<ReturnType<typeof createClient>>

function makeStore(supabase: ServerSupabase): AtsStore {
  return {
    async listJobExternalIds(companyId: string): Promise<Set<string>> {
      const ids = new Set<string>()
      // Pagination within a company is always sequential.
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await supabase
          .from('jobs')
          .select('external_id')
          .eq('company_id', companyId)
          .range(from, from + PAGE_SIZE - 1)
        if (error) throw new Error(error.message)
        for (const row of data ?? []) {
          if (row.external_id) ids.add(row.external_id)
        }
        if (!data || data.length < PAGE_SIZE) break
      }
      return ids
    },

    async upsertJobs(rows: JobUpsertRow[]): Promise<void> {
      const { error } = await supabase
        .from('jobs')
        .upsert(rows, { onConflict: 'company_id,external_id', ignoreDuplicates: false })
      if (error) throw new Error(error.message)
    },

    async backfillJobDescriptions(
      rows: { company_id: string; external_id: string; description: string }[]
    ): Promise<number> {
      // One statement per row, but only for rows whose description is still
      // empty — the `.or()` guard makes this a no-op for anything already
      // populated, so a refresh can never clobber a stored description.
      let changed = 0
      for (const row of rows) {
        const { data, error } = await supabase
          .from('jobs')
          .update({ description: row.description })
          .eq('company_id', row.company_id)
          .eq('external_id', row.external_id)
          .or('description.is.null,description.eq.')
          .select('id')
        if (error) throw new Error(error.message)
        changed += (data as unknown[] | null)?.length ?? 0
      }
      return changed
    },

    async saveCompanyMetadata(companyId: string, metadata: Record<string, unknown>): Promise<void> {
      const { error } = await supabase
        .from('companies')
        .update({ metadata: metadata as never })
        .eq('id', companyId)
      // Throw so refreshCompany's tolerant catch handles a missing column
      // (42703 / PGRST204) the same as any other metadata write failure.
      if (error) throw new Error(error.message)
    },

    async updateCompanyLastScraped(companyId: string): Promise<void> {
      const { error } = await supabase
        .from('companies')
        .update({ last_scraped_at: new Date().toISOString() })
        .eq('id', companyId)
      if (error) throw new Error(error.message)
    },
  }
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let companyId: string | undefined
  try {
    const body = await request.json()
    if (body && typeof body === 'object' && typeof body.companyId === 'string' && body.companyId) {
      companyId = body.companyId
    }
  } catch {
    // Empty/absent body → refresh all companies.
  }

  // select('*') (not an explicit column list) so this works whether or not
  // the additive companies.metadata migration has been applied yet.
  let query = supabase.from('companies').select('*').eq('user_id', user.id)
  if (companyId) {
    query = query.eq('id', companyId)
  }
  const { data: companies, error: companiesError } = await query

  if (companiesError) {
    return NextResponse.json({ error: companiesError.message }, { status: 500 })
  }
  if (companyId && (!companies || companies.length === 0)) {
    return NextResponse.json({ error: 'Company not found' }, { status: 404 })
  }

  const store = makeStore(supabase)
  const inputs: CompanyInput[] = (companies ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    domain: c.domain,
    career_url: c.career_url,
    metadata: (c as { metadata?: unknown }).metadata,
  }))

  // Max 5 companies in parallel; per-company work is sequential internally.
  const results: CompanyRefreshResult[] = await mapWithConcurrency(
    inputs,
    COMPANY_CONCURRENCY,
    (company) => refreshCompany(store, company)
  )

  const totals = {
    found: results.reduce((sum, r) => sum + r.found, 0),
    inserted: results.reduce((sum, r) => sum + r.inserted, 0),
    companiesWithAts: results.filter((r) => r.provider !== null).length,
  }

  return NextResponse.json({ ok: true, results, totals })
}
