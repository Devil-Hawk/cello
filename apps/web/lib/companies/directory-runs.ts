// The owner's two live runs of the directory (measures T24 and T25). Pure over the database and a function to call,
// so the scoring is proved without a network; scripts/directory-coverage.ts and scripts/directory-add-links.ts are
// the commands that run them against the real thing and write the number as a measure_runs row.
//
//   T24  directory search coverage: of the owner's 35 real past employers, how many companies.search returns by name
//        among its first 3 verified rows. Each miss says why: not in the seed, still pending, failed its check, cannot
//        be read, or found below the first 3. At least 34 of 35.
//   T34  find by name: the owner's real past employers and some startups, each through the search ladder (find.ts) with the
//        real network. A name counts when a candidate for that employer is offered; the row says which rung found it, how
//        long it took, and for a miss which rung it reached and why nothing was shown. Recorded with --find --record.
//   T25  add by link: on 20 real careers links, the right outcome: the right employer verified, added and followed, or
//        the right reason with its offer. 20 of 20 and no wrong employer added.

import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeCompanyName } from '../entities/companies'
import { addCompany, type AddFailure, type AddResult } from './add-link'
import { directoryProgress, searchCompanies } from './directory'
import type { FindResult, Rung } from './find'

type Db = SupabaseClient<any, any, any>

export type MissReason = 'not_in_seed' | 'pending' | 'failed' | 'cannot_read' | 'below_first_3'

export interface CoverageRow {
  name: string
  hit: boolean
  /** The employer found, when there is one. */
  found?: string
  reason?: MissReason
  /** The check's own reason for a failed candidate. */
  detail?: string
}

export interface Coverage {
  rows: CoverageRow[]
  hits: number
  total: number
  progress: { verified: number; pending: number; failed: number }
}

/** Why a name search did not find an employer: what the directory holds under that name. */
async function whyMissed(db: Db, norm: string): Promise<Pick<CoverageRow, 'reason' | 'detail'>> {
  const { data: candidates } = await db.from('directory_candidates').select('state, fail_reason').eq('name_norm', norm).limit(5)
  const rows = (candidates ?? []) as { state: string; fail_reason: string | null }[]
  const failed = rows.find((c) => c.state === 'failed')
  if (rows.some((c) => c.state === 'pending')) return { reason: 'pending' }
  if (failed) return { reason: 'failed', detail: failed.fail_reason ?? undefined }
  const { data: out } = await db.from('company_directory').select('cannot_read_reason').eq('name_norm', norm).not('cannot_read_reason', 'is', null).limit(1)
  if (((out ?? []) as unknown[]).length > 0) return { reason: 'cannot_read', detail: (out as { cannot_read_reason: string }[])[0].cannot_read_reason }
  if (rows.some((c) => c.state === 'verified')) return { reason: 'below_first_3' }
  return { reason: 'not_in_seed' }
}

export async function runCoverage(db: Db, names: string[], search: typeof searchCompanies = searchCompanies): Promise<Coverage> {
  const rows: CoverageRow[] = []
  for (const name of names.map((n) => n.trim()).filter(Boolean)) {
    const norm = normalizeCompanyName(name)
    const { employers } = await search(db, name, { limit: 3 })
    const found = employers.slice(0, 3).find((e) => normalizeCompanyName(e.name) === norm)
    rows.push(found ? { name, hit: true, found: found.name } : { name, hit: false, ...(await whyMissed(db, norm)) })
  }
  return { rows, hits: rows.filter((r) => r.hit).length, total: rows.length, progress: await directoryProgress(db) }
}

/** The bar is 34 of 35; with fewer names than that the run is reported, not judged. */
export function coverageRun(c: Coverage): { value: number | null; passed: boolean | null; sample_n: number; note: string } {
  const misses = c.rows.filter((r) => !r.hit).map((r) => `${r.name}: ${r.reason}${r.detail ? ` (${r.detail})` : ''}`)
  const note = [
    `${c.hits} of ${c.total} names found among the first 3 verified rows.`,
    misses.length > 0 ? `Misses: ${misses.join('; ')}.` : '',
    `The seed: ${c.progress.verified} verified, ${c.progress.pending} pending, ${c.progress.failed} failed.`,
  ]
    .filter(Boolean)
    .join(' ')
  return { value: c.total > 0 ? c.hits / c.total : null, passed: c.total >= 35 ? c.hits >= 34 : null, sample_n: c.total, note }
}

// --- T25 -----------------------------------------------------------------------------

export interface LinkCase {
  link: string
  /** The right outcome: the employer that should be added, or the reason it should fail with. */
  expect: { employer: string } | { reason: AddFailure }
}

export interface LinkRow {
  link: string
  ok: boolean
  /** What happened, in a few words. */
  got: string
  /** An employer was added that is not the one expected. */
  wrongEmployer: boolean
  offers: number
}

