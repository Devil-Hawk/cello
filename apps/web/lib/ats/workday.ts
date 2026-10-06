// Workday adapter — the public CXS endpoints behind every myworkdayjobs.com
// career site. No auth required.
//   POST https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
//   GET  https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}{externalPath}
//
// THE TOKEN IS COMPOUND. Every other provider here is identified by one slug;
// a Workday board needs three coordinates — the tenant, which Workday data
// centre serves it (wd1/wd3/wd5/…), and the career SITE id, which is a name
// the customer chose ("NVIDIAExternalCareerSite", "Search", "Careers"). They
// are packed into the single `token` the AtsProvider contract and
// companies.metadata.ats store, joined with dots so the result still satisfies
// TOKEN_RE: "nvidia.wd5.NVIDIAExternalCareerSite".
//
// THAT IS ALSO WHY WORKDAY IS NOT PROBED. ./detect.ts's probe guesses a slug
// from the company domain/name; it cannot guess a data centre and a site id,
// and brute-forcing wd1..wd12 x a site-name dictionary would be dozens of
// requests per company across 436 companies. Workday is detected from the
// careers URL only — which is the common case, since that URL is exactly what
// a company publishes.

import type { AtsJob, AtsProvider, DetectInput, FetchContext } from './types'
import { isValidToken } from './types'
import { assertAllowedHostSuffix, fetchJson } from './http'
import { htmlToPlainText, rawHtmlOf } from './html'
import { mapWithConcurrency } from './concurrency'

const API_HOST_SUFFIXES = ['.myworkdayjobs.com']

