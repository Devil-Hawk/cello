// companies.add: bring one employer into a person's Companies, by a directory id, by a candidate's id or by a pasted link.
//
// Nothing here guesses. A directory id is already verified. A candidate is checked now, at once, never queued. A
// link goes through the reader's plain tiers (lib/ingest/reader) to the board or the site behind it, and the same
// verifier that checks the seed (verify-directory.ts) decides whose board it is. An employer is written only through
// writeEmployer (companies.verify) and followed only through followEmployer: this file writes neither table.
//
// A check that does not end in an employer ends in one of six reasons, each with what Cello found that the person
// can use instead (offers), or in one of the refusals before any check: a link that cannot be read, the day's limit,
// a demo account.

import type { SupabaseClient } from '@supabase/supabase-js'
import { detectFromUrl } from '../ats/detect'
import { isDemoProfile } from '../access/guardrails'
import { readJobPostings } from '../ingest/jsonld'
import { readSite, type SiteDeps, type SiteInput, type SiteRead } from '../ingest/reader'
import { repostHostOf } from '../ingest/reader/legit'
import { makeSiteFetcher } from '../ingest/reader/site-fetch'
import { NO_TARGETS } from '../ingest/reader/targets'
import { getEmployer, type DirectoryRow } from './directory'
import { followEmployer } from './follow'
import { isKnownEmployer, lookupKnownCompanyByDomain } from './known-companies'
import { nameFromDomain } from './page-name'
import {
  checkBoard,
  directoryOffers,
  realDeps,
  settleCandidate,
  writeEmployer,
  type BoardCheck,
  type CandidateRow,
  type FailReason,
  type Offer,
  type VerifyDeps,
} from './verify-directory'

type Db = SupabaseClient<any, any, any>

/** A person adds at most this many employers a day. */
export const DAILY_ADD_LIMIT = 30

export type AddBy = { employerId: string } | { candidateId: string } | { link: string }
export type AddFailure = FailReason | 'bad_link' | 'daily_limit' | 'demo' | 'not_found' | 'not_saved'

/** What the page says for each failure. Plain and specific: what Cello found, and what the person can do. */
export const ADD_LINES: Record<AddFailure, string> = {
  not_linked: 'Cello found a job board there, but nothing shows it belongs to this employer.',
  other_owner: 'That board belongs to a different employer.',
  stale: 'That board has no posting from the last 120 days.',
  no_board: 'Cello found no job board on that page.',
  cannot_read: 'Cello could not read that page right now. Try again later.',
  not_employer_site: 'That link is a job site, not the employer\'s own page.',
  bad_link: 'That is not an address Cello can read. Paste the employer\'s careers page.',
  daily_limit: `You have added ${DAILY_ADD_LIMIT} employers today. Try again tomorrow.`,
  demo: 'Demo accounts cannot add employers.',
  not_found: 'Cello does not have that employer.',
  not_saved: 'Cello could not save that employer. Try again.',
}

export interface AddedEmployer {
  /** The directory row; null when the person already follows an employer Cello has no row for. */
  employerId: string | null
  name: string
  domain: string | null
  logoUrl: string | null
  openCount: number | null
}

export type AddResult =
  | { ok: true; companyId: string; already: boolean; employer: AddedEmployer }
  | { ok: false; reason: AddFailure; line: string; offers: Offer[] }

const refuse = (reason: AddFailure, offers: Offer[] = []): AddResult => ({ ok: false, reason, line: ADD_LINES[reason], offers })

export interface AddDeps {
  verify: VerifyDeps
  /** The reader's plain tiers over a link, with the verifier as its board check. */
  read: (input: SiteInput, readBoard: NonNullable<SiteDeps['readBoard']>) => Promise<SiteRead>
  /** What a job site's posting page says about the employer it is for. */
  trace: (url: string) => Promise<{ employer: string | null; applyUrl: string | null }>
}

