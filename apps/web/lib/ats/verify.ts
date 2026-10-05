// Board ownership. A (provider, token) pair guessed from a company's name
// answers for whoever owns that token: "amazon" on Personio is a different
// employer's board, and it holds London marketing jobs from 2018. A guessed
// board is therefore accepted only when something ties it to THIS company, and
// only while it is alive. When nothing verifies, the answer is "no readable
// source", never a guess.
//
// Evidence, cheapest first (any one is enough, and the board must be recent):
//   careers_page_link  the company's own careers page or site links to this exact board
//   board_links_home   a posting lives on the company's domain, or two or more postings link to or
//                      name it (on a host boundary: mercury.co is not mercury.com), or the board
//                      declares the company's domain as its own site
//   provider_name      the provider names the same employer (TLD ignored: "Honeycomb.io") AND the
//                      token is the domain's first label, with nothing against it
//   Against a board: it declares a home that is NOT the company's domain, or its postings link to a
//   rival domain (same name, other TLD) and never to the company's. Either rejects the name match.
// A known employer (known-companies.ts) is never matched by name or domain label: a
// namesake's board passes those, so it needs the page link or its curated board.
// Boards read off the careers URL itself ('careers_url') and boards the person
// set by hand ('manual') are trusted and never come through here.
//
// Framework-free like the rest of lib/ats: global fetch through ./http only.

import type { AtsJob, AtsProviderId } from './types'
import { HttpError, assertAllowedHost, assertAllowedHostSuffix, fetchJson, fetchText } from './http'
import { SUFFIX_WORDS } from '../companies/known-companies'

export type VerifiedBy =
  | 'careers_url'
  | 'manual'
  | 'known_board'
  | 'careers_page_link'
  | 'board_links_home'
  | 'provider_name'

export interface BoardRef {
  provider: AtsProviderId
  token: string
}

/** A board whose newest posting is older than this is dead. */
export const BOARD_MAX_AGE_DAYS = 365
const DAY_MS = 86_400_000

/**
 * True when at least one posting is dated within the last 12 months. Undated
 * boards count as dead: with nothing to show it is alive, fail closed.
 */
export function isRecentBoard(jobs: readonly AtsJob[], now: number = Date.now()): boolean {
  for (const job of jobs) {
    const t = job.postedAt ? Date.parse(job.postedAt) : NaN
    if (!Number.isNaN(t) && now - t <= BOARD_MAX_AGE_DAYS * DAY_MS) return true
  }
  return false
}

