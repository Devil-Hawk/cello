// GET /api/jobs/insights-summary — aggregates for the /insights charts
// (match-score distribution + source performance). Read-only, RLS-scoped: the
// request-context client (not the admin client) does the query, so — exactly
// like /api/jobs/provenance — "Users can view jobs for own companies" already
// restricts every row to the caller's own jobs with no manual user_id filter.
//
// Two modes:
//   (default)         -> { ok, totalJobs, scoreHistogram, bySource }
//                         aggregated counts only — never ships one row per job
//                         to the browser for what is ultimately five numbers
//                         and a per-source count.
//   ?band=<ScoreBand>  -> { ok, band, jobs, count }
//                         the "explorable" drill-down: the actual jobs in one
//                         score band, evidence (match_details) included, so a
//                         histogram bar can open into the real rows behind it
//                         instead of staying a decorative count.
//
// Paginates the aggregate scan in SUMMARY_PAGE-row chunks exactly like
// /api/jobs/provenance's summary mode, for the same reason: Supabase's
// postgrest layer caps a single request at config.toml's `api.max_rows`
// regardless of .limit(), so reading the whole table needs an explicit
// .range() walk.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { SCORE_BANDS, scoreBandFor, type ScoreBand } from '@/lib/jobs/score-bands'

export const dynamic = 'force-dynamic'

const SUMMARY_PAGE = 1000
/** Safety rail, not a real-world limit — mirrors /api/jobs/provenance. */
const SUMMARY_MAX_ROWS = 200_000

const DEFAULT_DRILLDOWN_LIMIT = 25
const MAX_DRILLDOWN_LIMIT = 100

const VALID_BANDS = new Set<string>(SCORE_BANDS.map((b) => b.key))

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

    let query = supabase
      .from('jobs')
      .select(
        'id, title, url, match_score, match_details, posted_at, companies(name, domain)',
        { count: 'exact' }
      )
      .order('match_score', { ascending: false, nullsFirst: false })
      .limit(limit)

    const meta = SCORE_BANDS.find((b) => b.key === band)!
    query = band === 'unscored' ? query.is('match_score', null) : query.gte('match_score', meta.min!).lte('match_score', meta.max!)

    const { data, error, count } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const rows = (data ?? []) as unknown as {
      id: string
      title: string
      url: string | null
      match_score: number | null
      match_details: unknown
      posted_at: string | null
      companies: CompanyEmbed | CompanyEmbed[] | null
    }[]

    const jobs = rows.map((row) => ({
      id: row.id,
      title: row.title,
      url: row.url,
      matchScore: row.match_score,
      matchDetails: row.match_details,
      postedAt: row.posted_at,
      company: embeddedCompany(row.companies),
    }))

    return NextResponse.json({ ok: true, band, jobs, count: count ?? jobs.length })
  }

  // ---- aggregate summary -----------------------------------------------
  const scoreHistogram: Record<ScoreBand, number> = {
    unscored: 0,
    weak: 0,
    fair: 0,
    good: 0,
    strong: 0,
  }
  const bySource = new Map<string, SourceCounts>()
  let totalJobs = 0

  let from = 0
  for (; from < SUMMARY_MAX_ROWS; from += SUMMARY_PAGE) {
    const { data, error } = await supabase
      .from('jobs')
      .select('source, match_score')
      .order('id', { ascending: true })
      .range(from, from + SUMMARY_PAGE - 1)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // The generated Database type (packages/shared/src/types/database.ts) predates
    // jobs.source — same stale-schema situation /api/jobs/provenance's module doc
    // explains — so supabase-js's typed generic can't confirm the select string
    // client-side; cast through `unknown` like that route does.
    const rows = (data ?? []) as unknown as { source: string | null; match_score: number | null }[]
    for (const row of rows) {
      totalJobs += 1
      scoreHistogram[scoreBandFor(row.match_score)] += 1

      const key = row.source?.trim() || '(untagged)'
      const counts = bySource.get(key) ?? { total: 0, scored: 0 }
      counts.total += 1
      if (row.match_score != null) counts.scored += 1
      bySource.set(key, counts)
    }
    if (rows.length < SUMMARY_PAGE) break
  }

  return NextResponse.json({
    ok: true,
    totalJobs,
    scoreHistogram,
    bySource: Object.fromEntries(bySource),
  })
}