async function traceHiring(url: string): Promise<{ employer: string | null; applyUrl: string | null }> {
  try {
    const res = await makeSiteFetcher({ mode: 'inline' }).get(url)
    if (!res.ok) return { employer: null, applyUrl: null }
    const job = readJobPostings(res.text, res.finalUrl)[0]
    const apply = job?.applyUrl ?? null
    return { employer: job?.employer ?? null, applyUrl: apply && !repostHostOf(apply) ? apply : null }
  } catch {
    return { employer: null, applyUrl: null }
  }
}

export const realAddDeps: AddDeps = {
  verify: realDeps,
  read: (input, readBoard) => readSite(input, { fetcher: makeSiteFetcher({ mode: 'inline' }), readBoard, renderedLater: false }),
  trace: traceHiring,
}

// --- the link ----------------------------------------------------------------

/**
 * A pasted address as a URL, or null when Cello will not read it: not http or https, an address with a login in it,
 * a host with no dot, a private or local name, a number for a host, or a look-alike domain spelled in other scripts.
 * The fetcher checks every hop again; this is the first door.
 */
export function parseLink(raw: string): URL | null {
  const text = raw.trim()
  if (!text || text.length > 2000 || /\s/.test(text)) return null
  let withScheme = text
  if (!/^https?:\/\//i.test(text)) {
    // "retellai.com/careers" and "localhost:3000" have no scheme; "javascript:..." and "data:..." do.
    if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/:]+:\d+(\/|$)/.test(text)) return null
    withScheme = `https://${text}`
  }
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username || url.password) return null
  const host = url.hostname.toLowerCase()
  if (!host.includes('.') || host.startsWith('[') || /^[\d.]+$/.test(host)) return null
  if (/(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/.test(host)) return null
  if (host.split('.').some((label) => label.startsWith('xn--'))) return null
  return url
}

/** "careers.stripe.com" is Stripe's: the employer's domain is the host without the page's own prefix. */
export function employerDomain(host: string): string {
  return host.toLowerCase().replace(/^(www|careers|jobs|apply|boards|join|work)\./, '')
}

