// GET /api/jobs/insights-summary — aggregates for the /insights charts
// (how roles break down by chance + source performance). Read-only, RLS-scoped: the
// request-context client (not the admin client) does the query, so — exactly
// like /api/jobs/provenance — "Users can view jobs for own companies" already
// restricts every row to the caller's own jobs with no manual user_id filter.
//
// Two modes:
//   (default)          -> { ok, totalJobs, chanceHistogram, bySource }
//                         aggregated counts only — never ships one row per job
//                         to the browser for what is ultimately five numbers
//                         and a per-source count.
//   ?band=<ChanceBand> -> { ok, band, jobs, count }
//                         the "explorable" drill-down: the actual roles in one
//                         band, with their verdict columns (chance with cited
//                         evidence), so a bar can open into the real rows behind
//                         it instead of staying a decorative count.
//
// Paginates the aggregate scan in SUMMARY_PAGE-row chunks exactly like
// /api/jobs/provenance's summary mode, for the same reason: Supabase's
// postgrest layer caps a single request at config.toml's `api.max_rows`
// regardless of .limit(), so reading the whole table needs an explicit
// .range() walk.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { CHANCE_BANDS, chanceBandFor, type ChanceBand } from '@/lib/jobs/chance-bands'
import { FIT_COLUMNS } from '@/lib/scoring/read'
import { openRolesOnly } from '@/lib/jobs/freshness'

export const dynamic = 'force-dynamic'

const SUMMARY_PAGE = 1000
/** Safety rail, not a real-world limit — mirrors /api/jobs/provenance. */
const SUMMARY_MAX_ROWS = 200_000

const DEFAULT_DRILLDOWN_LIMIT = 25
const MAX_DRILLDOWN_LIMIT = 100

const VALID_BANDS = new Set<string>(CHANCE_BANDS.map((b) => b.key))

interface SourceCounts {
  total: number
  scored: number
}

interface CompanyEmbed {
  name: string | null
  domain: string | null
}

/** Supabase returns the joined row as an object OR a one-item array depending on
 *  how it infers the relationship direction — normalize once here so the
 *  client-side type is a plain object, not a union it has to defend against. */
function embeddedCompany(value: CompanyEmbed | CompanyEmbed[] | null): CompanyEmbed | null {
  if (!value) return null
  return Array.isArray(value) ? (value[0] ?? null) : value
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const band = searchParams.get('band')

  // ---- drill-down: real jobs behind one histogram bar ----------------------
  if (band) {
    if (!VALID_BANDS.has(band)) {
      return NextResponse.json({ error: `Unknown band "${band}"` }, { status: 400 })
    }
    const limit = Math.min(
      MAX_DRILLDOWN_LIMIT,
      Math.max(1, Number(searchParams.get('limit')) || DEFAULT_DRILLDOWN_LIMIT)
    )

    let query = openRolesOnly(
      supabase
        .from('jobs')
        .select(`id, title, url, posted_at, ${FIT_COLUMNS}, companies(name, domain)`, { count: 'exact' })
    )
      .order('want_p', { ascending: false, nullsFirst: false })
      .limit(limit)

    // A role a stated fact filtered has no chance; a role not yet assessed has neither.
    if (band === 'filtered') query = query.neq('blocked_reasons', '[]')
    else if (band === 'unassessed') query = query.is('fit_assessed_at', null)
    else query = query.eq('chance', band).eq('blocked_reasons', '[]')

    const { data, error, count } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const rows = (data ?? []) as unknown as {
      id: string
      title: string
      url: string | null
      posted_at: string | null
      fit_assessed_at: string | null
      blocked_reasons: unknown
      want_p: number | null
      want_reason: string | null
      want_detail: unknown
      chance: string | null
      chance_detail: unknown
      companies: CompanyEmbed | CompanyEmbed[] | null
    }[]

    const jobs = rows.map((row) => ({
      id: row.id,
      title: row.title,
      url: row.url,
      postedAt: row.posted_at,
      company: embeddedCompany(row.companies),
      // The verdict columns, which the client reads with parseFit.
      fit_assessed_at: row.fit_assessed_at,
      blocked_reasons: row.blocked_reasons,
      want_p: row.want_p,
      want_reason: row.want_reason,
      want_detail: row.want_detail,
      chance: row.chance,
      chance_detail: row.chance_detail,
    }))

    return NextResponse.json({ ok: true, band, jobs, count: count ?? jobs.length })
  }

  // ---- aggregate summary -----------------------------------------------
  const chanceHistogram: Record<ChanceBand, number> = {
    unassessed: 0,
    filtered: 0,
    stretch: 0,
    possible: 0,
    strong: 0,
  }
  const bySource = new Map<string, SourceCounts>()
  let totalJobs = 0

  let from = 0
  for (; from < SUMMARY_MAX_ROWS; from += SUMMARY_PAGE) {
    const { data, error } = await openRolesOnly(
      supabase.from('jobs').select('source, chance, blocked_reasons, fit_assessed_at')
    )
      .order('id', { ascending: true })
      .range(from, from + SUMMARY_PAGE - 1)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // The generated Database type (packages/shared/src/types/database.ts) predates
    // jobs.source — same stale-schema situation /api/jobs/provenance's module doc
    // explains — so supabase-js's typed generic can't confirm the select string
    // client-side; cast through `unknown` like that route does.
    const rows = (data ?? []) as unknown as { source: string | null; chance: string | null; blocked_reasons: unknown; fit_assessed_at: string | null }[]
    for (const row of rows) {
      totalJobs += 1
      chanceHistogram[chanceBandFor(row.chance, row.blocked_reasons)] += 1

      const key = row.source?.trim() || '(untagged)'
      const counts = bySource.get(key) ?? { total: 0, scored: 0 }
      counts.total += 1
      if (row.fit_assessed_at != null) counts.scored += 1
      bySource.set(key, counts)
    }
    if (rows.length < SUMMARY_PAGE) break
  }

  return NextResponse.json({
    ok: true,
    totalJobs,
    chanceHistogram,
    bySource: Object.fromEntries(bySource),
  })
}
