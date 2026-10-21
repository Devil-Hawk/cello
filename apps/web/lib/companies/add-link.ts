// companies.add: bring one employer into a person's Companies, by a directory id, by a candidate's id or by a pasted link.
//
// Nothing here guesses. A directory id is already verified. A candidate is checked now, at once, never queued. A
// link goes through the reader's plain tiers (lib/ingest/reader) to the board or the site behind it, and the same
// verifier that checks the seed (verify-directory.ts) decides whose board it is. An employer is written only through
// writeEmployer (companies.verify) and followed only through followEmployer: this file writes neither table.
//
// A check that does not end in an employer ends in one of six reasons, each with what Cello found that the person
// can use instead (offers), or in one of the refusals before any check: a link that cannot be read, the day's limit,
// a demo account. A careers page only a browser can read is queued for the pull worker instead (render-jobs.ts).
//
// Each real stage is told to deps.report as it happens, so a route can stream it (the wording is Part 1, section 1.4).

import type { SupabaseClient } from '@supabase/supabase-js'
import { detectFromUrl } from '../ats/detect'
import type { AtsProviderId } from '../ats/types'
import { isDemoProfile } from '../access/guardrails'
import { readJobPostings } from '../ingest/jsonld'
import { readSite, type BoardRead, type SiteDeps, type SiteInput, type SiteRead } from '../ingest/reader'
import { repostHostOf } from '../ingest/reader/legit'
import { makeSiteFetcher } from '../ingest/reader/site-fetch'
import { NO_TARGETS } from '../ingest/reader/targets'
import { getEmployer, type DirectoryRow } from './directory'
import { normalizeCompanyName } from '../entities/companies'
import { followEmployer } from './follow'
import { isKnownEmployer, knownBoard, lookupKnownCompanyByDomain, lookupKnownCompanyByName } from './known-companies'
import { nameFromDomain } from './page-name'
import { queueRenderJob } from './render-jobs'
import { PROVIDER_LABELS } from './suggestions'
import {
  checkBoard,
  directoryOffers,
  realDeps,
  settleCandidate,
  writeEmployer,
  writeProfile,
  type BoardCheck,
  type CandidateRow,
  type CheckStep,
  type FailReason,
  type Offer,
  type VerifyDeps,
} from './verify-directory'
import { registrable, toProfile, wikidataByQid, type WikidataEntity } from './wikidata'

type Db = SupabaseClient<any, any, any>

/** A person adds at most this many employers a day. */
export const DAILY_ADD_LIMIT = 30

/** A board or a site that a search (find.ts) proved; the add proves it again, so nothing a client sends is taken on trust. */
export type AddBy =
  | { employerId: string }
  | { candidateId: string }
  | { link: string }
  | { board: { provider: AtsProviderId; token: string; name: string; domain: string | null; qid?: string } }
  | { site: { domain: string; careersUrl: string; name?: string; qid?: string } }
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
  /** `queued` is the line to show when the page was handed to the browser worker instead of being refused for good. */
  | { ok: false; reason: AddFailure; line: string; offers: Offer[]; queued?: string }

/** What the add tells the person as it goes: the stages of a board check, then the ones only the add knows. */
export type AddStep =
  | CheckStep
  | { step: 'directory_hit'; following: boolean; line: string }
  | { step: 'reading'; host: string; line: string }
  | { step: 'board_found'; provider: AtsProviderId | null; line: string }

const refuse = (reason: AddFailure, offers: Offer[] = []): Extract<AddResult, { ok: false }> => ({ ok: false, reason, line: ADD_LINES[reason], offers })