const titleCase = (token: string) => token.replace(/[-_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

// --- following -----------------------------------------------------------------

interface FollowedRow {
  id: string
  name: string
  domain: string | null
  logo_url: string | null
  employer_id: string | null
}

/** The person's own tracked row for this employer, by the employer's id or by domain. */
async function followedRow(db: Db, userId: string, by: { employerId?: string; domain?: string | null }): Promise<FollowedRow | null> {
  for (const [column, value] of [['employer_id', by.employerId], ['domain', by.domain]] as const) {
    if (!value) continue
    const { data } = await db.from('companies').select('id, name, domain, logo_url, employer_id').eq('user_id', userId).eq('watching', true).eq(column, value).limit(1).maybeSingle()
    if (data) return data as FollowedRow
  }
  return null
}

async function addsToday(db: Db, userId: string): Promise<number> {
  const since = new Date(Date.now() - 86_400_000).toISOString()
  const { count } = await db.from('companies').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('watching', true).gte('created_at', since)
  return count ?? 0
}

const briefOf = (e: DirectoryRow): AddedEmployer => ({ employerId: e.id, name: e.name, domain: e.domain, logoUrl: e.logo_url, openCount: e.open_count })

async function follow(db: Db, userId: string, employer: DirectoryRow, source: 'url' | 'known', dream: boolean): Promise<AddResult> {
  const f = await followEmployer(db, userId, employer, source, dream)
  if (f.error !== undefined) return refuse('not_saved')
  return { ok: true, companyId: f.id, already: false, employer: briefOf(employer) }
}

// --- the three ways in -----------------------------------------------------------

export async function addCompany(db: Db, userId: string, by: AddBy, deps: AddDeps = realAddDeps, opts: { dream?: boolean } = {}): Promise<AddResult> {
  const dream = opts.dream === true
  const { data: profile } = await db.from('profiles').select('is_demo, demo_expires_at').eq('id', userId).maybeSingle()
  if (isDemoProfile(profile as { is_demo: boolean | null; demo_expires_at: string | null } | null)) return refuse('demo')

  if ('employerId' in by) return addVerified(db, userId, await getEmployer(db, by.employerId), 'known', dream)
  if ('candidateId' in by) return addCandidate(db, userId, by.candidateId, deps, dream)
  return addLink(db, userId, by.link, deps, dream)
}

/** An employer the directory has verified: already followed shows it, otherwise it is followed. No check, no new evidence. */
async function addVerified(db: Db, userId: string, employer: DirectoryRow | null, source: 'url' | 'known', dream: boolean): Promise<AddResult> {
  if (!employer) return refuse('not_found')
  const have = await followedRow(db, userId, { employerId: employer.id, domain: employer.domain })
  if (have) return { ok: true, companyId: have.id, already: true, employer: briefOf(employer) }
  if ((await addsToday(db, userId)) >= DAILY_ADD_LIMIT) return refuse('daily_limit')
  return follow(db, userId, employer, source, dream)
}

async function addCandidate(db: Db, userId: string, candidateId: string, deps: AddDeps, dream: boolean): Promise<AddResult> {
  const { data } = await db.from('directory_candidates').select('id, name, domain, ats_provider, ats_token, source, failed_reads, state, employer_id').eq('id', candidateId).maybeSingle()
  const candidate = data as (CandidateRow & { state: string; employer_id: string | null }) | null
  if (!candidate) return refuse('not_found')
  // Verified already: the employer is in the directory.
  if (candidate.state === 'verified' && candidate.employer_id) return addVerified(db, userId, await getEmployer(db, candidate.employer_id), 'known', dream)
  const have = await followedRow(db, userId, { domain: candidate.domain })
  if (have) return { ok: true, companyId: have.id, already: true, employer: { employerId: have.employer_id, name: have.name, domain: have.domain, logoUrl: have.logo_url, openCount: null } }
  if ((await addsToday(db, userId)) >= DAILY_ADD_LIMIT) return refuse('daily_limit')

  // Chosen by a person, so checked now. A failed one is marked failed and never shows in search again.
  const settled = await settleCandidate(db, candidate, deps.verify)
  if (settled.state === 'verified') {
    const employer = await getEmployer(db, settled.employerId)
    return employer ? follow(db, userId, employer, 'known', dream) : refuse('not_saved')
  }
  if (settled.state === 'retry') return refuse('cannot_read')
  return refuse(settled.reason, settled.offers)
}

async function addLink(db: Db, userId: string, raw: string, deps: AddDeps, dream: boolean): Promise<AddResult> {
  const url = parseLink(raw)
  if (!url) return refuse('bad_link')

  // A job site is not the employer: say so, and offer the employer's own posting when its page names one.
  if (repostHostOf(url.href)) {
    const traced = await deps.trace(url.href)
    const offers = traced.employer ? await directoryOffers(db, { name: traced.employer }) : []
    if (traced.applyUrl) offers.push({ kind: 'posting', name: traced.employer ?? '', url: traced.applyUrl })
    return refuse('not_employer_site', offers)
  }

  // An applicant system's own address names a board, not an employer's website.
  const direct = detectFromUrl({ careerUrl: url.href, domain: null })
  const domain = direct ? null : employerDomain(url.hostname)
  if (domain) {
    const have = await followedRow(db, userId, { domain })
    if (have) return { ok: true, companyId: have.id, already: true, employer: { employerId: have.employer_id, name: have.name, domain: have.domain, logoUrl: have.logo_url, openCount: null } }
  }
  if ((await addsToday(db, userId)) >= DAILY_ADD_LIMIT) return refuse('daily_limit')

  const verified = await verifyLink(db, url, domain, direct?.token ?? null, deps)
  if (!verified.ok) return refuse(verified.reason, verified.offers)
  return addVerified(db, userId, await getEmployer(db, verified.employerId), 'url', dream)
}

type Verified = { ok: true; employerId: string } | { ok: false; reason: FailReason; offers: Offer[] }

/** Read a link with the reader's plain tiers and let the verifier decide whose board it is; write the employer on a pass. */
async function verifyLink(db: Db, url: URL, domain: string | null, directToken: string | null, deps: AddDeps): Promise<Verified> {
  const known = domain ? lookupKnownCompanyByDomain(domain) : null
  const guess = known?.name ?? (domain ? nameFromDomain(domain) : null)
  const failed: Extract<BoardCheck, { ok: false }>[] = []
  const passed = new Map<string, Extract<BoardCheck, { ok: true }>>()

  const readBoard: NonNullable<SiteDeps['readBoard']> = async (candidate) => {
    const pasted = candidate.via === 'url'
    let check = await checkBoard({ name: pasted ? null : guess, domain: pasted ? null : domain, careerUrl: url.href, provider: candidate.provider, token: candidate.token }, deps.verify)
    // The person pasted the board's own address: that is their say-so that this is the board. A provider that keeps no
    // record of its owner (Workday, Personio) is taken on it while the board is alive, except under the name of a big
    // employer: a slug that is only a name is how a namesake's board gets taken for Amazon's.
    if (!check.ok && pasted && check.reason === 'not_linked' && check.jobs && check.jobs.length > 0) {
      const name = check.identity?.name || titleCase(candidate.token)
      check = isKnownEmployer({ name }) && !check.identity?.name
        ? { ok: false, reason: 'other_owner', identity: check.identity, jobs: check.jobs }
        : { ok: true, verifiedBy: 'careers_url', jobs: check.jobs, domain: null, name }
    }
    if (!check.ok) {
      failed.push(check)
      return null
    }
    passed.set(`${candidate.provider}:${candidate.token}`, check)
    return { provider: candidate.provider, token: candidate.token, via: candidate.via, jobs: check.jobs, verifiedBy: check.verifiedBy }
  }

  const read = await deps.read({ company: { name: guess ?? '', domain, careerUrl: url.href }, targets: NO_TARGETS }, readBoard)

  if (read.board) {
    const ok = passed.get(`${read.board.provider}:${read.board.token}`)
    if (ok) {
      const employerId = await writeEmployer(db, {
        name: ok.name,
        // the host of the pasted link, never the board's own declared home (whoever owns a board can edit that)
        domain,
        careersUrl: directToken ? null : url.href,
        provider: read.board.provider,
        token: read.board.token,
        verifiedBy: ok.verifiedBy,
        source: 'person',
        openCount: ok.jobs.length,
        readTier: 'board',
      })
      return { ok: true, employerId }
    }
  }
  // No board, but the employer's own site lists roles Cello could read: tied to the employer by the address it was read at.
  if (domain && read.tier && read.tier !== 'board' && read.jobs.length > 0) {
    const employerId = await writeEmployer(db, {
      name: guess ?? domain,
      domain,
      careersUrl: url.href,
      provider: null,
      token: null,
      verifiedBy: 'careers_url_host',
      source: 'person',
      openCount: read.complete ? read.jobs.length : null,
      readTier: read.tier,
    })
    return { ok: true, employerId }
  }

  // Nothing verified: the board that failed says why; otherwise the reader's own reason.
  const first = failed[0]
  const reason: FailReason = first ? first.reason : read.message ? 'not_employer_site' : read.reason === 'no_roles' || read.reason === 'role_pages' || read.reason === null ? 'no_board' : 'cannot_read'
  const offers = reason === 'cannot_read' || reason === 'stale' ? [] : await directoryOffers(db, { name: first?.identity?.name ?? guess, domain, token: directToken })
  return { ok: false, reason, offers }
}
