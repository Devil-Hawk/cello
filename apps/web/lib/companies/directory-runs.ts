// The owner's two live runs of the directory (measures T24 and T25). Pure over the database and a function to call,
// so the scoring is proved without a network; scripts/directory-coverage.ts and scripts/directory-add-links.ts are
// the commands that run them against the real thing and write the number as a measure_runs row.
//
//   T24  directory search coverage: of the owner's 35 real past employers, how many companies.search returns by name
//        among its first 3 verified rows. Each miss says why: not in the seed, still pending, failed its check, cannot
//        be read, or found below the first 3. At least 34 of 35.
//   T25  add by link: on 20 real careers links, the right outcome: the right employer verified, added and followed, or
//        the right reason with its offer. 20 of 20 and no wrong employer added.

import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeCompanyName } from '../entities/companies'
import { addCompany, type AddFailure, type AddResult } from './add-link'
import { directoryProgress, searchCompanies } from './directory'

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
export async function recordMeasureRun(db: Db, id: 'T24' | 'T25', run: { value: number | null; passed: boolean | null; sample_n: number; note: string }): Promise<void> {
  const { error } = await db.from('measure_runs').insert({ measure_id: id, value: run.value, passed: run.passed, sample_n: run.sample_n, note: run.note })
  if (error) throw new Error('could not record the run')
}
