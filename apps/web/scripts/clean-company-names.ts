/**
 * Clean up junk company names — mostly Gmail-derived companies whose "name"
 * ended up being an email subject line or a raw domain instead of an actual
 * company name (e.g. "Re: Thank you for your application", "unsubscribe",
 * "acme.com").
 *
 * IRREVERSIBLE for deletions. Defaults to a dry run; nothing is written
 * without --apply.
 *
 *   set -a && source /path/to/prod.env && set +a
 *
 *   npx tsx scripts/clean-company-names.ts                 # dry run (default)
 *   npx tsx scripts/clean-company-names.ts --apply         # actually write
 *   npx tsx scripts/clean-company-names.ts --env-file .env.local
 *
 * WHAT COUNTS AS A JUNK NAME (any one of):
 *   - longer than 40 characters
 *   - contains '?', or one of: "Re:", "Fwd:", "change this", "thank",
 *     "application", "unsubscribe" (case-insensitive)
 *   - the name IS the domain (e.g. name "acme.com", domain "acme.com")
 *   - looks like a sentence fragment rather than a company name (ends in
 *     '.'/'!', is 6+ words, is an all-lowercase multi-word phrase, or
 *     contains a word from a small "email boilerplate" word list)
 *
 * WHAT HAPPENS TO A JUNK ROW
 *   - zero jobs AND zero applications  -> propose DELETE (safe: nothing of
 *     the user's is attached to this row).
 *   - has a job or an application      -> never delete (would cascade-delete
 *     the user's pipeline data). Instead propose a REPAIR: reuses the same
 *     domain -> proper-name directory as app/api/companies/fix-names/route.ts
 *     (now centralized in lib/companies/known-companies.ts) when the domain
 *     is recognized; otherwise falls back to a title-cased guess from the
 *     domain, same heuristic already used by app/api/companies/verify/route.ts.
 *   - has a job or an application AND no domain to repair from -> FLAGGED for
 *     manual review. Never deleted, never silently left renamed to itself.
 *
 * Prints full before/after counts and the full list of every affected row —
 * this table is small (Gmail-ingested junk, not the jobs table), so no
 * sampling like scripts/purge-garbage.ts does for job titles.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { lookupKnownCompanyByDomain } from '../lib/companies/known-companies'

/** Ids per UPDATE/DELETE statement. */
const WRITE_BATCH = 200
/**
 * Refuse to delete more than this share of the ENTIRE companies table
 * without --force. A classifier regression must not be able to empty the
 * table by accident.
 */
const MAX_DELETE_SHARE = 0.5

// ---------------------------------------------------------------------------
// Env + psql plumbing (kept local so this script has no npm dependencies —
// same pattern as scripts/purge-garbage.ts).
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

function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

// ---------------------------------------------------------------------------
// Junk-name heuristics
// ---------------------------------------------------------------------------

type JunkReason =
  | 'too-long'
  | 'question-mark'
  | 'email-boilerplate'
  | 'equals-domain'
  | 'sentence-fragment'

const BOILERPLATE_PHRASES = ['re:', 'fwd:', 'change this', 'thank', 'application', 'unsubscribe']

function boilerplatePhrase(name: string): string | null {
  const lower = name.toLowerCase()
  for (const phrase of BOILERPLATE_PHRASES) {
    if (lower.includes(phrase)) return phrase
  }
  return null
}

// Grammatical function words that essentially never appear in a company name
// (as opposed to content nouns like "security"/"code"/"update" which are both
// common boilerplate AND common in real company names — e.g. "Variant
// Security", "CodeMetal" — so deliberately left out to avoid false positives).
const SENTENCE_WORDS = new Set([
  'please', 'click', 'here', 'your', 'you', 'we', 'has', 'have', 'was', 'were',
  'this', 'that', 'regarding', 'reminder', 'congratulations', 'invoice',
  'confirmation', 'submission',
])

// Legal-entity suffixes: a lowercase multi-word name ending in one of these is
// almost certainly a real (if uncapitalized) company name — "etalytics gmbh"
// — not a sentence fragment, so it's exempted from the all-lowercase check.
const ENTITY_SUFFIXES = new Set([
  'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'llc', 'llp',
  'ltd', 'limited', 'gmbh', 'plc', 'sa', 'ag', 'nv', 'bv', 'srl', 'pty', 'kg',
])

function looksLikeSentenceFragment(name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed) return false
  if (/[.!]$/.test(trimmed)) return true // company names don't end in '.' or '!'
  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length >= 6) return true // too many words for a company name
  const lastWord = words[words.length - 1]?.replace(/[.,]+$/, '').toLowerCase()
  const hasEntitySuffix = ENTITY_SUFFIXES.has(lastWord ?? '')
  if (words.length >= 2 && trimmed === trimmed.toLowerCase() && !hasEntitySuffix) return true // all-lowercase phrase
  if (words.some((w) => SENTENCE_WORDS.has(w.toLowerCase().replace(/[^a-z]/g, '')))) return true
  return false
}

