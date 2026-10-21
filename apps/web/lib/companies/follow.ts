// Follow an employer for a person: the one place that writes companies.watching (the person's bookmark).
//
// A person's `companies` row is their own (notes, dream flag, who they know there); the employer it points at is
// shared (company_directory). Following gives the person a row tied to the employer and to its verified board, then
// reads that board once inside a budget (readEmployer). Unfollow clears the bookmark and keeps the row. A report
// unfollows and asks for the board to be proven again. Nothing here writes a row the person did not ask for.

import { waitUntil } from '@vercel/functions'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isDemoProfile } from '../access/guardrails'
import { saveCompany } from './add'
import { addsToday, ADD_LINES, DAILY_ADD_LIMIT, followedRow } from './add-link'
import { getEmployer, type DirectoryRow } from './directory'
import { readEmployer, REVERIFY_DAYS, type EmployerRead, type Person } from './read-employer'

type Db = SupabaseClient<any, any, any>

export type Followed = { id: string; error?: undefined } | { id?: undefined; error: string }

const DAY_MS = 86_400_000
const HANDOFF_LINE = 'Following. Cello reads its board within the hour.'

export async function followEmployer(db: Db, userId: string, employer: Pick<DirectoryRow, 'id' | 'name' | 'domain' | 'logo_url' | 'careers_url' | 'ats_provider' | 'ats_token' | 'verified_by'>, source: 'url' | 'known', opts: { dream?: boolean } = {}): Promise<Followed> {
  const saved = await saveCompany(db, userId, { name: employer.name, domain: employer.domain, careerUrl: employer.careers_url, logoUrl: employer.logo_url, isDream: opts.dream })
  if (saved.error !== undefined) return { error: saved.error }

  // The board the verifier tied to the employer is the pointer a refresh reads first; no guessing by name.
  const { data } = await db.from('companies').select('metadata').eq('id', saved.id).eq('user_id', userId).maybeSingle()
  const metadata: Record<string, unknown> = { ...((data as { metadata?: Record<string, unknown> } | null)?.metadata ?? {}) }
  if (employer.ats_provider && employer.ats_token) {
    metadata.ats = { provider: employer.ats_provider, token: employer.ats_token, source, discovered_at: new Date().toISOString(), verified_by: employer.verified_by ?? undefined, verified_at: new Date().toISOString() }
  }
  const { error } = await db.from('companies').update({ employer_id: employer.id, watching: true, metadata }).eq('id', saved.id).eq('user_id', userId)
  if (error) return { error: `Could not follow ${employer.name}: ${error.message}` }
  return { id: saved.id }
}

export type FollowResult =
  | { ok: true; following: true; already: boolean; read: { listed: number; kept: number } | null; line: string; fit: string | null }
  | { ok: false; reason: 'demo' | 'daily_limit' | 'not_found' | 'not_saved'; line: string }

export interface FollowOpts {
  dream?: boolean
  /** How long the person waits for the first read; the read itself is never cut short. */
  budgetMs?: number
  /** The read; the directory's readEmployer by default. */
  read?: (employer: DirectoryRow, people: Person[]) => Promise<EmployerRead>
}

/**
 * Follow a verified employer and read its board once, inside the budget. `people` is the person asking, or [] when they
 * have stated no targets: then the line counts open roles and says nothing about fit.
 */