const BOARD_HOST_RE = /^([A-Za-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/
/** "nvidia.wd5.NVIDIAExternalCareerSite" — see the compound-token note above. */
const TOKEN_PARTS_RE = /^([A-Za-z0-9-]+)\.(wd\d+)\.([A-Za-z0-9._-]+)$/
/** Career sites are served under an optional locale segment: /en-US/{site}. */
const LOCALE_SEGMENT_RE = /^[a-z]{2}(?:-[A-Za-z]{2})?$/

/** The API rejects limit > 20 with a 400 (verified), so paging is fixed at 20. */
const PAGE_SIZE = 20
/**
 * Cap the newest 500 postings. Workday tenants are enterprises — NVIDIA's
 * board alone has 2,000 open roles, which at 20 per page is 100 requests for
 * ONE company. The list is ordered newest-first (verified: offset 0 is
 * "Posted Today", offset 1000 is "Posted 25 Days Ago"), so the cap drops the
 * oldest postings, which by definition are not what a refresh is discovering.
 */
const MAX_PAGES = 25
/** A search by the person's targets: at most this many words, each read for at most this many pages (3 x 8 = 24, inside MAX_PAGES). */
const MAX_QUERIES = 3
const MAX_PAGES_PER_QUERY = 8

/**
 * How many postings get their body fetched per refresh. The list response
 * carries no description at all, only a per-posting detail call does, so the
 * budget goes to postings that have no stored body yet (see
 * FetchContext.hasDescription) and a large board fills in over a few refreshes.
 */
const DESCRIPTION_BUDGET = 40
const DESCRIPTION_CONCURRENCY = 4

interface WorkdayJobPosting {
  title?: string
  /** "/job/India-Pune/Senior-System-Software-Engineer_JR2022506" */
  externalPath?: string
  locationsText?: string
  /** Relative text ("Posted Today"), NOT a date — see toPostedAt below. */
  postedOn?: string
  bulletFields?: string[]
}

interface WorkdayListResponse {
  total?: number
  jobPostings?: WorkdayJobPosting[]
}

interface WorkdayDetailResponse {
  jobPostingInfo?: {
    jobDescription?: string
    /** ISO calendar date, e.g. "2026-08-04". */
    startDate?: string
    location?: string
    timeType?: string
  }
}

interface BoardCoordinates {
  tenant: string
  /** The "wd5" data-centre label, kept verbatim. */
  datacenter: string
  site: string
}

function parseToken(token: string): BoardCoordinates | null {
  const match = TOKEN_PARTS_RE.exec(token)
  if (!match) return null
  return { tenant: match[1], datacenter: match[2], site: match[3] }
}

function boardOrigin(board: BoardCoordinates): string {
  return `https://${board.tenant}.${board.datacenter}.myworkdayjobs.com`
}

/** Public posting URL — the same string the detail response calls `externalUrl`
 *  (verified), rebuilt from the list response so an externalId does not depend
 *  on whether the description budget reached this job. */
function postingUrl(board: BoardCoordinates, externalPath: string): string {
  return `${boardOrigin(board)}/${board.site}${externalPath}`
}

/** "Posted Today" 0, "Posted Yesterday" 1, "Posted 3 Days Ago" 3, "Posted 30+ Days Ago" 31; anything else sorts last. */
function ageInDays(postedOn: string | undefined): number {
  const text = (postedOn ?? '').toLowerCase()
  if (text.includes('today')) return 0
  if (text.includes('yesterday')) return 1
  const n = /(\d+)(\+?)\s*days?/.exec(text)
  return n ? Number(n[1]) + (n[2] ? 1 : 0) : 999
}

function toIso(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString()
}

function detect(input: DetectInput): { token: string } | null {
  if (!input.careerUrl) return null
  let url: URL
  try {
    url = new URL(input.careerUrl)
  } catch {
    return null
  }
  const host = BOARD_HOST_RE.exec(url.hostname)
  if (!host) return null
  const [, tenant, datacenter] = host

  const segments = url.pathname.split('/').filter(Boolean)
  // A CXS URL (/wday/cxs/{tenant}/{site}/…) names the site in position 3;
  // a human-facing board URL names it first, after an optional locale.
  let site: string | undefined
  if (segments[0] === 'wday') {
    site = segments[3]
  } else {
    site = LOCALE_SEGMENT_RE.test(segments[0] ?? '') ? segments[1] : segments[0]
  }
  if (!site) return null

  const token = `${tenant}.${datacenter}.${site}`
  return isValidToken(token) && TOKEN_PARTS_RE.test(token) ? { token } : null
}

async function fetchPage(board: BoardCoordinates, offset: number, searchText = ''): Promise<WorkdayJobPosting[]> {
  const apiUrl = `${boardOrigin(board)}/wday/cxs/${board.tenant}/${board.site}/jobs`
  assertAllowedHostSuffix(apiUrl, API_HOST_SUFFIXES)
  const json = await fetchJson<WorkdayListResponse>(apiUrl, {
    method: 'POST',
    body: JSON.stringify({ appliedFacets: {}, limit: PAGE_SIZE, offset, searchText }),
  })
  return Array.isArray(json?.jobPostings) ? json.jobPostings : []
}

async function fetchDetail(
  board: BoardCoordinates,
  externalPath: string
): Promise<{ description?: string; descriptionHtml?: string; postedAt?: string }> {
  const apiUrl = `${boardOrigin(board)}/wday/cxs/${board.tenant}/${board.site}${externalPath}`
  assertAllowedHostSuffix(apiUrl, API_HOST_SUFFIXES)
  try {
    const json = await fetchJson<WorkdayDetailResponse>(apiUrl)
    return {
      description: htmlToPlainText(json?.jobPostingInfo?.jobDescription),
      descriptionHtml: rawHtmlOf(json?.jobPostingInfo?.jobDescription),
      postedAt: toIso(json?.jobPostingInfo?.startDate),
    }
  } catch {
    // One unreadable posting must not cost the whole board.
    return {}
  }
}

async function fetchJobs(token: string, ctx?: FetchContext): Promise<AtsJob[]> {
  const board = parseToken(token)
  if (!board) throw new Error(`workday: invalid board token "${token}" (expected {tenant}.wd{N}.{site})`)

  // With the person's targets the board is searched for each word (the site filters, so a 2,000-role board still shows its engineering roles);
  // with none it is the newest window. Either way the page budget is the same.
  const terms = (ctx?.query ?? []).map((q) => q.trim()).filter(Boolean).slice(0, MAX_QUERIES)
  const searches = terms.length ? terms : ['']
  const maxPages = terms.length ? MAX_PAGES_PER_QUERY : MAX_PAGES
  let postings: WorkdayJobPosting[] = []
  for (const term of searches) {
    for (let page = 0; page < maxPages; page += 1) {
      const batch = await fetchPage(board, page * PAGE_SIZE, term)
      postings.push(...batch)
      if (batch.length < PAGE_SIZE) break
    }
  }
  // Merged newest first; "Posted 3 Days Ago" is only good for ordering, never stored as a date. Stable, so equal ages keep the site's order.
  if (terms.length > 1) postings = postings.map((p, i) => ({ p, i, age: ageInDays(p.postedOn) })).sort((a, b) => a.age - b.age || a.i - b.i).map((x) => x.p)

  const jobs: AtsJob[] = []
  const paths: string[] = []
  const byPath = new Map<string, AtsJob>()
  for (const posting of postings) {
    if (!posting || typeof posting.externalPath !== 'string' || !posting.externalPath) continue
    if (byPath.has(posting.externalPath)) continue
    const url = postingUrl(board, posting.externalPath)
    const job: AtsJob = {
      title: typeof posting.title === 'string' ? posting.title : '',
      url,
      externalId: url,
      location: typeof posting.locationsText === 'string' && posting.locationsText.trim() ? posting.locationsText.trim() : undefined,
      // `postedOn` is relative prose ("Posted Today", "Posted 30+ Days Ago"),
      // which is not a date and is not worth guessing one from. A real
      // timestamp only exists on the detail response (`startDate`), so
      // postedAt is filled in below for the jobs inside the budget and left
      // undefined for the rest — honest, and posted_at is nullable.
    }
    jobs.push(job)
    paths.push(posting.externalPath)
    byPath.set(posting.externalPath, job)
  }

  // The budget goes to postings that have no stored body yet, newest first, so a
  // board larger than the budget fills in over successive refreshes instead of
  // re-reading the same head every time.
  const head = paths
    .filter((path) => !ctx?.hasDescription?.(byPath.get(path)?.externalId ?? ''))
    .slice(0, DESCRIPTION_BUDGET)
  const details = await mapWithConcurrency(head, DESCRIPTION_CONCURRENCY, (path) => fetchDetail(board, path))
  head.forEach((path, i) => {
    const job = byPath.get(path)
    if (!job) return
    if (details[i].description) job.description = details[i].description
    if (details[i].descriptionHtml) job.descriptionHtml = details[i].descriptionHtml
    if (details[i].postedAt) job.postedAt = details[i].postedAt
  })

  return jobs
}

export const workday: AtsProvider = {
  id: 'workday',
  detect,
  fetch: fetchJobs,
  maxJobs: MAX_PAGES * PAGE_SIZE,
  searchesByQuery: true,
}