function normalizeForDomainCompare(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '')
}

function equalsDomain(name: string, domain: string | null): boolean {
  if (!domain) return false
  return normalizeForDomainCompare(name) === normalizeForDomainCompare(domain)
}

function classifyJunk(name: string, domain: string | null): JunkReason[] {
  const reasons: JunkReason[] = []
  if (name.length > 40) reasons.push('too-long')
  if (name.includes('?')) reasons.push('question-mark')
  if (boilerplatePhrase(name)) reasons.push('email-boilerplate')
  if (equalsDomain(name, domain)) reasons.push('equals-domain')
  if (looksLikeSentenceFragment(name)) reasons.push('sentence-fragment')
  return reasons
}

// ---------------------------------------------------------------------------
// Repair proposal — reuses the same domain -> proper-name directory as
// app/api/companies/fix-names/route.ts (now centralized in
// lib/companies/known-companies.ts); falls back to the same
// title-case-the-domain heuristic app/api/companies/verify/route.ts already
// uses when a domain isn't in the known-companies directory.
// ---------------------------------------------------------------------------

// Hosts that serve OTHER people's job listings — mirrors scripts/purge-garbage.ts's
// AGGREGATOR_HOST_RE. A career_url on one of these was written by an ingest path
// from an aggregator lead, so its hostname is the aggregator's, never the
// company's own domain — using it for a repair name would produce nonsense
// like "We Love X GmbH" -> "Arbeitnow".
const AGGREGATOR_HOST_RE =
  /(^|\.)(arbeitnow\.com|remoteok\.(com|io)|themuse\.com|ycombinator\.com|workatastartup\.com|hn\.algolia\.com|devitjobs\.(uk|com)|linkedin\.com|indeed\.(com|de)|glassdoor\.(com|de)|ziprecruiter\.com|dice\.com|monster\.com|seek\.com|stepstone\.de|xing\.com|wellfound\.com|angel\.co|otta\.com|uctalent\.io|join\.com|dover\.com)$/i

