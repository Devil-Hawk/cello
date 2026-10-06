// Live check of the one reader against twenty real employers. It uses the
// network, so it is not part of CI:
//
//   cd apps/web && nice -n 19 npx tsx scripts/check-sourcing.ts
//
// Each employer is read the way the app reads it: through ingestCompany with the
// reader, an in-memory store (no database) and no model, with the targets
// functions = engineering and data, seniority = junior and mid, country = US
// (a role with no place can never match a country, so it counts as a failure
// here). It prints, per
// employer, the tier that worked, the roles found, how many are inside the
// targets, the newest posting date, three sample titles, the requests made and
// what would be stored (rows and bytes).
//
// Exit codes: 0 all good; 1 a stored role is on another employer's site, older
// than 180 days, or has no place or no description; 3 an employer could not be read (the reason is printed).
//
// Options (env):
//   CHECK_MODE=inline|scheduled   inline (default): what a person gets within seconds.
//                                 scheduled: the background pass (bigger budget, then the browser tier).
//   INGEST_PAGE_FETCHER=python    let the scheduled pass render pages with the Python fetcher.
//   CHECK_ONLY=amazon,apple       only these (matched on lower-cased name).
//   CHECK_EXTRA='Name|domain|https://careers/url;...'   also read these (with CHECK_ONLY set to their names, only these).

import { ingestCompany, type DueCompany } from '../lib/ingest/run'
import { pageFetcherFromEnv } from '../lib/ingest/fetch-page'
import type { ReaderMode } from '../lib/ingest/reader/site-fetch'
import { onOwnSite } from '../lib/ingest/reader/legit'
import { ROLE_MAX_AGE_DAYS } from '../lib/jobs/freshness'
import { targetVerdict } from '../lib/targeting/roles'
import { EMPTY_TARGETING } from '../lib/targeting'
import type { AtsStore, JobUpsertRow } from '../lib/ats/index'
import type { ReaderTargets } from '../lib/ingest/reader/targets'

interface Employer {
  name: string
  domain: string
  careers: string
}

const EMPLOYERS: Employer[] = [
  { name: 'Amazon', domain: 'amazon.com', careers: 'https://www.amazon.jobs/en/search' },
  { name: 'Apple', domain: 'apple.com', careers: 'https://jobs.apple.com/en-us/search' },
  { name: 'Meta', domain: 'meta.com', careers: 'https://www.metacareers.com/jobs/' },
  { name: 'Google', domain: 'google.com', careers: 'https://www.google.com/about/careers/applications/jobs/results/' },
  { name: 'Microsoft', domain: 'microsoft.com', careers: 'https://jobs.careers.microsoft.com/global/en/search' },
  { name: 'Netflix', domain: 'netflix.com', careers: 'https://explore.jobs.netflix.net/careers' },
  { name: 'Stripe', domain: 'stripe.com', careers: 'https://stripe.com/jobs' },
  { name: 'Anthropic', domain: 'anthropic.com', careers: 'https://www.anthropic.com/careers' },
  { name: 'Datadog', domain: 'datadoghq.com', careers: 'https://careers.datadoghq.com/' },
  { name: 'DigitalOcean', domain: 'digitalocean.com', careers: 'https://www.digitalocean.com/careers' },
  { name: 'Roblox', domain: 'roblox.com', careers: 'https://careers.roblox.com/' },
  { name: 'Affirm', domain: 'affirm.com', careers: 'https://www.affirm.com/careers' },
  { name: 'Cursor', domain: 'cursor.com', careers: 'https://cursor.com/careers' },
  { name: 'Dataiku', domain: 'dataiku.com', careers: 'https://www.dataiku.com/careers/' },
  { name: 'Zynga', domain: 'zynga.com', careers: 'https://www.zynga.com/careers/' },
  { name: 'Uber', domain: 'uber.com', careers: 'https://www.uber.com/us/en/careers/list/' },
  { name: 'Walmart', domain: 'walmart.com', careers: 'https://careers.walmart.com/' },
  { name: 'The New York Times', domain: 'nytco.com', careers: 'https://www.nytco.com/careers/' },
  { name: 'TikTok', domain: 'tiktok.com', careers: 'https://lifeattiktok.com/' },
  { name: 'Bending Spoons', domain: 'bendingspoons.com', careers: 'https://jobs.bendingspoons.com/' },
]