export async function followAndRead(db: Db, userId: string, employerId: string, people: Person[], opts: FollowOpts = {}): Promise<FollowResult> {
  const refuse = (reason: 'demo' | 'daily_limit' | 'not_found' | 'not_saved'): FollowResult => ({ ok: false, reason, line: ADD_LINES[reason] })
  const read = opts.read ?? ((employer: DirectoryRow, who: Person[]) => readEmployer(db, employer, who))

  const employer = await getEmployer(db, employerId)
  if (!employer) return refuse('not_found')
  const { data: profile } = await db.from('profiles').select('is_demo, demo_expires_at').eq('id', userId).maybeSingle()
  if (isDemoProfile(profile as { is_demo: boolean | null; demo_expires_at: string | null } | null)) return refuse('demo')
  if (await followedRow(db, userId, { employerId })) return { ok: true, following: true, already: true, read: null, line: `Already following ${employer.name}.`, fit: null }
  if ((await addsToday(db, userId)) >= DAILY_ADD_LIMIT) return refuse('daily_limit')

  const followed = await followEmployer(db, userId, employer, 'known', { dream: opts.dream })
  if (followed.error !== undefined) return refuse('not_saved')
  if (!employer.ats_provider || !employer.ats_token) return { ok: true, following: true, already: false, read: null, line: 'Following. Cello checks it with the others, every 6 hours.', fit: null }

  // The read runs while the budget runs. Past the budget the person gets the hand-off line and the read goes on.
  const work = read(employer, people).catch(() => null)
  let timer: ReturnType<typeof setTimeout> | undefined
  const first = await Promise.race([work, new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), opts.budgetMs ?? 8000)))])
  clearTimeout(timer)
  if (first === 'timeout') {
    if (process.env.VERCEL) waitUntil(work)
    return { ok: true, following: true, already: false, read: null, line: HANDOFF_LINE, fit: null }
  }
  if (first === null) return { ok: true, following: true, already: false, read: null, line: ADD_LINES.cannot_read, fit: null }
  if (first.failure) return { ok: true, following: true, already: false, read: null, line: ADD_LINES[first.failure], fit: null }

  // Part 1.5: the tile's line is the open count; the fit line only when the person has targets and something is kept.
  const fit = people.length > 0 && first.kept > 0 ? `${first.kept} fit your targets` : null
  return { ok: true, following: true, already: false, read: { listed: first.listed, kept: first.kept }, line: `${first.listed} open · checked just now`, fit }
}

/** The bookmark off: the row stays, the employer stays in the directory and keeps being read. */
export async function unfollowEmployer(db: Db, userId: string, employerId: string): Promise<{ ok: true; was: 'following' | 'not_following' }> {
  const { data, error } = await db.from('companies').update({ watching: false }).eq('user_id', userId).eq('employer_id', employerId).eq('watching', true).select('id')
  if (error) throw new Error(`could not unfollow: ${error.message}`)
  return { ok: true, was: (data ?? []).length > 0 ? 'following' : 'not_following' }
}

/**
 * "Not this company": unfollow, keep the person's report, and ask for the board to be proven again.
 * readEmployer re-checks a board whose verified_at is older than REVERIFY_DAYS, and directory_boards_due picks it up at
 * once because next_read_at is now. verified_at is set back rather than null: null would drop the row from the sweep,
 * from search and from getEmployer, which is the opposite of re-proving it.
 * ponytail: no per-person limit on reports; each one costs one board check. Add a cap when reports are abused.
 */
export type ReportResult = { ok: true; was: 'following' | 'not_following' } | { ok: false; reason: 'not_found' | 'demo' }

/** Only a followed employer can be reported: a report on one the person does not follow writes nothing. */
export async function reportEmployer(db: Db, userId: string, employerId: string): Promise<ReportResult> {
  if (!(await getEmployer(db, employerId))) return { ok: false, reason: 'not_found' }
  const { data: profile } = await db.from('profiles').select('is_demo, demo_expires_at').eq('id', userId).maybeSingle()
  if (isDemoProfile(profile as { is_demo: boolean | null; demo_expires_at: string | null } | null)) return { ok: false, reason: 'demo' }
  const unfollowed = await unfollowEmployer(db, userId, employerId)
  if (unfollowed.was === 'not_following') return { ok: true, was: 'not_following' }
  const { error: reportError } = await db.from('employer_reports').insert({ user_id: userId, employer_id: employerId })
  if (reportError) throw new Error(`could not keep the report: ${reportError.message}`)
  const now = Date.now()
  const { error } = await db
    .from('company_directory')
    .update({ verified_at: new Date(now - (REVERIFY_DAYS + 1) * DAY_MS).toISOString(), next_read_at: new Date(now).toISOString(), cannot_read_reason: null })
    .eq('id', employerId)
  if (error) throw new Error(`could not queue the re-check: ${error.message}`)
  return { ok: true, was: unfollowed.was }
}