/** "Gusto, Inc." -> "gusto"; "Société Générale SA" -> "societegenerale". */
export function normalizeEmployerName(name: string): string {
  const words = name
    .replace(/\.(com|io|ai|co|dev|app|net|org|so|xyz|tech)\s*$/i, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  // Only TRAILING legal suffixes go, so "Wise Worksite Field Sales" stays itself.
  while (words.length > 1 && (SUFFIX_WORDS.has(words[words.length - 1]) || words[words.length - 1] === 'se' || words[words.length - 1] === 'com')) {
    words.pop()
  }
  return words.join('')
}

/** Strict: equal after normalisation, and not empty. */
export function sameEmployerName(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const na = normalizeEmployerName(a)
  return na.length > 0 && na === normalizeEmployerName(b)
}

function hostOf(value: string): string | null {
  try {
    const raw = value.includes('://') ? value : `https://${value}`
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

function alnum(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** The token is the domain's first label: "scaleai" is not "scale". */
export function tokenMatchesDomainLabel(token: string, domain: string | null | undefined): boolean {
  const host = domain ? hostOf(domain) : null
  const label = host ? alnum(host.split('.')[0]) : ''
  return label.length > 0 && alnum(token) === label
}

/** True when the URL's host is the company domain or one of its subdomains. */
export function onCompanyDomain(url: string | null | undefined, domain: string | null | undefined): boolean {
  const host = url ? hostOf(url) : null
  const root = domain ? hostOf(domain) : null
  return !!host && !!root && (host === root || host.endsWith(`.${root}`))
}

const PROVIDER_DOMAINS = ['greenhouse.io', 'lever.co', 'ashbyhq.com', 'workable.com', 'smartrecruiters.com', 'recruitee.com', 'personio.de', 'personio.com']
function onProviderHost(url: string): boolean {
  const host = hostOf(url)
  return !!host && PROVIDER_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))
}

/**
 * True when the text names the company's own site ("acme.com" or a link to it).
 * On a host boundary: "mercury.co" is not in "mercury.com" or "mercury.co.uk",
 * and "notmercury.co" is not "mercury.co" (www.mercury.co and a.mercury.co are).
 */
export function mentionsDomain(text: string | null | undefined, domain: string | null | undefined): boolean {
  const host = domain ? hostOf(domain) : null
  if (!text || !host) return false
  const re = new RegExp(`(?<![a-z0-9-])${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9-]|\\.[a-z0-9])`, 'i')
  return re.test(text)
}

/** Postings needed to name the company's site before that alone ties a board to it. */
const HOME_MENTIONS = 2

/** A posting links to, or names, the company's own site. */
function pointsHome(job: AtsJob, domain: string | null | undefined): boolean {
  return (job.linkHosts ?? []).some((h) => onCompanyDomain(h, domain)) || mentionsDomain(job.description, domain)
}

/** A posting that lives on the company's domain, or enough postings that link to or name it. */
export function boardPointsHome(jobs: readonly AtsJob[], domain: string | null | undefined): boolean {
  if (jobs.some((j) => onCompanyDomain(j.url, domain))) return true
  let n = 0
  for (const j of jobs) if (pointsHome(j, domain) && ++n >= HOME_MENTIONS) return true
  return false
}

const RIVAL_TLDS = 'com|net|org|io|co|ai|app|dev|so|us|uk|de|eu|tech|xyz|me|tv|ly|fm|gg|sh|cc'

/**
 * A posting links to another site that carries the company's name ("demo.mercury.com"
 * while the company is mercury.co): the board belongs to a namesake.
 */
export function pointsToRival(jobs: readonly AtsJob[], domain: string | null | undefined): boolean {
  const root = domain ? hostOf(domain) : null
  const label = root ? alnum(root.split('.')[0]) : ''
  if (!root || label.length < 2) return false
  const rivalHost = (host: string) =>
    !onCompanyDomain(host, root) && host.split('.').slice(0, -1).some((part) => alnum(part) === label)
  const textRe = new RegExp(`(?<![a-z0-9-])((?:[a-z0-9-]+\\.)*${label}\\.(?:${RIVAL_TLDS})(?:\\.[a-z]{2})?)(?![a-z0-9-])`, 'gi')
  return jobs.some(
    (j) =>
      (j.linkHosts ?? []).some(rivalHost) ||
      [...(j.description ?? '').matchAll(textRe)].some((m) => rivalHost(m[1].toLowerCase()))
  )
}

// ---------------------------------------------------------------------------
// What each provider says about who owns a board. Plain public GETs through
// ./http (host allow-list, timeout, breaker). Personio's feed has no employer
// field at all, so a guessed Personio board can only pass through a page link.
// ---------------------------------------------------------------------------

export interface BoardIdentity {
  name: string | null
  /** URLs on the board that may point back at the company's own site. */
  homeUrls: string[]
}

const OPTS = { retries: 1, timeoutMs: 8000 }
const HTML = { ...OPTS, headers: { accept: 'text/html' } }
const GH_HOSTS = new Set(['boards-api.greenhouse.io'])
const LEVER_HOSTS = new Set(['jobs.lever.co'])
const ASHBY_HOSTS = new Set(['jobs.ashbyhq.com'])
const WORKABLE_HOSTS = new Set(['apply.workable.com'])
const SR_HOSTS = new Set(['api.smartrecruiters.com'])
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

export const IDENTIFY: Partial<Record<AtsProviderId, (token: string) => Promise<BoardIdentity>>> = {
  async greenhouse(t) {
    const url = assertAllowedHost(`https://boards-api.greenhouse.io/v1/boards/${t}`, GH_HOSTS)
    const d = await fetchJson<{ name?: unknown }>(url, OPTS)
    return { name: str(d?.name), homeUrls: [] }
  },
  async lever(t) {
    const url = assertAllowedHost(`https://jobs.lever.co/${t}`, LEVER_HOSTS)
    const html = await fetchText(url, HTML)
    const title = /<title>([^<]*)<\/title>/i.exec(html)
    const home = /class="main-header-logo"><a href="([^"]+)"/.exec(html)
    return { name: title ? str(title[1]) : null, homeUrls: home ? [home[1]] : [] }
  },
  async ashby(t) {
    const url = assertAllowedHost(`https://jobs.ashbyhq.com/${t}`, ASHBY_HOSTS)
    const html = await fetchText(url, HTML)
    const m = /"name":"([^"]*)","publicWebsite":"([^"]*)"/.exec(html)
    return { name: m ? str(m[1]) : null, homeUrls: m && m[2] ? [m[2]] : [] }
  },
  async workable(t) {
    const url = assertAllowedHost(`https://apply.workable.com/api/v1/widget/accounts/${t}`, WORKABLE_HOSTS)
    const d = await fetchJson<{ name?: unknown }>(url, OPTS)
    return { name: str(d?.name), homeUrls: [] }
  },
  async recruitee(t) {
    const url = assertAllowedHostSuffix(`https://${t}.recruitee.com/api/offers/`, ['.recruitee.com'])
    const d = await fetchJson<{ offers?: Array<{ company_name?: unknown; careers_url?: unknown }> }>(url, OPTS)
    const first = Array.isArray(d?.offers) ? d.offers[0] : undefined
    return { name: str(first?.company_name), homeUrls: str(first?.careers_url) ? [first!.careers_url as string] : [] }
  },
  async smartrecruiters(t) {
    const url = assertAllowedHost(`https://api.smartrecruiters.com/v1/companies/${t}/postings?limit=1`, SR_HOSTS)
    const d = await fetchJson<{ content?: Array<{ company?: { name?: unknown } }> }>(url, OPTS)
    return { name: str(d?.content?.[0]?.company?.name), homeUrls: [] }
  },
}

