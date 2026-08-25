/**
 * Purge synthesized-garbage jobs and the aggregator-auto-created companies the
 * user never chose to track.
 *
 * IRREVERSIBLE. Defaults to a dry run; nothing is deleted without --apply.
 *
 *   set -a && source /path/to/prod.env && set +a
 *
 *   npx tsx scripts/purge-garbage.ts                 # dry run (default)
 *   npx tsx scripts/purge-garbage.ts --apply         # actually delete
 *   npx tsx scripts/purge-garbage.ts --examples 40   # more sample titles
 *   npx tsx scripts/purge-garbage.ts --env-file .env.local
 *
 * Run scripts/backfill-classification.ts FIRST: this script trusts the stored
 * jobs.quality_score for the score half of the garbage test.
 *
 * WHAT COUNTS AS A GARBAGE JOB
 *   classifyJob(title, companyName).rejectReason is set  (city name, bare
 *   department word, nav link text, URL slug, company name, single non-role
 *   word), or the stored quality_score is below QUALITY_REJECT_THRESHOLD.
 *   rejectReason depends only on the title and the company name, so it is
 *   recomputed here without re-reading descriptions; the SCORE is never
 *   recomputed (a score computed without the description would be lower than
 *   the stored one and could condemn a real posting).
 *
 * WHAT IS NEVER DELETED
 *   jobs      any job with an application, an application draft, an interview
 *             kit or an outreach message attached (applications and interview
 *             kits cascade off jobs — deleting the job would delete the user's
 *             pipeline row).
 *   companies anything with an application, a generated dossier, a contact, an
 *             interview kit, an outreach message, a working ATS provider in
 *             metadata, is_dream_company, hand-written notes, or ANY remaining
 *             non-garbage job. Only companies that fail every one of those tests
 *             AND look auto-created are removed.
 *
 * HOW "AUTO-CREATED" IS IDENTIFIED
 *   1. metadata.suggested === true            (what the current ingest paths write)
 *   2. no ATS in metadata + career_url on an aggregator host (arbeitnow,
 *      remoteok, themuse, ycombinator, devitjobs, linkedin, ...)
 *   3. no ATS in metadata + career_url is a bare homepage or missing — the
 *      "epias GmbH" tell-tale that made the HTML scraper crawl a homepage.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { QUALITY_REJECT_THRESHOLD, classifyJob, type RejectReason } from '../lib/jobs/classify'

/** Rows read per SELECT page (keyset paginated on id). */
const READ_PAGE = 4000
/** Ids per DELETE statement. */
const DELETE_BATCH = 500
/**
 * Refuse to delete more than this share of the jobs table without --force. A
 * classifier regression must not be able to empty the table by accident.
 */
const MAX_DELETE_SHARE = 0.25

// ---------------------------------------------------------------------------
// Env + psql plumbing (kept local so this script has no npm dependencies)
// ---------------------------------------------------------------------------

function loadEnvFile(path: string): void {
  const abs = isAbsolute(path) ? path : join(process.cwd(), path)
  let text: string
  try {
    text = readFileSync(abs, 'utf8')
  } catch {
    return
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    if (!(m[1] in process.env)) process.env[m[1]] = v
  }
}

function resolveDbUrl(): string {
  const url =
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DB_URL
  if (!url) {
    throw new Error(
      'No database URL. Set POSTGRES_URL_NON_POOLING (or POSTGRES_URL / DATABASE_URL / ' +
        'SUPABASE_DB_URL), e.g. `set -a && source prod.env && set +a`.'
    )
  }
  return url
}

function psqlQuery(dbUrl: string, sql: string): string {
  const res = spawnSync(
    'psql',
    [dbUrl, '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-Atq', '-c', sql],
    { encoding: 'utf8', maxBuffer: 1 << 29 }
  )
  if (res.error) throw res.error
  if (res.status !== 0) throw new Error(`psql query failed (${res.status}): ${res.stderr?.trim()}`)
  return res.stdout
}