function domainFromCareerUrl(url: string | null): string | null {
  if (!url || !url.trim()) return null
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

/** The company's own domain — never an aggregator's. Null when we can't tell. */
function usableDomain(domain: string | null, careerUrl: string | null): string | null {
  for (const candidate of [domain?.trim(), domainFromCareerUrl(careerUrl) ?? undefined]) {
    if (candidate && !AGGREGATOR_HOST_RE.test(candidate.toLowerCase())) return candidate
  }
  return null
}

function titleCaseFromDomain(domain: string): string {
  const base = domain.replace(/^(jobs|careers)\./, '').split('.')[0]
  if (!base) return domain
  return base.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

interface RepairProposal {
  name: string
  confident: boolean // true when it came from the known-companies directory
}

function proposeRepair(domain: string | null, careerUrl: string | null): RepairProposal | null {
  const effectiveDomain = usableDomain(domain, careerUrl)
  if (!effectiveDomain) return null
  const known = lookupKnownCompanyByDomain(effectiveDomain)
  if (known) return { name: known.name, confident: true }
  const guess = titleCaseFromDomain(effectiveDomain)
  return guess ? { name: guess, confident: false } : null
}

// ---------------------------------------------------------------------------
// Row shapes + queries
// ---------------------------------------------------------------------------

interface CompanyRow {
  id: string
  name: string | null
  domain: string | null
  career_url: string | null
  jobs_total: number
  has_application: boolean
}

const COMPANIES_SQL = `
  SELECT coalesce(json_agg(t), '[]'::json)::text FROM (
    SELECT c.id, c.name, c.domain, c.career_url,
           (SELECT count(*) FROM public.jobs j WHERE j.company_id = c.id)::int AS jobs_total,
           EXISTS (SELECT 1 FROM public.applications a JOIN public.jobs j ON j.id = a.job_id
                    WHERE j.company_id = c.id) AS has_application
    FROM public.companies c
    ORDER BY c.id ASC
  ) t`

type Action = 'delete' | 'repair' | 'flag'

interface Decision {
  company: CompanyRow
  reasons: JunkReason[]
  action: Action
  newName?: string
  repairConfident?: boolean
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
  const dbUrl = resolveDbUrl()

  console.log('clean-company-names')
  console.log(`  mode : ${apply ? 'APPLY — WRITES ARE PERMANENT' : 'DRY RUN (default) — pass --apply to write'}`)

  const beforeRaw = psqlQuery(dbUrl, `SELECT count(*) FROM public.companies`).trim()
  const beforeCompanies = Number(beforeRaw)
  console.log(`\nBEFORE : ${beforeCompanies} companies`)

  const companies = JSON.parse(psqlQuery(dbUrl, COMPANIES_SQL).trim() || '[]') as CompanyRow[]

  const decisions: Decision[] = []
  for (const c of companies) {
    const name = c.name ?? ''
    const reasons = classifyJunk(name, c.domain)
    if (reasons.length === 0) continue

    if (c.jobs_total === 0 && !c.has_application) {
      decisions.push({ company: c, reasons, action: 'delete' })
      continue
    }

    const repair = proposeRepair(c.domain, c.career_url)
    if (repair && repair.name !== name) {
      decisions.push({ company: c, reasons, action: 'repair', newName: repair.name, repairConfident: repair.confident })
    } else {
      // Has user data attached, but no distinct corrected name to offer —
      // never delete, never silently no-op. Left for a human.
      decisions.push({ company: c, reasons, action: 'flag' })
    }
  }

  const toDelete = decisions.filter((d) => d.action === 'delete')
  const toRepair = decisions.filter((d) => d.action === 'repair')
  const flagged = decisions.filter((d) => d.action === 'flag')

  console.log(`\n=== INVENTORY ===`)
  console.log(
    `  ${decisions.length} of ${companies.length} companies look like junk names: ` +
      `${toDelete.length} would be deleted, ${toRepair.length} would be repaired, ${flagged.length} flagged for manual review`
  )

  if (toDelete.length > 0) {
    console.log(`\n  would DELETE — zero jobs, zero applications (${toDelete.length}):`)
    for (const d of toDelete) {
      console.log(
        `    ${d.company.id}  ${truncate(JSON.stringify(d.company.name ?? ''), 44).padEnd(46)} ${d.reasons.join(',').padEnd(28)} domain=${d.company.domain ?? '(none)'}`
      )
    }
  }

  if (toRepair.length > 0) {
    console.log(`\n  would REPAIR — has jobs/applications, corrected name available (${toRepair.length}):`)
    for (const d of toRepair) {
      console.log(
        `    ${d.company.id}  ${truncate(JSON.stringify(d.company.name ?? ''), 34).padEnd(36)} -> ${JSON.stringify(d.newName).padEnd(24)} ` +
          `${d.repairConfident ? '(known)' : '(guess)'}  jobs=${d.company.jobs_total} app=${d.company.has_application ? 'yes' : 'no'}  ${d.reasons.join(',')}`
      )
    }
  }

  if (flagged.length > 0) {
    console.log(`\n  FLAGGED for manual review — has jobs/applications, no confident rename (${flagged.length}):`)
    for (const d of flagged) {
      console.log(
        `    ${d.company.id}  ${truncate(JSON.stringify(d.company.name ?? ''), 44).padEnd(46)} ${d.reasons.join(',').padEnd(28)} jobs=${d.company.jobs_total} app=${d.company.has_application ? 'yes' : 'no'}`
      )
    }
  }

  // -- safety rail ------------------------------------------------------------
  const deleteShare = toDelete.length / Math.max(1, beforeCompanies)
  if (deleteShare > MAX_DELETE_SHARE && !force) {
    console.log(
      `\nREFUSING: deleting ${toDelete.length}/${beforeCompanies} companies (${(deleteShare * 100).toFixed(1)}%) is above the ` +
        `${(MAX_DELETE_SHARE * 100).toFixed(0)}% rail. Check the heuristics before proceeding (pass --force to override).`
    )
    process.exit(2)
  }

  if (!apply) {
    console.log(
      `\nDRY RUN — nothing was written. Re-run with --apply to delete ${toDelete.length} and repair ${toRepair.length} compan${
        toDelete.length + toRepair.length === 1 ? 'y' : 'ies'
      }.`
    )
    return
  }

  // -- apply --------------------------------------------------------------
  console.log('\n=== APPLYING ===')

  let repaired = 0
  for (let i = 0; i < toRepair.length; i += 1) {
    const d = toRepair[i]
    const out = psqlExec(
      dbUrl,
      `SET client_min_messages TO warning;\nUPDATE public.companies SET name = ${sqlString(d.newName!)} WHERE id = '${d.company.id}';\n`
    )
    if (/^UPDATE 1$/m.test(out)) repaired++
  }
  console.log(`  repaired ${repaired} of ${toRepair.length} companies`)

  let deletedCompanies = 0
  const deleteIds = toDelete.map((d) => d.company.id)
  for (let i = 0; i < deleteIds.length; i += WRITE_BATCH) {
    const chunk = deleteIds.slice(i, i + WRITE_BATCH)
    const out = psqlExec(dbUrl, `SET client_min_messages TO warning;\nDELETE FROM public.companies WHERE id IN (${idList(chunk)});\n`)
    for (const m of out.matchAll(/^DELETE (\d+)$/gm)) deletedCompanies += Number(m[1])
  }
  console.log(`  deleted ${deletedCompanies} of ${toDelete.length} companies`)

  const afterRaw = psqlQuery(dbUrl, `SELECT count(*) FROM public.companies`).trim()
  console.log(`\nAFTER  : ${afterRaw} companies (was ${beforeCompanies})`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
