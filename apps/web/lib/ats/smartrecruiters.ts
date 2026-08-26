// SmartRecruiters adapter — public Posting API, no auth required.
// GET https://api.smartrecruiters.com/v1/companies/{id}/postings?limit=100&offset=N
// GET https://api.smartrecruiters.com/v1/companies/{id}/postings/{postingId}
//
// Unlike Greenhouse/Workable/Recruitee there is no "give me the bodies too"
// flag: the list call returns metadata only, and the posting body lives behind
// one detail call PER JOB. See DESCRIPTION_BUDGET below for how that is
// bounded — a 436-company scheduled refresh cannot afford one request per
// posting for every board.

import type { AtsJob, AtsProvider, DetectInput } from './types'
import { isValidToken } from './types'
import { assertAllowedHost, fetchJson } from './http'
import { htmlSectionsToPlainText } from './html'
import { mapWithConcurrency } from './concurrency'

const API_HOST = 'api.smartrecruiters.com'
const API_HOSTS = new Set([API_HOST])
const BOARD_HOST = 'jobs.smartrecruiters.com'

const BOARD_HOST_RE = /^(?:jobs|careers)\.smartrecruiters\.com$/

/** The API caps `limit` at 100 (verified: limit=200 still returns 100). */
const PAGE_SIZE = 100
/** Stop paging here. 5 pages is far past any board this user watches. */
const MAX_PAGES = 5

/**
 * How many postings get their body fetched per refresh.
 *
 * The list is ordered newest-first (verified against Sodexo: releasedDate
 * descending), and the newest postings are exactly the ones a refresh is
 * likely to be INSERTING — an already-stored row keeps the description it was
 * inserted with. So spending the budget on the head of the list is spending it
 * where it changes what gets written. Anything past the budget is still
 * returned, just without a body; lib/jobs/classify.ts scores those on title
 * and location (base 55 vs a 30 reject threshold), so they are kept, not lost.
 */
const DESCRIPTION_BUDGET = 25
const DESCRIPTION_CONCURRENCY = 4

interface SmartRecruitersLocation {
  city?: string
  region?: string
  country?: string
  remote?: boolean
}

interface SmartRecruitersPosting {
  id?: string
  name?: string
  releasedDate?: string
  location?: SmartRecruitersLocation
  /** Canonical company id, in the casing SmartRecruiters itself uses. */
  company?: { identifier?: string; name?: string }
  /** Only on the detail response. */
  postingUrl?: string
  jobAd?: { sections?: Record<string, { title?: string; text?: string } | undefined> }
}

interface SmartRecruitersListResponse {
  offset?: number
  limit?: number
  totalFound?: number
  content?: SmartRecruitersPosting[]
}

function toIso(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString()
}

// `location` has no pre-rendered label on the list response (`fullLocation`
// exists but is inconsistent across tenants), so build one. ISO country codes
// arrive lower-cased ("au") and are upper-cased back.
function formatLocation(posting: SmartRecruitersPosting): string | undefined {
  const loc = posting.location
  if (!loc || typeof loc !== 'object') return undefined
  const parts: string[] = []
  if (loc.remote === true) parts.push('Remote')
  for (const value of [loc.city, loc.region]) {
    if (typeof value === 'string' && value.trim()) parts.push(value.trim())
  }
  if (typeof loc.country === 'string' && loc.country.trim()) {
    parts.push(loc.country.trim().length <= 3 ? loc.country.trim().toUpperCase() : loc.country.trim())
  }
  const unique = [...new Set(parts)]
  return unique.length > 0 ? unique.join(', ') : undefined
}

// A posting body is split across named sections (companyDescription,
// jobDescription, qualifications, additionalInformation) plus a `videos`
// section that has no `text` at all. Ordered deliberately rather than by
// Object.keys() so the same posting always produces the same string.
const SECTION_ORDER = ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation'] as const