const TARGETS: ReaderTargets = {
  targeting: { ...EMPTY_TARGETING, functions: ['engineering', 'data'], seniority: ['junior', 'mid'], countries: ['US'] },
  titles: [],
}

/** An AtsStore that keeps everything in memory: no database is touched. */
function memoryStore() {
  const rows: JobUpsertRow[] = []
  const metadata: Record<string, unknown>[] = []
  const store: AtsStore = {
    async listJobs() {
      return []
    },
    async upsertJobs(r) {
      rows.push(...r)
    },
    async updateJobs(r) {
      return r.length
    },
    async recordSightings(_c, ids) {
      return { seen: ids.length, reopened: 0, missed: 0, closed: 0 }
    },
    async saveCompanyMetadata(_id, m) {
      metadata.push(m)
    },
    async updateCompanyLastScraped() {},
    async clearBoardJobs() {
      return { deleted: 0, closed: 0 }
    },
  }
  return { store, rows, metadata }
}

const day = 86_400_000

async function main(): Promise<void> {
  const mode: ReaderMode = process.env.CHECK_MODE === 'scheduled' ? 'scheduled' : 'inline'
  const only = (process.env.CHECK_ONLY ?? '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean)
  const fetchPage = pageFetcherFromEnv(process.env.INGEST_PAGE_FETCHER)
  const extra: Employer[] = (process.env.CHECK_EXTRA ?? '').split(';').filter(Boolean).map((x) => {
    const [name, domain, careers] = x.split('|')
    return { name, domain, careers }
  })
  const list = [...EMPLOYERS, ...extra].filter((e) => !only.length || only.some((o) => e.name.toLowerCase().includes(o)))

  const failures: string[] = []
  const unread: string[] = []
  const table: string[][] = []
  console.log(`check-sourcing: ${list.length} employers, mode ${mode}, rendered fetcher ${process.env.INGEST_PAGE_FETCHER === 'python' ? 'python' : 'off (static)'}\n`)

  for (const e of list) {
    const { store, rows, metadata } = memoryStore()
    const company: DueCompany = {
      id: `check-${e.name}`,
      user_id: 'check',
      name: e.name,
      domain: e.domain,
      career_url: e.careers,
      metadata: {},
      scrape_frequency: null,
      last_scraped_at: null,
      is_dream_company: false,
    }
    const started = Date.now()
    const outcome = await ingestCompany(store, company, { fetchPage, model: null, mode, targets: TARGETS })
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    const meta = metadata[metadata.length - 1] ?? {}
    const check = (meta.source_check ?? {}) as { readable?: boolean; reason?: string; requests?: number }
    // The reader makes its own fetcher inside ingestCompany, so its clock starts with the read, not before the board stage.
    const requests = check.requests ?? 0
    const ats = (meta.ats ?? null) as { provider?: string; token?: string; verified_by?: string } | null

    const inside = rows.filter((r) =>
      targetVerdict(
        { title: r.title, description: r.description, job_function: r.job_function, seniority: r.seniority, country: r.country, language: r.language, is_remote: r.is_remote },
        TARGETS.targeting,
        e.name
      ) === 'inside'
    ).length
    const dated = rows.map((r) => (r.posted_at ? Date.parse(r.posted_at) : NaN)).filter((t) => !Number.isNaN(t))
    const newest = dated.length ? new Date(Math.max(...dated)).toISOString().slice(0, 10) : 'undated'
    const samples = rows.slice(0, 3).map((r) => r.title)
    const bytes = rows.reduce((n, r) => n + JSON.stringify(r).length, 0)
    const excluded = outcome.result.excluded

    // The two guarantees: every stored role is on the employer's own site (or its verified board), and none is older than 180 days.
    const ctx = { company: { name: e.name, domain: e.domain, careerUrl: e.careers } }
    const onBoard = Boolean(ats?.verified_by)
    // A role with no place cannot match a country target, and one with no text cannot be read: both are failures.
    const noPlace = rows.filter((r) => !r.location?.trim())
    const noText = rows.filter((r) => !r.description?.trim())
    for (const r of noPlace.slice(0, 3)) failures.push(`${e.name}: ${r.url} has no location`)
    // A board's adapter fills text a few roles per refresh (its own budget), so only the reader's own tiers must have it at once.
    if (!onBoard) for (const r of noText.slice(0, 3)) failures.push(`${e.name}: ${r.url} has no description`)
    for (const r of rows) {
      if (!onBoard && !onOwnSite(r.url, ctx)) failures.push(`${e.name}: ${r.url} is not on the employer's own site`)
      if (r.posted_at && Date.now() - Date.parse(r.posted_at) > ROLE_MAX_AGE_DAYS * day) failures.push(`${e.name}: ${r.url} is older than ${ROLE_MAX_AGE_DAYS} days`)
    }

    const tier = outcome.tier ? `${outcome.tier}${ats ? `:${ats.provider}` : ''}` : '-'
    // "Read" means a tier answered with roles (or, for a sitemap, listed them and has read the newest few so far).
    const status = outcome.tier ? 'read' : outcome.reading ? 'reading: only the scheduled pass can read this site' : `COULD NOT READ (${check.reason ?? outcome.failure ?? 'no_roles'})`
    if (!outcome.tier) unread.push(`${e.name}: ${outcome.reading ? 'reading' : (check.reason ?? outcome.failure ?? 'no_roles')}`)
    table.push([e.name, tier, String(outcome.result.found), String(rows.length), String(inside), `${noPlace.length}/${noText.length}`, newest, String(requests), `${(bytes / 1024).toFixed(0)} KB`, seconds + 's', status])
    console.log(`${e.name}`)
    console.log(`  tier ${tier}${ats ? ` (verified by ${ats.verified_by})` : ''}, ${status}, ${seconds}s`)
    console.log(`  roles found ${outcome.result.found}, to store ${rows.length}, inside targets ${inside}, no place ${noPlace.length}, no description ${noText.length}, newest ${newest}, requests ${requests}, ${(bytes / 1024).toFixed(0)} KB`)
    if (excluded) console.log(`  not stored: ${Object.entries(excluded).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`)
    for (const t of samples) console.log(`  - ${t}`)
    if (outcome.message) console.log(`  ${outcome.message}`)
    const reader = (meta.reader ?? {}) as { tried?: { tier: string; outcome: string; detail?: string }[]; listed?: number; read?: number }
    if (reader.tried?.length) console.log(`  tried ${reader.tried.map((t) => `${t.tier}:${t.outcome}${t.detail ? `(${t.detail})` : ''}`).join(' ')}${reader.listed ? `; the site lists about ${reader.listed}, read ${reader.read ?? 0}` : ''}`)
  }

  console.log('\nname | tier | found | store | inside | no place/no text | newest | requests | size | time | status')
  for (const row of table) console.log(row.join(' | '))
  const worst = table.reduce((m, r) => Math.max(m, Number(r[3])), 0)
  console.log(`\nmost rows for one employer: ${worst} (cap 200)`)
  if (failures.length) {
    console.log('\nFAILED guarantees:')
    for (const f of failures) console.log(`  ${f}`)
  }
  if (unread.length) {
    console.log('\nnot read:')
    for (const u of unread) console.log(`  ${u}`)
  }
  process.exit(failures.length ? 1 : unread.length ? 3 : 0)
}

main().catch((error) => {
  console.error(`check-sourcing: fatal (${error instanceof Error ? error.name : typeof error})`)
  process.exit(2)
})
