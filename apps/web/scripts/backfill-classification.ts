/**
 * Backfill the job-classification columns over EVERY existing row using the same
 * pure classifier the ingest paths use (lib/jobs/classify.ts). No LLM, no network
 * calls, no cost — classifyJob is deterministic, so this script is idempotent and
 * safe to re-run as often as you like.
 *
 * Columns written: job_function, seniority, language, country, is_remote,
 *                  job_type, quality_score, source.
 *
 *   # source the DB env first (never commit or echo these values)
 *   set -a && source /path/to/prod.env && set +a
 *
 *   npx tsx scripts/backfill-classification.ts                 # classify + write
 *   npx tsx scripts/backfill-classification.ts --dry-run       # report only
 *   npx tsx scripts/backfill-classification.ts --only-missing   # rows with quality_score IS NULL
 *   npx tsx scripts/backfill-classification.ts --sql-out f.sql # emit SQL, write nothing
 *   npx tsx scripts/backfill-classification.ts --limit 50      # smoke test
 *   npx tsx scripts/backfill-classification.ts --env-file .env.local
 *
 * Connection: POSTGRES_URL_NON_POOLING (preferred), else POSTGRES_URL,
 * DATABASE_URL or SUPABASE_DB_URL. All DB work goes through the `psql` binary so
 * the script needs zero npm dependencies (same constraint as scripts/ats-refresh.ts).
 *
 * Idempotency: every UPDATE carries an `IS DISTINCT FROM` guard, so a second run
 * reports "0 rows changed" instead of rewriting identical values.
 *
 * Provenance rules (deliberately conservative — an existing, meaningful value is
 * never clobbered):
 *   source    kept as-is unless it is NULL or the placeholder 'unknown'
 *   job_type  kept as-is when it is already one of the canonical JobType values
 *             (raw ATS spellings like FULL_TIME are normalized); anything else,
 *             including 'unknown', is replaced with the classifier's answer
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import {
  CLASSIFIER_VERSION,
  JOB_FUNCTIONS,
  QUALITY_REJECT_THRESHOLD,
  SENIORITY_LEVELS,
  classifyJob,
  type Classification,
  type JobType,
} from '../lib/jobs/classify'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Rows read per SELECT (keyset paginated on id). */
const READ_PAGE = 2000
/** Rows per UPDATE ... FROM (VALUES ...) statement. */
const WRITE_BATCH = 500
/**
 * Descriptions are truncated on read. classifyJob only ever looks at the first
 * 4000 chars (language) / 1200 chars (job type) and otherwise just tests
 * `length >= 200`, so truncating at 5000 yields byte-identical output while
 * keeping the read payload small.
 */
const DESCRIPTION_CHARS = 5000

// ---------------------------------------------------------------------------
// Env + psql plumbing
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

/** Run a read-only query and return its single unaligned text result. */
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

/** Execute a script through psql inside ONE transaction; returns its stdout. */
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