function descriptionFrom(detail: SmartRecruitersPosting): string | undefined {
  const sections = detail.jobAd?.sections
  if (!sections || typeof sections !== 'object') return undefined
  return htmlSectionsToPlainText(SECTION_ORDER.map((key) => sections[key]?.text))
}

function detect(input: DetectInput): { token: string } | null {
  if (!input.careerUrl) return null
  let url: URL
  try {
    url = new URL(input.careerUrl)
  } catch {
    return null
  }
  if (!BOARD_HOST_RE.test(url.hostname)) return null
  const token = url.pathname.split('/').filter(Boolean)[0]
  return isValidToken(token) ? { token } : null
}

/**
 * Canonical public posting URL, and therefore the externalId.
 *
 * Two deliberate choices, both about STABILITY — an externalId that varies for
 * the same posting writes a duplicate row:
 *  - the id-only form, without the trailing title slug the board itself links
 *    to (verified live: it resolves 200), because that slug changes whenever
 *    someone edits the title;
 *  - the company id taken from the PAYLOAD rather than from our token. The API
 *    is case-insensitive, so URL detection produces "Sodexo" and the probe
 *    produces "sodexo" for the same board; the payload always reports the
 *    canonical casing (verified: a lowercase request still answers
 *    company.identifier = "Sodexo").
 */
function postingUrl(company: string, id: string): string {
  return `https://${BOARD_HOST}/${company}/${id}`
}

function canonicalCompany(posting: SmartRecruitersPosting, token: string): string {
  const identifier = posting.company?.identifier
  return typeof identifier === 'string' && identifier.trim() ? identifier.trim() : token
}

async function fetchPage(token: string, offset: number): Promise<SmartRecruitersPosting[]> {
  const apiUrl = `https://${API_HOST}/v1/companies/${token}/postings?limit=${PAGE_SIZE}&offset=${offset}`
  assertAllowedHost(apiUrl, API_HOSTS)
  const json = await fetchJson<SmartRecruitersListResponse>(apiUrl)
  return Array.isArray(json?.content) ? json.content : []
}

async function fetchDescription(token: string, id: string): Promise<string | undefined> {
  const apiUrl = `https://${API_HOST}/v1/companies/${token}/postings/${encodeURIComponent(id)}`
  assertAllowedHost(apiUrl, API_HOSTS)
  try {
    return descriptionFrom(await fetchJson<SmartRecruitersPosting>(apiUrl))
  } catch {
    // One unreadable posting must not cost the whole board — the row is still
    // worth inserting without its body.
    return undefined
  }
}

async function fetchJobs(token: string): Promise<AtsJob[]> {
  if (!isValidToken(token)) throw new Error(`smartrecruiters: invalid company id`)

  const postings: SmartRecruitersPosting[] = []
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await fetchPage(token, page * PAGE_SIZE)
    postings.push(...batch)
    if (batch.length < PAGE_SIZE) break
  }

  const jobs: AtsJob[] = []
  const byId = new Map<string, AtsJob>()
  for (const posting of postings) {
    if (!posting || typeof posting.id !== 'string' || !posting.id) continue
    if (byId.has(posting.id)) continue
    const url = postingUrl(canonicalCompany(posting, token), posting.id)
    const job: AtsJob = {
      title: typeof posting.name === 'string' ? posting.name : '',
      url,
      externalId: url,
      location: formatLocation(posting),
      postedAt: toIso(posting.releasedDate),
    }
    jobs.push(job)
    byId.set(posting.id, job)
  }

  // Map iteration order is insertion order, so this is the head of the
  // newest-first list — see DESCRIPTION_BUDGET.
  const ids = [...byId.keys()].slice(0, DESCRIPTION_BUDGET)
  const descriptions = await mapWithConcurrency(ids, DESCRIPTION_CONCURRENCY, (id) => fetchDescription(token, id))
  ids.forEach((id, i) => {
    const description = descriptions[i]
    const job = byId.get(id)
    if (description && job) job.description = description
  })

  return jobs
}

export const smartrecruiters: AtsProvider = {
  id: 'smartrecruiters',
  detect,
  fetch: fetchJobs,
}