export interface AddDeps {
  verify: VerifyDeps
  /** The reader's plain tiers over a link, with the verifier as its board check. */
  read: (input: SiteInput, readBoard: NonNullable<SiteDeps['readBoard']>) => Promise<SiteRead>
  /** What a job site's posting page says about the employer it is for. */
  trace: (url: string) => Promise<{ employer: string | null; applyUrl: string | null }>
  /** Told at each real stage; the route streams these. */
  report?: (step: AddStep) => void
  /** A Wikidata item read again by its Q-id, for the profile an add stores. */
  wikidata?: (qid: string) => Promise<WikidataEntity | null>
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
  wikidata: (qid) => wikidataByQid(qid),
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

/** "Found a Greenhouse board", "Found an Ashby board". */
const foundLine = (provider: AtsProviderId) => `Found ${/^[aeiou]/i.test(PROVIDER_LABELS[provider]) ? 'an' : 'a'} ${PROVIDER_LABELS[provider]} board`

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
export async function followedRow(db: Db, userId: string, by: { employerId?: string; domain?: string | null }): Promise<FollowedRow | null> {
  for (const [column, value] of [['employer_id', by.employerId], ['domain', by.domain]] as const) {
    if (!value) continue
    const { data } = await db.from('companies').select('id, name, domain, logo_url, employer_id').eq('user_id', userId).eq('watching', true).eq(column, value).limit(1).maybeSingle()
    if (data) return data as FollowedRow
  }
  return null
}

/**
 * Rows the person created in the last 24 hours, followed or not: an unfollow does not reset the day's limit. A lead
 * the sourcer wrote (metadata.suggested) is not an add by the person, so it does not count.
 */
export async function addsToday(db: Db, userId: string): Promise<number> {
  const since = new Date(Date.now() - 86_400_000).toISOString()
  const { count } = await db
    .from('companies')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', since)
    .or('metadata->>suggested.is.null,metadata->>suggested.neq.true')
  return count ?? 0
}

const briefOf = (e: DirectoryRow): AddedEmployer => ({ employerId: e.id, name: e.name, domain: e.domain, logoUrl: e.logo_url, openCount: e.open_count })

async function follow(db: Db, userId: string, employer: DirectoryRow, source: 'url' | 'known', dream: boolean): Promise<AddResult> {
  const f = await followEmployer(db, userId, employer, source, { dream: dream || undefined })
  if (f.error !== undefined) return refuse('not_saved')
  return { ok: true, companyId: f.id, already: false, employer: briefOf(employer) }
}

// --- the ways in ------------------------------------------------------------------

export async function addCompany(db: Db, userId: string, by: AddBy, deps: AddDeps = realAddDeps, opts: { dream?: boolean } = {}): Promise<AddResult> {
  const dream = opts.dream === true
  const { data: profile } = await db.from('profiles').select('is_demo, demo_expires_at').eq('id', userId).maybeSingle()
  if (isDemoProfile(profile as { is_demo: boolean | null; demo_expires_at: string | null } | null)) return refuse('demo')
  // The verifier tells the same listener as the add does.
  const d: AddDeps = deps.report ? { ...deps, verify: { ...deps.verify, report: deps.report } } : deps

  let result: AddResult
  if ('employerId' in by) result = await addVerified(db, userId, await getEmployer(db, by.employerId), 'known', dream, d)
  else if ('candidateId' in by) result = await addCandidate(db, userId, by.candidateId, d, dream)
  else if ('board' in by) result = await addBoard(db, userId, by.board, d, dream)
  else if ('site' in by) result = await addLink(db, userId, by.site.careersUrl, d, dream, by.site)
  else result = await addLink(db, userId, by.link, d, dream)

  const qid = 'board' in by ? by.board.qid : 'site' in by ? by.site.qid : undefined
  if (result.ok && qid && result.employer.employerId) await attachProfile(db, result.employer, qid, d)
  return result
}

/** The Wikidata facts of the item the person chose, read again from Wikidata, kept only when its website is the employer's own domain. */
async function attachProfile(db: Db, employer: AddedEmployer, qid: string, deps: AddDeps): Promise<void> {
  try {
    const item = await (deps.wikidata ?? wikidataByQid)(qid)
    if (item && employer.domain && registrable(item.website) === registrable(employer.domain)) await writeProfile(db, employer.employerId as string, toProfile(item))
  } catch {
    /* a profile is a nicety: the add stands without it */
  }
}

/** An employer the directory has verified: already followed shows it, otherwise it is followed. No check, no new evidence. */
async function addVerified(db: Db, userId: string, employer: DirectoryRow | null, source: 'url' | 'known', dream: boolean, deps?: AddDeps): Promise<AddResult> {
  if (!employer) return refuse('not_found')
  const have = await followedRow(db, userId, { employerId: employer.id, domain: employer.domain })
  if (deps && deps.report) deps.report({ step: 'directory_hit', following: !!have, line: have ? 'You follow this already' : 'In the directory, not on your page yet' })
  if (have) return { ok: true, companyId: have.id, already: true, employer: briefOf(employer) }
  if ((await addsToday(db, userId)) >= DAILY_ADD_LIMIT) return refuse('daily_limit')
  return follow(db, userId, employer, source, dream)
}

/** The directory's verified employer for a board or a domain, or null: the check a short-circuit needs before any read. */
async function directoryRow(db: Db, by: { provider?: string; token?: string; domain?: string | null }): Promise<DirectoryRow | null> {
  const lookups: [string, string][] = []
  if (by.provider && by.token) lookups.push(['ats_provider', by.provider], ['ats_token', by.token])
  const query = (cols: [string, string][]) => cols.reduce((q, [c, v]) => q.eq(c, v), db.from('company_directory').select('*').not('verified_at', 'is', null))
  if (lookups.length) {
    const { data } = await query(lookups).maybeSingle()
    if (data) return data as DirectoryRow
  }
  if (by.domain) {
    const { data } = await query([['domain', by.domain]]).maybeSingle()
    if (data) return data as DirectoryRow
  }
  return null
}

async function addCandidate(db: Db, userId: string, candidateId: string, deps: AddDeps, dream: boolean): Promise<AddResult> {
  const { data } = await db.from('directory_candidates').select('id, name, domain, ats_provider, ats_token, source, failed_reads, state, employer_id, next_check_at').eq('id', candidateId).maybeSingle()
  const candidate = data as (CandidateRow & { state: string; employer_id: string | null; next_check_at: string | null }) | null
  if (!candidate) return refuse('not_found')
  // Verified already: the employer is in the directory.
  if (candidate.state === 'verified' && candidate.employer_id) return addVerified(db, userId, await getEmployer(db, candidate.employer_id), 'known', dream, deps)
  // A check someone else made lately stands: a click is not a new look, so a script cannot hammer a candidate's provider.
  if (candidate.next_check_at && Date.parse(candidate.next_check_at) > Date.now()) return refuse('cannot_read')
  const have = await followedRow(db, userId, { domain: candidate.domain })
  if (have) return { ok: true, companyId: have.id, already: true, employer: { employerId: have.employer_id, name: have.name, domain: have.domain, logoUrl: have.logo_url, openCount: null } }
  if ((await addsToday(db, userId)) >= DAILY_ADD_LIMIT) return refuse('daily_limit')

  // Chosen by a person, so checked now. A failed one is marked failed and never shows in search again.
  // A person's check never counts an unread board against the candidate: only the sweep does.
  const settled = await settleCandidate(db, candidate, deps.verify, { person: true })
  if (settled.state === 'verified') {
    const employer = await getEmployer(db, settled.employerId)
    return employer ? follow(db, userId, employer, 'known', dream) : refuse('not_saved')
  }
  if (settled.state === 'retry') return refuse('cannot_read')
  return refuse(settled.reason, settled.offers)
}

/** A board a search proved, proved again here: the directory's row if there is one, else the verifier decides and the employer is written. */
async function addBoard(db: Db, userId: string, b: Extract<AddBy, { board: unknown }>['board'], deps: AddDeps, dream: boolean): Promise<AddResult> {
  const row = await directoryRow(db, { provider: b.provider, token: b.token })
  if (row) return addVerified(db, userId, row, 'url', dream, deps)
  if ((await addsToday(db, userId)) >= DAILY_ADD_LIMIT) return refuse('daily_limit')
  deps.report?.({ step: 'board_found', provider: b.provider, line: foundLine(b.provider) })
  const check = await checkBoard({ name: b.name, domain: b.domain, provider: b.provider, token: b.token }, deps.verify)
  if (!check.ok) return refuse(check.reason, check.reason === 'other_owner' ? await directoryOffers(db, { name: b.name, domain: b.domain }) : [])
  const written = await writeEmployer(db, { name: check.name, domain: b.domain, careersUrl: null, provider: b.provider, token: b.token, verifiedBy: check.verifiedBy, source: 'person', openCount: check.jobs.length, readTier: 'board', keepExisting: true })
  if (!written.ok) return refuse(written.reason, written.offers)
  return addVerified(db, userId, await getEmployer(db, written.employerId), 'url', dream)
}

async function addLink(db: Db, userId: string, raw: string, deps: AddDeps, dream: boolean, site?: { domain: string; name?: string }): Promise<AddResult> {
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
  // A site a search proved is read at its own address: the domain it named must be the one that address is on.
  if (site && domain !== site.domain) return refuse('bad_link')
  if (domain) {
    const have = await followedRow(db, userId, { domain })
    if (have) {
      deps.report?.({ step: 'directory_hit', following: true, line: 'You follow this already' })
      return { ok: true, companyId: have.id, already: true, employer: { employerId: have.employer_id, name: have.name, domain: have.domain, logoUrl: have.logo_url, openCount: null } }
    }
  }
  // Already in the directory by its board or its domain: say so at once, read nothing.
  const known = await directoryRow(db, { provider: direct?.provider, token: direct?.token, domain })
  if (known) return addVerified(db, userId, known, 'url', dream, deps)
  if ((await addsToday(db, userId)) >= DAILY_ADD_LIMIT) return refuse('daily_limit')

  const verified = await verifyLink(db, url, domain, direct?.token ?? null, deps, site?.name)
  if (!verified.ok) {
    const failure = refuse(verified.reason, verified.offers)
    const queued = verified.browser && domain ? await queueForBrowser(db, userId, { name: verified.name ?? domain, domain, url: url.href, why: verified.browser }) : null
    return queued ? { ...failure, queued } : failure
  }
  return addVerified(db, userId, await getEmployer(db, verified.employerId), 'url', dream)
}

/** A pasted board whose provider names a curated employer (and declares no other home) is that employer's: its curated domain. */
function curatedHome(ok: { name: string; domain: string | null }): string | null {
  const k = lookupKnownCompanyByName(ok.name)
  return k && (!ok.domain || registrable(ok.domain) === registrable(k.domain)) ? k.domain : null
}

/** Why the browser worker may do better than a plain read, in a few words. */
const BROWSER_FIXES: Record<string, string> = { bot_check: 'the site asked for a bot check', role_pages: 'its roles show only in a browser' }

/**
 * A careers page only a browser can read: remember the employer as a candidate the person asked for, queue the page for
 * the pull worker, and give the line that says so. Null when nothing was queued.
 */
async function queueForBrowser(db: Db, userId: string, p: { name: string; domain: string; url: string; why: string }): Promise<string | null> {
  let { data } = await db.from('directory_candidates').select('id').eq('domain', p.domain).maybeSingle()
  if (!data) ({ data } = await db.from('directory_candidates').insert({ name: p.name.slice(0, 200), name_norm: normalizeCompanyName(p.name), domain: p.domain, source: 'person' }).select('id').single())
  const candidateId = (data as { id: string } | null)?.id
  if (!candidateId || !(await queueRenderJob(db, { kind: 'careers_page', candidateId, url: p.url, requestedBy: userId }))) return null
  return `Cello could not read that page: ${BROWSER_FIXES[p.why]}. Trying with a browser within the hour.`
}

type Verified = { ok: true; employerId: string } | { ok: false; reason: FailReason; offers: Offer[]; name?: string; /** The reader's reason, when a browser may read what a plain request could not. */ browser?: string }

/** Read a link with the reader's plain tiers and let the verifier decide whose board it is; write the employer on a pass. */
async function verifyLink(db: Db, url: URL, domain: string | null, directToken: string | null, deps: AddDeps, givenName?: string): Promise<Verified> {
  const known = domain ? lookupKnownCompanyByDomain(domain) : null
  const guess = givenName ?? known?.name ?? (domain ? nameFromDomain(domain) : null)
  const failed: Extract<BoardCheck, { ok: false }>[] = []
  const passed = new Map<string, Extract<BoardCheck, { ok: true }>>()
  deps.report?.({ step: 'reading', host: url.hostname.replace(/^www\./, ''), line: `Reading ${url.hostname.replace(/^www\./, '')}` })

  const readBoard: NonNullable<SiteDeps['readBoard']> = async (candidate) => {
    deps.report?.({ step: 'board_found', provider: candidate.provider, line: foundLine(candidate.provider) })
    const pasted = candidate.via === 'url'
    let check = await checkBoard({ name: pasted ? null : guess, domain: pasted ? null : domain, careerUrl: url.href, provider: candidate.provider, token: candidate.token }, deps.verify)
    // The person pasted the board's own address: that is their say-so that this is the board. A provider that keeps no
    // record of its owner (Workday, Personio) is taken on it while the board is alive, except under the name of a big
    // employer: a slug that is only a name is how a namesake's board gets taken for Amazon's.
    // A Workday token is compound ("pfizer.wd1.PfizerCareers"): the tenant, the first part, is the name.
    const tenant = titleCase(candidate.token.split('.')[0])
    if (!check.ok && pasted && check.reason === 'not_linked' && check.jobs && check.jobs.length > 0) {
      const name = check.identity?.name || tenant
      check = isKnownEmployer({ name }) && !check.identity?.name
        ? { ok: false, reason: 'other_owner', identity: check.identity, jobs: check.jobs }
        : { ok: true, verifiedBy: 'careers_url', jobs: check.jobs, domain: null, name }
    }
    // A board gone quiet under a big employer's name is a namesake's too ("amazon" on Personio holds 2018 postings).
    if (!check.ok && pasted && check.reason === 'stale' && isKnownEmployer({ name: tenant })) check = { ok: false, reason: 'other_owner', jobs: check.jobs }
    if (!check.ok) {
      failed.push(check)
      return null
    }
    passed.set(`${candidate.provider}:${candidate.token}`, check)
    return { provider: candidate.provider, token: candidate.token, via: candidate.via, jobs: check.jobs, verifiedBy: check.verifiedBy }
  }

  // A board checked by hand for this employer (Datadog, Ramp) is tried first: their pages link it only through script.
  const curated = domain ? knownBoard({ domain, careerUrl: url.href }) : null
  const fromCurated: BoardRead | null = curated ? await readBoard({ ...curated, via: 'link' }, []).catch(() => null) : null
  const read: SiteRead = fromCurated
    ? { tier: 'board', jobs: fromCurated.jobs, board: fromCurated, complete: false, reason: null, tried: [], checked: [], requests: 0 }
    : await deps.read({ company: { name: guess ?? '', domain, careerUrl: url.href }, targets: NO_TARGETS }, readBoard)

  if (read.board) {
    const ok = passed.get(`${read.board.provider}:${read.board.token}`)
    if (ok) {
      return writeEmployer(db, {
        name: ok.name,
        // the host of the pasted link, never the board's own declared home (whoever owns a board can edit that)
        domain: domain ?? curatedHome(ok),
        careersUrl: directToken ? null : url.href,
        provider: read.board.provider,
        token: read.board.token,
        verifiedBy: ok.verifiedBy,
        source: 'person',
        openCount: ok.jobs.length,
        readTier: 'board',
        keepExisting: true,
      })
    }
  }
  // No board, but the employer's own site lists roles Cello could read: tied to the employer by the address it was read at.
  if (domain && read.tier && read.tier !== 'board' && read.jobs.length > 0) {
    deps.report?.({ step: 'board_found', provider: null, line: 'Found roles on the page itself' })
    return writeEmployer(db, {
      name: guess ?? domain,
      domain,
      careersUrl: url.href,
      provider: null,
      token: null,
      verifiedBy: 'careers_url_host',
      source: 'person',
      openCount: read.complete ? read.jobs.length : null,
      readTier: read.tier,
      keepExisting: true,
    })
  }

  // Nothing verified: the board that failed says why; otherwise the reader's own reason.
  const first = failed[0]
  const reason: FailReason = first ? first.reason : read.message ? 'not_employer_site' : read.reason === 'no_roles' || read.reason === 'role_pages' || read.reason === null ? 'no_board' : 'cannot_read'
  const offers = reason === 'cannot_read' || reason === 'stale' ? [] : await directoryOffers(db, { name: first?.identity?.name ?? guess, domain, token: directToken })
  const browser = !first && !read.message && read.reason && read.reason in BROWSER_FIXES ? read.reason : undefined
  return { ok: false, reason, offers, name: guess ?? domain ?? '', browser }
}
