// GET /api/jobs/insights-summary — aggregates for the /insights charts
// (how roles break down by chance + source performance). Read-only, RLS-scoped: the
// request-context client (not the admin client) does the query, so — exactly
// like /api/jobs/provenance, the row level policy on person_roles already
// restricts every row to the caller's own person_roles rows with no manual user_id filter.
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
import { FIT_COLUMNS, type FitRow } from '@/lib/scoring/read'
import { OnJobs } from '@/lib/scoring/person-roles-query'
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

interface DrilldownJob {
  id: string
  title: string
  url: string | null
  posted_at: string | null
  companies: CompanyEmbed | CompanyEmbed[] | null
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

    // Starts at the person's own rows (their verdict is on them) and embeds the posting.
    // A role they hid stays out, as on the Jobs list.
    const on = new OnJobs(
      supabase
        .from('person_roles')
        .select(FIT_COLUMNS + ', jobs!inner(id, title, url, posted_at, companies(name, domain))', { count: 'exact' })
        .is('hidden_reason', null)
    )
    openRolesOnly(on)
    let query = on.query.order('want_p', { ascending: false, nullsFirst: false }).limit(limit)

    // A role a stated fact filtered has no chance; a role not yet assessed has neither.
    if (band === 'filtered') query = query.neq('blocked_reasons', '[]')
    else if (band === 'unassessed') query = query.is('checked_at', null)
    else query = query.eq('chance', band).eq('blocked_reasons', '[]')

    const { data, error, count } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const rows = (data ?? []) as unknown as (FitRow & {
      jobs: DrilldownJob | DrilldownJob[] | null
    })[]

    const jobs = rows.flatMap((row) => {
      const job = Array.isArray(row.jobs) ? row.jobs[0] : row.jobs
      if (!job) return []
      return [
        {
          id: job.id,
          title: job.title,
          url: job.url,
          postedAt: job.posted_at,
          company: embeddedCompany(job.companies),
          // The verdict columns, which the client reads with parseFit.
          checked_at: row.checked_at,
          blocked_reasons: row.blocked_reasons,
          want_p: row.want_p,
          want_reason: row.want_reason,
          want_detail: row.want_detail,
          chance: row.chance,
          chance_detail: row.chance_detail,
        },
      ]
    })

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
    const on = new OnJobs(supabase.from('person_roles').select('chance, blocked_reasons, checked_at, jobs!inner(source)').is('hidden_reason', null))
    openRolesOnly(on)
    const { data, error } = await on.query.order('job_id', { ascending: true }).range(from, from + SUMMARY_PAGE - 1)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // The generated Database type (packages/shared/src/types/database.ts) predates
    // jobs.source, the same stale-schema situation /api/jobs/provenance's module doc
    // explains, so supabase-js's typed generic can't confirm the select string
    // client-side; cast through `unknown` like that route does.
    const rows = (data ?? []) as unknown as { chance: string | null; blocked_reasons: unknown; checked_at: string | null; jobs: { source: string | null } | { source: string | null }[] | null }[]
    for (const row of rows) {
      totalJobs += 1
      chanceHistogram[chanceBandFor(row.chance, row.blocked_reasons)] += 1

      const job = Array.isArray(row.jobs) ? row.jobs[0] : row.jobs
      const key = job?.source?.trim() || '(untagged)'
      const counts = bySource.get(key) ?? { total: 0, scored: 0 }
      counts.total += 1
      if (row.checked_at != null) counts.scored += 1
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