function sqlStr(v: string | null): string {
  return v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`
}

// ---------------------------------------------------------------------------
// Provenance inference
// ---------------------------------------------------------------------------

/**
 * The vocabulary jobs.source uses across the codebase: the three ATS providers
 * (lib/ats/types.ts AtsProviderId), the five aggregator adapters
 * (lib/sources/types.ts SourceId), the HTML scraper, the Gmail importer, and
 * 'unknown' when nothing in the row identifies its origin.
 */
type SourceId =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'themuse'
  | 'arbeitnow'
  | 'remoteok'
  | 'hackernews'
  | 'ycombinator'
  | 'scraper'
  | 'gmail'
  | 'unknown'

interface JobRow {
  id: string
  title: string | null
  description: string | null
  location: string | null
  url: string | null
  external_id: string | null
  job_type: string | null
  source: string | null
  job_function: string | null
  seniority: string | null
  language: string | null
  country: string | null
  is_remote: boolean | null
  quality_score: number | null
  company_name: string | null
  ats_provider: string | null
}

/**
 * Infer where a row came from, in three tiers of decreasing confidence:
 *  1. a provider/aggregator fingerprint in the url or external_id — Greenhouse
 *     emits absolute_url on the employer's own domain, so `?gh_jid=` matters as
 *     much as the boards.greenhouse.io host;
 *  2. the tracked company's own ATS provider (companies.metadata.ats.provider);
 *  3. an employer-domain URL on a company with no ATS at all — only the HTML
 *     scraper creates those.
 */
function inferSource(row: JobRow): SourceId {
  const hay = `${row.external_id ?? ''} ${row.url ?? ''}`.toLowerCase()

  // 1. explicit fingerprints
  if (hay.includes('news.ycombinator') || hay.includes('hn.algolia')) return 'hackernews'
  if (hay.includes('workatastartup') || hay.includes('ycombinator.com')) return 'ycombinator'
  if (hay.includes('greenhouse.io') || hay.includes('grnh.se') || hay.includes('gh_jid')) {
    return 'greenhouse'
  }
  if (hay.includes('lever.co') || hay.includes('lever_jid')) return 'lever'
  if (hay.includes('ashbyhq.com') || hay.includes('ashby_jid')) return 'ashby'
  if (hay.includes('themuse.com')) return 'themuse'
  if (hay.includes('arbeitnow.com')) return 'arbeitnow'
  if (hay.includes('remoteok.com') || hay.includes('remoteok.io')) return 'remoteok'
  if (hay.includes('gmail') || hay.includes('mail.google.com')) return 'gmail'

  // 2. the company's tracked ATS
  const provider = (row.ats_provider ?? '').toLowerCase()
  if (provider === 'greenhouse' || provider === 'lever' || provider === 'ashby') return provider

  // 3. employer-domain URL, no ATS anywhere: the HTML scraper is the only path
  //    that produces those.
  if (!provider && /^https?:\/\//.test(row.url ?? '')) return 'scraper'

  return 'unknown'
}

const CANONICAL_JOB_TYPES = new Set<string>([
  'full-time', 'part-time', 'contract', 'internship', 'temporary', 'unknown',
])

/** Raw ATS/JSON-LD spellings -> canonical JobType. */
const JOB_TYPE_ALIASES: Record<string, JobType> = {
  full_time: 'full-time', fulltime: 'full-time', permanent: 'full-time', regular: 'full-time',
  part_time: 'part-time', parttime: 'part-time',
  contractor: 'contract', freelance: 'contract', b2b: 'contract',
  intern: 'internship', internships: 'internship', trainee: 'internship',
  temp: 'temporary', seasonal: 'temporary', interim: 'temporary',
}

/**
 * A stored job_type wins only when it is already meaningful. Raw ATS spellings
 * are normalized; 'unknown' and outright garbage (the old scraper wrote whole
 * title+location strings into this column) defer to the classifier.
 */
function resolveJobType(existing: string | null, classified: JobType): JobType {
  const raw = (existing ?? '').trim().toLowerCase()
  if (!raw) return classified
  if (CANONICAL_JOB_TYPES.has(raw)) return raw === 'unknown' ? classified : (raw as JobType)
  const alias = JOB_TYPE_ALIASES[raw.replace(/[\s-]+/g, '_')]
  if (alias) return alias
  return classified
}

/** An existing source is kept unless it is missing or the 'unknown' placeholder. */
function resolveSource(existing: string | null, inferred: SourceId): SourceId {
  const raw = (existing ?? '').trim()
  if (raw && raw.toLowerCase() !== 'unknown') return raw as SourceId
  return inferred
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

class Counter {
  private readonly map = new Map<string, number>()
  bump(key: string, by = 1): void {
    this.map.set(key, (this.map.get(key) ?? 0) + by)
  }
  get(key: string): number {
    return this.map.get(key) ?? 0
  }
  get total(): number {
    let n = 0
    for (const v of this.map.values()) n += v
    return n
  }
  /** Entries sorted by count desc, then key asc. */
  ranked(): Array<[string, number]> {
    return [...this.map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }
}

function bar(n: number, max: number, width = 36): string {
  if (max <= 0) return ''
  return '#'.repeat(Math.max(n > 0 ? 1 : 0, Math.round((n / max) * width)))
}

function printTable(title: string, rows: Array<[string, number]>, total: number): void {
  console.log(`\n${title}`)
  if (rows.length === 0) {
    console.log('  (none)')
    return
  }
  const keyWidth = Math.min(28, Math.max(...rows.map(([k]) => k.length)))
  const max = Math.max(...rows.map(([, v]) => v))
  for (const [k, v] of rows) {
    const pct = total > 0 ? ((v / total) * 100).toFixed(1).padStart(5) : ' 0.0'
    console.log(`  ${k.padEnd(keyWidth)}  ${String(v).padStart(6)}  ${pct}%  ${bar(v, max)}`)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Args {
  dryRun: boolean
  onlyMissing: boolean
  sqlOut: string | null
  limit: number | null
}

function parseArgs(argv: string[]): Args {
  const envIdx = argv.indexOf('--env-file')
  if (envIdx > -1 && argv[envIdx + 1]) loadEnvFile(argv[envIdx + 1])
  loadEnvFile('.env.local')

  const sqlIdx = argv.indexOf('--sql-out')
  const limitIdx = argv.indexOf('--limit')
  return {
    dryRun: argv.includes('--dry-run'),
    onlyMissing: argv.includes('--only-missing'),
    sqlOut: sqlIdx > -1 && argv[sqlIdx + 1] ? argv[sqlIdx + 1] : null,
    limit: limitIdx > -1 && argv[limitIdx + 1] ? Number(argv[limitIdx + 1]) : null,
  }
}

function readPageSql(afterId: string | null, onlyMissing: boolean, limit: number): string {
  const where: string[] = []
  if (afterId) where.push(`j.id > '${afterId}'::uuid`)
  if (onlyMissing) where.push('j.quality_score IS NULL')
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  return `
    SELECT coalesce(json_agg(t), '[]'::json)::text FROM (
      SELECT j.id,
             j.title,
             left(j.description, ${DESCRIPTION_CHARS}) AS description,
             j.location,
             j.url,
             j.external_id,
             j.job_type,
             j.source,
             j.job_function,
             j.seniority,
             j.language,
             j.country,
             j.is_remote,
             j.quality_score,
             c.name AS company_name,
             coalesce(c.metadata, '{}'::jsonb) -> 'ats' ->> 'provider' AS ats_provider
      FROM public.jobs j
      LEFT JOIN public.companies c ON c.id = j.company_id
      ${whereSql}
      ORDER BY j.id ASC
      LIMIT ${limit}
    ) t`
}

interface Desired {
  id: string
  jobFunction: string
  seniority: string
  language: string
  country: string | null
  isRemote: boolean
  jobType: JobType
  qualityScore: number
  source: SourceId
}

function valuesTuple(d: Desired, cast: boolean): string {
  const t = cast ? '::text' : ''
  return (
    `('${d.id}'::uuid,${sqlStr(d.jobFunction)}${t},${sqlStr(d.seniority)}${t},` +
    `${sqlStr(d.language)}${t},${d.country === null ? 'NULL::text' : sqlStr(d.country) + t},` +
    `${d.isRemote ? 'true' : 'false'}${cast ? '::boolean' : ''},${sqlStr(d.jobType)}${t},` +
    `${d.qualityScore}${cast ? '::integer' : ''},${sqlStr(d.source)}${t})`
  )
}

function updateStatement(batch: Desired[]): string {
  const tuples = batch.map((d, i) => valuesTuple(d, i === 0)).join(',\n    ')
  return (
    'UPDATE public.jobs AS j SET\n' +
    '  job_function = v.job_function,\n' +
    '  seniority = v.seniority,\n' +
    '  language = v.language,\n' +
    '  country = v.country,\n' +
    '  is_remote = v.is_remote,\n' +
    '  job_type = v.job_type,\n' +
    '  quality_score = v.quality_score,\n' +
    '  source = v.source\n' +
    'FROM (VALUES\n    ' +
    tuples +
    '\n) AS v(id, job_function, seniority, language, country, is_remote, job_type, quality_score, source)\n' +
    'WHERE j.id = v.id AND (\n' +
    '  j.job_function IS DISTINCT FROM v.job_function OR\n' +
    '  j.seniority IS DISTINCT FROM v.seniority OR\n' +
    '  j.language IS DISTINCT FROM v.language OR\n' +
    '  j.country IS DISTINCT FROM v.country OR\n' +
    '  j.is_remote IS DISTINCT FROM v.is_remote OR\n' +
    '  j.job_type IS DISTINCT FROM v.job_type OR\n' +
    '  j.quality_score IS DISTINCT FROM v.quality_score OR\n' +
    '  j.source IS DISTINCT FROM v.source\n' +
    ');'
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const dbUrl = resolveDbUrl()
  const write = !args.dryRun && !args.sqlOut

  console.log('backfill-classification')
  console.log(`  classifier version : ${CLASSIFIER_VERSION}`)
  console.log(`  reject threshold   : quality_score < ${QUALITY_REJECT_THRESHOLD}`)
  console.log(`  scope              : ${args.onlyMissing ? 'rows with quality_score IS NULL' : 'all jobs'}`)
  console.log(
    `  mode               : ${write ? 'APPLY (writes to the database)' : args.sqlOut ? `SQL only -> ${args.sqlOut}` : 'DRY RUN (no writes)'}`
  )

  const before = psqlQuery(
    dbUrl,
    `SELECT count(*) || ' ' || count(quality_score) || ' ' || count(job_function) || ' ' || count(source) FROM public.jobs`
  ).trim()
  const [beforeTotal, beforeScored, beforeFn, beforeSource] = before.split(' ')
  console.log(
    `\nbefore: ${beforeTotal} jobs — ${beforeScored} with quality_score, ${beforeFn} with job_function, ${beforeSource} with source`
  )

  const fn = new Counter()
  const seniority = new Counter()
  const language = new Counter()
  const country = new Counter()
  const source = new Counter()
  const reject = new Counter()
  const buckets = new Counter()
  let scanned = 0
  let changed = 0
  let lowQuality = 0
  const sqlChunks: string[] = []

  let afterId: string | null = null
  for (;;) {
    const remaining = args.limit === null ? READ_PAGE : Math.max(0, args.limit - scanned)
    if (remaining === 0) break
    const pageSize = Math.min(READ_PAGE, remaining)

    const raw = psqlQuery(dbUrl, readPageSql(afterId, args.onlyMissing, pageSize)).trim()
    const rows = JSON.parse(raw || '[]') as JobRow[]
    if (rows.length === 0) break

    const desired: Desired[] = []
    for (const row of rows) {
      const c: Classification = classifyJob({
        title: row.title ?? '',
        description: row.description,
        location: row.location,
        companyName: row.company_name,
      })
      const d: Desired = {
        id: row.id,
        jobFunction: c.jobFunction,
        seniority: c.seniority,
        language: c.language,
        country: c.country,
        isRemote: c.isRemote,
        jobType: resolveJobType(row.job_type, c.jobType),
        qualityScore: c.qualityScore,
        source: resolveSource(row.source, inferSource(row)),
      }
      desired.push(d)

      scanned++
      fn.bump(d.jobFunction)
      seniority.bump(d.seniority)
      language.bump(d.language)
      country.bump(d.country ?? '(unknown)')
      source.bump(d.source)
      if (c.rejectReason) reject.bump(c.rejectReason)
      if (c.qualityScore < QUALITY_REJECT_THRESHOLD) lowQuality++
      const lo = Math.min(90, Math.floor(c.qualityScore / 10) * 10)
      buckets.bump(`${String(lo).padStart(3)}-${lo === 90 ? '100' : String(lo + 9).padStart(3)}`)
    }

    for (let i = 0; i < desired.length; i += WRITE_BATCH) {
      const stmt = updateStatement(desired.slice(i, i + WRITE_BATCH))
      if (write) {
        const out = psqlExec(dbUrl, `SET client_min_messages TO warning;\n${stmt}\n`)
        for (const m of out.matchAll(/^UPDATE (\d+)$/gm)) changed += Number(m[1])
      } else {
        sqlChunks.push(stmt)
      }
    }

    afterId = rows[rows.length - 1].id
    process.stderr.write(`\r  processed ${scanned} rows${write ? ` (${changed} changed)` : ''}   `)
    if (rows.length < pageSize) break
  }
  process.stderr.write('\n')

  if (args.sqlOut) {
    const path = args.sqlOut
    writeFileSync(
      path,
      ['-- generated by scripts/backfill-classification.ts (re-runnable)', 'BEGIN;', ...sqlChunks, 'COMMIT;'].join(
        '\n\n'
      ) + '\n',
      'utf8'
    )
    console.log(`\nSQL written to ${path} (${sqlChunks.length} statements) — nothing applied.`)
  }

  console.log(`\nrows classified   : ${scanned}`)
  if (write) console.log(`rows changed      : ${changed}`)
  console.log(`low quality (<${QUALITY_REJECT_THRESHOLD}) : ${lowQuality}  ${lowQuality ? '-> run scripts/purge-garbage.ts' : ''}`)

  printTable('job_function', JOB_FUNCTIONS.map((f) => [f, fn.get(f)] as [string, number]).filter(([, v]) => v > 0), scanned)
  printTable(
    'seniority',
    SENIORITY_LEVELS.map((s) => [s, seniority.get(s)] as [string, number]).filter(([, v]) => v > 0),
    scanned
  )
  printTable('language', language.ranked(), scanned)
  printTable('country', country.ranked(), scanned)
  printTable('source', source.ranked(), scanned)
  printTable('reject reasons', reject.ranked(), scanned)
  printTable(
    'quality_score histogram',
    buckets.ranked().sort((a, b) => a[0].localeCompare(b[0])),
    scanned
  )

  if (write) {
    const after = psqlQuery(
      dbUrl,
      `SELECT count(*) || ' ' || count(quality_score) || ' ' || count(job_function) || ' ' || count(source) ||
              ' ' || count(*) FILTER (WHERE quality_score < ${QUALITY_REJECT_THRESHOLD}) FROM public.jobs`
    ).trim()
    const [t, q, f, s, low] = after.split(' ')
    console.log(
      `\nafter: ${t} jobs — ${q} with quality_score, ${f} with job_function, ${s} with source, ${low} below the reject threshold`
    )
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