export interface VerifyInput extends BoardRef {
  /** The postings the adapter already fetched. */
  jobs: readonly AtsJob[]
  company: { name: string | null; domain: string | null }
  /** Boards the company's own site links to, or a lazy way to find them. */
  pageBoards?: readonly BoardRef[] | (() => Promise<readonly BoardRef[]>)
  /** A big known employer: only its own site's link counts (see header). */
  knownEmployer?: boolean
  /** Out-param: set true when the provider could not be asked (timeout, 5xx), so a null is not a verdict. */
  evidence?: { unreachable: boolean }
  now?: number
}

/**
 * Why this board is the company's, or null when nothing ties it to them (or it
 * is dead). Never throws: a failed identity call is simply no evidence.
 */
export async function verifyBoard(input: VerifyInput): Promise<Exclude<VerifiedBy, 'careers_url' | 'manual' | 'known_board'> | null> {
  const { provider, token, jobs, company } = input
  if (!isRecentBoard(jobs, input.now)) return null

  const linked = (boards: readonly BoardRef[]) =>
    boards.some((b) => b.provider === provider && b.token.toLowerCase() === token.toLowerCase())
  const pb = input.pageBoards

  // 1. The company's own site links to this exact board (already read).
  if (pb && typeof pb !== 'function' && linked(pb)) return 'careers_page_link'

  // 2. The board's own postings point at the company's domain (free: already fetched).
  if (!input.knownEmployer && boardPointsHome(jobs, company.domain)) return 'board_links_home'

  // 2b. Same as 1, but the site is only read now (a stored board being re-checked).
  if (typeof pb === 'function') {
    try {
      if (linked(await pb())) return 'careers_page_link'
    } catch {
      /* no evidence */
    }
  }

  // 3. The provider's own record of the board.
  if (input.knownEmployer) return null
  const identify = IDENTIFY[provider]
  if (!identify) return null
  let identity: BoardIdentity
  try {
    identity = await identify(token)
  } catch (error) {
    // A timeout or a 5xx says nothing about who owns the board; only a plain "not found" does.
    if (input.evidence && !(error instanceof HttpError && (error.status === 404 || error.status === 410))) {
      input.evidence.unreachable = true
    }
    return null
  }
  // A home the board declares for itself decides: on the company's domain it ties
  // the board to them, anywhere else it is another employer who shares the name
  // ("atlas" on Ashby declares atlascard.com), and no name match overrides that.
  // (A link back to the provider's own host, as Recruitee gives, declares nothing.)
  const declared = identity.homeUrls.filter((u) => !onProviderHost(u))
  if (declared.length > 0) {
    return declared.some((u) => onCompanyDomain(u, company.domain)) ? 'board_links_home' : null
  }
  // The provider declares no site. The same name and a token that is the domain's first
  // label tie the board to the company, unless the board's own postings point at a rival
  // domain (a namesake: mercury.com's board is not mercury.co's).
  if (
    sameEmployerName(identity.name, company.name) &&
    tokenMatchesDomainLabel(token, company.domain) &&
    !pointsToRival(jobs, company.domain)
  ) {
    return 'provider_name'
  }
  return null
}
