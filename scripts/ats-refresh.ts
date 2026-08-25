// Scheduled ATS refresh — runs in GitHub Actions via `npx tsx scripts/ats-refresh.ts`.
//
// Iterates ALL companies across users (service role), refreshing each one
// that is due: dream companies hourly, others daily (a larger
// companies.scrape_frequency, in minutes, stretches the interval further).
// Talks to Supabase through plain PostgREST fetch — no npm dependencies.
//
// Env (same repo secrets the Python scraper already uses — none new):
//   SUPABASE_URL          e.g. https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY  service-role key (SUPABASE_SERVICE_ROLE_KEY also accepted)
// Optional:
//   ATS_DRY_RUN=1         fetch + detect but skip all database writes
//
// Prints one telemetry JSON line per company and a final summary line.

import {
  mapWithConcurrency,
  refreshCompany,
  type AtsStore,
  type CompanyInput,
  type CompanyRefreshResult,
  type JobUpsertRow,
} from '../apps/web/lib/ats/index'

const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '')
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const DRY_RUN = process.env.ATS_DRY_RUN === '1'

const PAGE_SIZE = 1000
const COMPANY_CONCURRENCY = 5
// Slack so an hourly cron that drifts a few minutes still counts as "due".
const DUE_SLACK_MINUTES = 5
const DREAM_INTERVAL_MINUTES = 60
const DEFAULT_INTERVAL_MINUTES = 1440

interface CompanyRow {
  id: string
  user_id: string
  name: string
  domain: string | null
  career_url: string | null
  scrape_frequency: number | null
  last_scraped_at: string | null
  is_dream_company: boolean | null
  metadata?: unknown
}

async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`PostgREST ${res.status} on ${path.split('?')[0]}: ${body.slice(0, 300)}`)
  }
  return res
}

async function fetchAllCompanies(): Promise<CompanyRow[]> {
  const companies: CompanyRow[] = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    // select=* so this works whether or not the metadata column exists yet.
    const res = await rest(`companies?select=*&order=created_at.asc&limit=${PAGE_SIZE}&offset=${offset}`)
    const page = (await res.json()) as CompanyRow[]
    companies.push(...page)
    if (page.length < PAGE_SIZE) break
  }
  return companies
}

function isDue(company: CompanyRow, now: number): boolean {
  if (!company.last_scraped_at) return true
  const last = Date.parse(company.last_scraped_at)
  if (Number.isNaN(last)) return true
  const base = company.is_dream_company ? DREAM_INTERVAL_MINUTES : DEFAULT_INTERVAL_MINUTES
  const freq =
    typeof company.scrape_frequency === 'number' && Number.isFinite(company.scrape_frequency)
      ? company.scrape_frequency
      : 0
  // Dream companies refresh hourly, others daily; a user-set frequency can
  // stretch the interval further but never below the tier's base.
  const intervalMinutes = Math.max(base, freq)
  return now - last >= (intervalMinutes - DUE_SLACK_MINUTES) * 60_000
}

const store: AtsStore = {
  async listJobExternalIds(companyId: string): Promise<Set<string>> {
    const ids = new Set<string>()
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const res = await rest(
        `jobs?select=external_id&company_id=eq.${companyId}&limit=${PAGE_SIZE}&offset=${offset}`
      )
      const page = (await res.json()) as Array<{ external_id: string | null }>
      for (const row of page) {
        if (row.external_id) ids.add(row.external_id)
      }
      if (page.length < PAGE_SIZE) break
    }
    return ids
  },

  async upsertJobs(rows: JobUpsertRow[]): Promise<void> {
    if (DRY_RUN) return
    await rest(`jobs?on_conflict=company_id,external_id`, {
      method: 'POST',
      headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows),
    })
  },

  async saveCompanyMetadata(companyId: string, metadata: Record<string, unknown>): Promise<void> {
    if (DRY_RUN) return
    // Throws when the additive metadata column is missing (42703/PGRST204);
    // refreshCompany tolerates that and simply re-detects next run.
    await rest(`companies?id=eq.${companyId}`, {
      method: 'PATCH',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ metadata }),
    })
  },

  async updateCompanyLastScraped(companyId: string): Promise<void> {
    if (DRY_RUN) return
    await rest(`companies?id=eq.${companyId}`, {
      method: 'PATCH',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ last_scraped_at: new Date().toISOString() }),
    })
  },
}

async function main(): Promise<void> {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('ats-refresh: SUPABASE_URL and SUPABASE_SERVICE_KEY env vars are required')
    process.exit(1)
  }

  const startedAt = Date.now()
  let companies: CompanyRow[]
  try {
    companies = await fetchAllCompanies()
  } catch (error) {
    console.error(`ats-refresh: failed to list companies: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
    return
  }

  const now = Date.now()
  const due = companies.filter((c) => isDue(c, now))
  // Dream companies first.
  due.sort((a, b) => Number(Boolean(b.is_dream_company)) - Number(Boolean(a.is_dream_company)))

  console.log(
    JSON.stringify({
      event: 'start',
      dryRun: DRY_RUN,
      companiesTotal: companies.length,
      companiesDue: due.length,
      companiesSkipped: companies.length - due.length,
    })
  )

  const results: CompanyRefreshResult[] = await mapWithConcurrency(due, COMPANY_CONCURRENCY, async (row) => {
    const input: CompanyInput = {
      id: row.id,
      name: row.name,
      domain: row.domain,
      career_url: row.career_url,
      metadata: row.metadata,
    }
    const result = await refreshCompany(store, input)
    console.log(
      JSON.stringify({
        event: 'company',
        companyId: result.companyId,
        companyName: result.companyName,
        dream: Boolean(row.is_dream_company),
        provider: result.provider,
        found: result.found,
        inserted: result.inserted,
        errors: result.errors,
      })
    )
    return result
  })

  const totals = {
    found: results.reduce((sum, r) => sum + r.found, 0),
    inserted: results.reduce((sum, r) => sum + r.inserted, 0),
    companiesWithAts: results.filter((r) => r.provider !== null).length,
    companiesWithErrors: results.filter((r) => r.errors.length > 0).length,
  }
  console.log(
    JSON.stringify({
      event: 'done',
      dryRun: DRY_RUN,
      durationMs: Date.now() - startedAt,
      refreshed: results.length,
      ...totals,
    })
  )
  // Per-company failures are telemetry, not fatal: exit 0.
  process.exit(0)
}

main().catch((error) => {
  console.error(`ats-refresh: fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  process.exit(1)
})