export async function runAddLinks(
  db: Db,
  userId: string,
  cases: LinkCase[],
  add: (db: Db, userId: string, by: { link: string }) => Promise<AddResult> = (d, u, by) => addCompany(d, u, by)
): Promise<{ rows: LinkRow[]; correct: number; wrongEmployers: number }> {
  const rows: LinkRow[] = []
  for (const c of cases) {
    const r = await add(db, userId, { link: c.link })
    if (r.ok) {
      const wanted = 'employer' in c.expect ? normalizeCompanyName(c.expect.employer) : null
      const right = wanted !== null && normalizeCompanyName(r.employer.name) === wanted
      rows.push({ link: c.link, ok: right, got: `added ${r.employer.name}${r.already ? ' (already followed)' : ''}`, wrongEmployer: !right, offers: 0 })
    } else {
      const right = 'reason' in c.expect && c.expect.reason === r.reason
      rows.push({ link: c.link, ok: right, got: `refused: ${r.reason}`, wrongEmployer: false, offers: r.offers.length })
    }
  }
  return { rows, correct: rows.filter((r) => r.ok).length, wrongEmployers: rows.filter((r) => r.wrongEmployer).length }
}

export function addLinksRun(r: { rows: LinkRow[]; correct: number; wrongEmployers: number }): { value: number | null; passed: boolean | null; sample_n: number; note: string } {
  const wrong = r.rows.filter((x) => !x.ok).map((x) => `${x.link} -> ${x.got}`)
  const note = [`${r.correct} of ${r.rows.length} links had the right outcome; ${r.wrongEmployers} wrong employers added.`, wrong.length > 0 ? `Not as expected: ${wrong.join('; ')}.` : ''].filter(Boolean).join(' ')
  return { value: r.rows.length > 0 ? r.correct / r.rows.length : null, passed: r.rows.length >= 20 ? r.correct === r.rows.length && r.wrongEmployers === 0 : null, sample_n: r.rows.length, note }
}

/** One measure_runs row, written with the service role. */
export async function recordMeasureRun(db: Db, id: 'T24' | 'T25' | 'T34', run: { value: number | null; passed: boolean | null; sample_n: number; note: string }): Promise<void> {
  const { error } = await db.from('measure_runs').insert({ measure_id: id, value: run.value, passed: run.passed, sample_n: run.sample_n, note: run.note })
  if (error) throw new Error('could not record the run')
}

// --- T34 -----------------------------------------------------------------------------

export interface FindRow {
  name: string
  hit: boolean
  /** How the employer was found (directory, board, wikidata, site, web), or the last rung reached on a miss. */
  rung: string
  found?: string
  reason?: string
  ms: number
}

const squash = (s: string) => normalizeCompanyName(s).replace(/ /g, '')

export async function runFinds(
  names: string[],
  find: (name: string, report: (e: { rung: Rung; line: string }) => void) => Promise<FindResult>,
  clock: () => number = Date.now
): Promise<{ rows: FindRow[]; hits: number; total: number }> {
  const rows: FindRow[] = []
  for (const name of names.map((n) => n.trim()).filter(Boolean)) {
    const reached: Rung[] = []
    const started = clock()
    const result = await find(name, (e) => reached.push(e.rung))
    const ms = clock() - started
    const want = squash(name)
    const last = reached[reached.length - 1] ?? 'directory'
    if ('candidates' in result) {
      // The name, or the domain it is registered under: "Fireworks AI" is fireworks.ai, whatever the board calls itself.
      const c = result.candidates.find((x) => squash(x.name) === want || (x.domain != null && [x.domain.split('.')[0], x.domain.replace(/\./g, '')].some((d) => squash(d) === want)))
      rows.push(
        c
          ? { name, hit: true, rung: c.foundBy, found: `${c.name}${c.domain ? ` (${c.domain})` : ''}; ${c.provenBy}`, ms }
          : { name, hit: false, rung: last, reason: `offered other employers (${result.candidates.map((x) => `${x.name}${x.domain ? ` at ${x.domain}` : ''}`).join(', ')}), not ${name}`, ms }
      )
    } else {
      rows.push({ name, hit: false, rung: last, reason: result.queued ? 'nothing proven; no search key, so the web search was left for the worker' : 'nothing proven', ms })
    }
  }
  return { rows, hits: rows.filter((r) => r.hit).length, total: rows.length }
}

/**
 * T34's verdict over a run's rows: the first `owned` rows are the owner's names, and every one must be found; the startups
 * after them need 4 of every 5 (8 of 10). The note gives both counts and each miss with the rung it reached and its reason.
 */
export function findRun(rows: FindRow[], owned: number): { value: number | null; passed: boolean | null; sample_n: number; note: string } {
  const own = rows.slice(0, owned)
  const startups = rows.slice(owned)
  const ownFound = own.filter((r) => r.hit).length
  const startupHits = startups.filter((r) => r.hit).length
  const startupBar = Math.ceil(startups.length * 0.8)
  const misses = rows.filter((r) => !r.hit).map((r) => `${r.name} at ${r.rung}: ${r.reason}`)
  const note = [`Owner's names found: ${ownFound} of ${own.length}. Startups found: ${startupHits} of ${startups.length} (need ${startupBar}).`, misses.length > 0 ? `Misses: ${misses.join('; ')}.` : '']
    .filter(Boolean)
    .join(' ')
  return {
    value: rows.length > 0 ? rows.filter((r) => r.hit).length / rows.length : null,
    passed: rows.length > 0 ? ownFound === own.length && startupHits >= startupBar : null,
    sample_n: rows.length,
    note,
  }
}

/** The T34 row is written only from the full set: the pinned fixture, or a names file of at least 21 names. */
export const T34_FULL_SET = 21
export function t34Recordable(names: string[], fromFixture: boolean): boolean {
  return fromFixture || names.filter((n) => n.trim() !== '').length >= T34_FULL_SET
}