function psqlExec(dbUrl: string, sql: string): string {
  const res = spawnSync(
    'psql',
    [dbUrl, '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '-'],
    { encoding: 'utf8', input: sql, maxBuffer: 1 << 29 }
  )
  if (res.error) throw res.error
  if (res.status !== 0) throw new Error(`psql exec failed (${res.status}): ${res.stderr?.trim()}`)
  return res.stdout
}

// ---------------------------------------------------------------------------
// Provenance heuristics
// ---------------------------------------------------------------------------

/**
 * Hosts that serve OTHER people's job listings. A career_url here was written by
 * an ingest path from an aggregator lead, never typed in by the user.
 */
const AGGREGATOR_HOST_RE =
  /(^|\.)(arbeitnow\.com|remoteok\.(com|io)|themuse\.com|ycombinator\.com|workatastartup\.com|hn\.algolia\.com|devitjobs\.(uk|com)|linkedin\.com|indeed\.(com|de)|glassdoor\.(com|de)|ziprecruiter\.com|dice\.com|monster\.com|seek\.com|stepstone\.de|xing\.com|wellfound\.com|angel\.co|otta\.com|uctalent\.io|join\.com|dover\.com)$/i

type AutoCreatedReason = 'metadata.suggested' | 'aggregator career_url' | 'bare-homepage career_url'

function hostOf(url: string | null): string {
  if (!url) return ''
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function isBareHomepage(url: string | null): boolean {
  if (!url || !url.trim()) return true
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return (parsed.pathname === '' || parsed.pathname === '/') && !parsed.search && !parsed.hash
}

function autoCreatedReason(c: CompanyRow): AutoCreatedReason | null {
  if (c.suggested) return 'metadata.suggested'
  if (c.ats_provider) return null
  if (AGGREGATOR_HOST_RE.test(hostOf(c.career_url))) return 'aggregator career_url'
  if (isBareHomepage(c.career_url)) return 'bare-homepage career_url'
  return null
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface JobRow {
  id: string
  title: string | null
  company_id: string
  company_name: string | null
  quality_score: number | null
  source: string | null
  has_application: boolean
  has_draft: boolean
  has_kit: boolean
  has_outreach: boolean
}

interface CompanyRow {
  id: string
  name: string | null
  career_url: string | null
  is_dream_company: boolean
  has_notes: boolean
  ats_provider: string | null
  suggested: boolean
  jobs_total: number
  has_application: boolean
  has_dossier: boolean
  has_contacts: boolean
  has_kits: boolean
  has_outreach: boolean
}

type GarbageBucket = RejectReason | 'low-quality-score'

interface GarbageJob {
  id: string
  title: string
  company: string
  companyId: string
  bucket: GarbageBucket
  score: number | null
  source: string
  protectedBy: string | null
}

function jobsPageSql(afterId: string | null): string {
  const where = afterId ? `WHERE j.id > '${afterId}'::uuid` : ''
  return `
    SELECT coalesce(json_agg(t), '[]'::json)::text FROM (
      SELECT j.id, j.title, j.company_id, j.quality_score, j.source,
             c.name AS company_name,
             EXISTS (SELECT 1 FROM public.applications a WHERE a.job_id = j.id) AS has_application,
             EXISTS (SELECT 1 FROM public.application_drafts d WHERE d.job_id = j.id) AS has_draft,
             EXISTS (SELECT 1 FROM public.interview_kits k WHERE k.job_id = j.id) AS has_kit,
             EXISTS (SELECT 1 FROM public.outreach_messages o WHERE o.job_id = j.id) AS has_outreach
      FROM public.jobs j
      LEFT JOIN public.companies c ON c.id = j.company_id
      ${where}
      ORDER BY j.id ASC
      LIMIT ${READ_PAGE}
    ) t`
}

const COMPANIES_SQL = `
  SELECT coalesce(json_agg(t), '[]'::json)::text FROM (
    SELECT c.id, c.name, c.career_url, c.is_dream_company,
           (c.notes IS NOT NULL AND btrim(c.notes) <> '') AS has_notes,
           coalesce(c.metadata, '{}'::jsonb) -> 'ats' ->> 'provider' AS ats_provider,
           (coalesce(c.metadata, '{}'::jsonb) ->> 'suggested') = 'true' AS suggested,
           (SELECT count(*) FROM public.jobs j WHERE j.company_id = c.id)::int AS jobs_total,
           EXISTS (SELECT 1 FROM public.applications a JOIN public.jobs j ON j.id = a.job_id
                    WHERE j.company_id = c.id) AS has_application,
           EXISTS (SELECT 1 FROM public.company_dossiers d WHERE d.company_id = c.id) AS has_dossier,
           EXISTS (SELECT 1 FROM public.contacts ct WHERE ct.company_id = c.id) AS has_contacts,
           EXISTS (SELECT 1 FROM public.interview_kits k WHERE k.company_id = c.id) AS has_kits,
           EXISTS (SELECT 1 FROM public.outreach_messages o WHERE o.company_id = c.id) AS has_outreach
    FROM public.companies c
    ORDER BY c.id ASC
  ) t`

// ---------------------------------------------------------------------------
// Reporting helpers
// ---------------------------------------------------------------------------

function tally<T extends string>(items: T[]): Array<[T, number]> {
  const m = new Map<T, number>()
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}

function idList(ids: string[]): string {
  return ids.map((id) => `'${id}'`).join(',')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const envIdx = argv.indexOf('--env-file')
  if (envIdx > -1 && argv[envIdx + 1]) loadEnvFile(argv[envIdx + 1])
  loadEnvFile('.env.local')

  const apply = argv.includes('--apply')
  const force = argv.includes('--force')
  const exIdx = argv.indexOf('--examples')
  const exampleCount = exIdx > -1 && argv[exIdx + 1] ? Math.max(1, Number(argv[exIdx + 1])) : 20
  const dbUrl = resolveDbUrl()

  console.log('purge-garbage')
  console.log(`  mode : ${apply ? 'APPLY — DELETES ARE PERMANENT' : 'DRY RUN (default) — pass --apply to delete'}`)
  console.log(`  reject threshold : quality_score < ${QUALITY_REJECT_THRESHOLD}`)

  const beforeRaw = psqlQuery(
    dbUrl,
    `SELECT (SELECT count(*) FROM public.jobs) || ' ' || (SELECT count(*) FROM public.companies) || ' ' ||
            (SELECT count(*) FROM public.jobs WHERE quality_score IS NULL)`
  ).trim()
  const [beforeJobsStr, beforeCompaniesStr, unscoredStr] = beforeRaw.split(' ')
  const beforeJobs = Number(beforeJobsStr)
  const beforeCompanies = Number(beforeCompaniesStr)
  const unscored = Number(unscoredStr)
  console.log(`\nBEFORE : ${beforeJobs} jobs, ${beforeCompanies} companies`)
  if (unscored > 0) {
    console.log(
      `  WARNING: ${unscored} jobs have no quality_score. Run scripts/backfill-classification.ts first —\n` +
        '           those rows are judged on their title alone here.'
    )
  }

  // -- 1. classify every job title ------------------------------------------
  const garbage: GarbageJob[] = []
  const garbagePerCompany = new Map<string, number>()
  const protectedJobs: GarbageJob[] = []
  let scanned = 0
  let afterId: string | null = null

  for (;;) {
    const raw = psqlQuery(dbUrl, jobsPageSql(afterId)).trim()
    const rows = JSON.parse(raw || '[]') as JobRow[]
    if (rows.length === 0) break

    for (const row of rows) {
      scanned++
      const title = row.title ?? ''
      // Title-and-company only: rejectReason never reads the description, and the
      // stored score (computed WITH the description) is used for the score test.
      const reason = classifyJob({ title, companyName: row.company_name }).rejectReason
      const lowScore = row.quality_score !== null && row.quality_score < QUALITY_REJECT_THRESHOLD
      if (!reason && !lowScore) continue

      const keptBy =
        (row.has_application && 'application') ||
        (row.has_draft && 'application draft') ||
        (row.has_kit && 'interview kit') ||
        (row.has_outreach && 'outreach message') ||
        null

      const entry: GarbageJob = {
        id: row.id,
        title,
        company: row.company_name ?? '(unknown company)',
        companyId: row.company_id,
        bucket: reason ?? 'low-quality-score',
        score: row.quality_score,
        source: row.source ?? 'unknown',
        protectedBy: keptBy,
      }
      if (keptBy) {
        protectedJobs.push(entry)
        continue
      }
      garbage.push(entry)
      garbagePerCompany.set(entry.companyId, (garbagePerCompany.get(entry.companyId) ?? 0) + 1)
    }

    afterId = rows[rows.length - 1].id
    process.stderr.write(`\r  scanned ${scanned} jobs   `)
    if (rows.length < READ_PAGE) break
  }
  process.stderr.write('\n')

  // -- 2. garbage-job report ------------------------------------------------
  console.log(`\n=== GARBAGE JOBS ===`)
  console.log(`  ${garbage.length} of ${scanned} jobs would be deleted (${((garbage.length / Math.max(1, scanned)) * 100).toFixed(1)}%)`)
  console.log('\n  by reason:')
  for (const [bucket, n] of tally(garbage.map((g) => g.bucket))) {
    console.log(`    ${bucket.padEnd(24)} ${String(n).padStart(6)}`)
  }
  console.log('\n  by source:')
  const bySource = tally(garbage.map((g) => g.companyId))
  void bySource
  console.log(`\n  example titles (up to ${exampleCount}, spread across reasons):`)
  const byBucket = new Map<GarbageBucket, GarbageJob[]>()
  for (const g of garbage) {
    const list = byBucket.get(g.bucket) ?? []
    list.push(g)
    byBucket.set(g.bucket, list)
  }
  const examples: GarbageJob[] = []
  for (let round = 0; examples.length < exampleCount; round++) {
    let added = false
    for (const list of byBucket.values()) {
      if (round < list.length && examples.length < exampleCount) {
        examples.push(list[round])
        added = true
      }
    }
    if (!added) break
  }
  for (const g of examples) {
    console.log(
      `    ${truncate(JSON.stringify(g.title), 44).padEnd(46)} ${String(g.score ?? '-').padStart(3)}  ${g.bucket.padEnd(22)} ${truncate(g.company, 28)}`
    )
  }
  if (protectedJobs.length > 0) {
    console.log(`\n  KEPT despite looking like garbage — user data attached (${protectedJobs.length}):`)
    for (const g of protectedJobs.slice(0, 20)) {
      console.log(`    ${truncate(JSON.stringify(g.title), 44).padEnd(46)} ${g.bucket.padEnd(22)} has ${g.protectedBy}`)
    }
  }

  // -- 3. company decisions -------------------------------------------------
  const companies = JSON.parse(psqlQuery(dbUrl, COMPANIES_SQL).trim() || '[]') as CompanyRow[]
  interface Decision {
    company: CompanyRow
    reason: AutoCreatedReason
    garbageJobs: number
    remainingJobs: number
    keepBecause: string | null
  }
  const decisions: Decision[] = []
  for (const c of companies) {
    const reason = autoCreatedReason(c)
    if (!reason) continue
    const garbageJobs = garbagePerCompany.get(c.id) ?? 0
    const remainingJobs = c.jobs_total - garbageJobs
    const keepBecause =
      (c.has_application && 'has an application') ||
      (c.has_dossier && 'has a generated dossier') ||
      (c.ats_provider && `has a working ATS (${c.ats_provider})`) ||
      (c.has_contacts && 'has contacts') ||
      (c.has_kits && 'has an interview kit') ||
      (c.has_outreach && 'has outreach messages') ||
      (c.is_dream_company && 'is marked a dream company') ||
      (c.has_notes && 'has hand-written notes') ||
      (remainingJobs > 0 && `still has ${remainingJobs} non-garbage job(s)`) ||
      null
    decisions.push({ company: c, reason, garbageJobs, remainingJobs, keepBecause })
  }
  const toDelete = decisions.filter((d) => d.keepBecause === null)
  const kept = decisions.filter((d) => d.keepBecause !== null)

  console.log(`\n=== COMPANIES ===`)
  console.log(
    `  ${companies.length} tracked, ${decisions.length} look auto-created, ${toDelete.length} would be deleted, ${kept.length} auto-created but kept`
  )
  if (toDelete.length > 0) {
    console.log('\n  would DELETE (cascade removes their jobs):')
    for (const d of toDelete) {
      console.log(
        `    ${truncate(d.company.name ?? '(unnamed)', 30).padEnd(32)} jobs=${String(d.company.jobs_total).padStart(4)} garbage=${String(d.garbageJobs).padStart(4)}  ${d.reason.padEnd(24)} ${truncate(d.company.career_url ?? '(no career_url)', 60)}`
      )
    }
  }
  if (kept.length > 0) {
    console.log('\n  auto-created but KEPT:')
    const keepTally = tally(kept.map((k) => k.keepBecause!.replace(/\d+/g, 'N')))
    for (const [why, n] of keepTally) console.log(`    ${String(n).padStart(4)}  ${why}`)
  }

  // -- 4. safety rails ------------------------------------------------------
  const share = garbage.length / Math.max(1, scanned)
  if (share > MAX_DELETE_SHARE && !force) {
    console.log(
      `\nREFUSING: ${(share * 100).toFixed(1)}% of the jobs table is flagged, above the ${(MAX_DELETE_SHARE * 100).toFixed(0)}% rail. ` +
        'Check the classifier before proceeding (pass --force to override).'
    )
    process.exit(2)
  }
  const leaked = garbage.filter((g) => g.protectedBy !== null)
  if (leaked.length > 0) throw new Error(`internal: ${leaked.length} protected jobs leaked into the delete set`)
  const deleteIds = new Set(toDelete.map((d) => d.company.id))
  for (const c of companies) {
    if (!deleteIds.has(c.id)) continue
    if (c.has_application || c.has_dossier || c.ats_provider) {
      throw new Error(`internal: company ${c.name ?? c.id} is protected but was selected for deletion`)
    }
  }

  if (!apply) {
    console.log(
      `\nDRY RUN — nothing was deleted. Re-run with --apply to remove ${garbage.length} jobs and ${toDelete.length} companies.`
    )
    return
  }

  // -- 5. delete ------------------------------------------------------------
  console.log('\n=== APPLYING ===')
  let deletedJobs = 0
  const jobIds = garbage.map((g) => g.id)
  for (let i = 0; i < jobIds.length; i += DELETE_BATCH) {
    const chunk = jobIds.slice(i, i + DELETE_BATCH)
    const out = psqlExec(
      dbUrl,
      `SET client_min_messages TO warning;\nDELETE FROM public.jobs WHERE id IN (${idList(chunk)});\n`
    )
    for (const m of out.matchAll(/^DELETE (\d+)$/gm)) deletedJobs += Number(m[1])
    process.stderr.write(`\r  deleted ${deletedJobs} jobs   `)
  }
  process.stderr.write('\n')

  let deletedCompanies = 0
  const companyIds = toDelete.map((d) => d.company.id)
  for (let i = 0; i < companyIds.length; i += DELETE_BATCH) {
    const chunk = companyIds.slice(i, i + DELETE_BATCH)
    const out = psqlExec(
      dbUrl,
      `SET client_min_messages TO warning;\nDELETE FROM public.companies WHERE id IN (${idList(chunk)});\n`
    )
    for (const m of out.matchAll(/^DELETE (\d+)$/gm)) deletedCompanies += Number(m[1])
  }
  console.log(`  deleted ${deletedJobs} jobs and ${deletedCompanies} companies`)

  // -- 6. after + verification ---------------------------------------------
  const afterRaw = psqlQuery(
    dbUrl,
    `SELECT (SELECT count(*) FROM public.jobs) || ' ' || (SELECT count(*) FROM public.companies) || ' ' ||
            (SELECT count(*) FROM public.jobs WHERE quality_score < ${QUALITY_REJECT_THRESHOLD}) || ' ' ||
            (SELECT count(*) FROM public.applications) || ' ' ||
            (SELECT count(*) FROM public.company_dossiers)`
  ).trim()
  const [afterJobs, afterCompanies, afterLow, afterApps, afterDossiers] = afterRaw.split(' ')
  console.log(`\nAFTER  : ${afterJobs} jobs (was ${beforeJobs}), ${afterCompanies} companies (was ${beforeCompanies})`)
  console.log(`  jobs still below the reject threshold : ${afterLow}`)
  console.log(`  applications preserved               : ${afterApps}`)
  console.log(`  dossiers preserved                   : ${afterDossiers}`)

  // Re-classify every surviving title: the honest test of whether any
  // blocklisted / single-word garbage title is left.
  let survivingRejects = 0
  const surviving: Array<[string, string]> = []
  afterId = null
  for (;;) {
    const raw = psqlQuery(dbUrl, jobsPageSql(afterId)).trim()
    const rows = JSON.parse(raw || '[]') as JobRow[]
    if (rows.length === 0) break
    for (const row of rows) {
      const reason = classifyJob({ title: row.title ?? '', companyName: row.company_name }).rejectReason
      if (reason) {
        survivingRejects++
        if (surviving.length < 15) surviving.push([row.title ?? '', reason])
      }
    }
    afterId = rows[rows.length - 1].id
    if (rows.length < READ_PAGE) break
  }
  console.log(`  remaining single-word/blocklisted titles : ${survivingRejects} (target 0)`)
  for (const [t, r] of surviving) console.log(`    ${JSON.stringify(t)} — ${r}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
