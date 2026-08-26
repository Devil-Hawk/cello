// Workable adapter — public job-board widget API, no auth required.
// GET https://apply.workable.com/api/v1/widget/accounts/{account}?details=true
//
// `details=true` is what makes the response carry the posting body. Without it
// every job arrives as title + location only — the same trap ./greenhouse.ts
// documents for its `content=true`. One list call still covers the whole
// board, so descriptions cost zero extra requests here.

import type { AtsJob, AtsProvider, DetectInput } from './types'
import { isValidToken } from './types'
import { assertAllowedHost, fetchJson } from './http'
import { htmlToPlainText } from './html'

const API_HOSTS = new Set(['apply.workable.com'])

const BOARD_HOST = 'apply.workable.com'
// Legacy per-account boards, e.g. https://acme.workable.com/. `apply`, `www`
// and `jobs` are Workable's own hosts, not customer accounts.
const LEGACY_BOARD_RE = /^([A-Za-z0-9-]+)\.workable\.com$/
const RESERVED_SUBDOMAINS = new Set(['apply', 'www', 'jobs', 'careers', 'help', 'blog', 'get'])

interface WorkableLocation {
  country?: string
  countryCode?: string
  city?: string
  region?: string
  /** Workable hides a location from the public board without removing it. */
  hidden?: boolean
}

interface WorkableJob {
  title?: string
  shortcode?: string
  url?: string
  shortlink?: string
  employment_type?: string
  telecommuting?: boolean
  department?: string
  published_on?: string
  created_at?: string
  country?: string
  city?: string
  state?: string
  locations?: WorkableLocation[]
  /** Only present when the board is fetched with ?details=true. */
  description?: string
}

interface WorkableResponse {
  name?: string
  jobs?: WorkableJob[]
}

/**
 * `published_on` is a bare calendar date ("2026-07-13"), not a timestamp.
 * Date.parse() reads that as UTC midnight, which is the honest reading: the
 * board tells us the day, not the moment.
 */
function toIso(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString()
}

function joinParts(parts: (string | undefined)[]): string | undefined {
  const clean = parts.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map((p) => p.trim())
  const unique = [...new Set(clean)]
  return unique.length > 0 ? unique.join(', ') : undefined
}

// Prefer the structured `locations[]` (a posting can be open in several
// cities) and fall back to the flat city/state/country fields, which are what
// single-location postings carry. Hidden entries are skipped — the board does
// not show them either. "Remote" is prepended for telecommuting roles because
// nothing else in the payload says so and lib/jobs/classify.ts reads location
// text to decide `is_remote`.
function formatLocation(j: WorkableJob): string | undefined {
  const labels: string[] = []
  if (Array.isArray(j.locations)) {
    for (const loc of j.locations) {
      if (!loc || typeof loc !== 'object' || loc.hidden === true) continue
      const label = joinParts([loc.city, loc.region, loc.country])
      if (label) labels.push(label)
    }
  }
  if (labels.length === 0) {
    const flat = joinParts([j.city, j.state, j.country])
    if (flat) labels.push(flat)
  }
  const unique = [...new Set(labels)]
  const place = unique.length > 0 ? unique.join(' · ') : undefined
  if (j.telecommuting === true) return place ? `Remote · ${place}` : 'Remote'
  return place
}

function detect(input: DetectInput): { token: string } | null {
  if (!input.careerUrl) return null
  let url: URL
  try {
    url = new URL(input.careerUrl)
  } catch {
    return null
  }

  const segments = url.pathname.split('/').filter(Boolean)
  if (url.hostname === BOARD_HOST) {
    // apply.workable.com/j/{shortcode} is a single POSTING, not a board — it
    // carries no account slug, so there is nothing to detect.
    if (segments[0] === 'j' || segments[0] === 'api') return null
    return isValidToken(segments[0]) ? { token: segments[0] } : null
  }

  const legacy = LEGACY_BOARD_RE.exec(url.hostname)
  if (legacy && !RESERVED_SUBDOMAINS.has(legacy[1].toLowerCase())) {
    return isValidToken(legacy[1]) ? { token: legacy[1] } : null
  }
  return null
}

async function fetchJobs(token: string): Promise<AtsJob[]> {
  if (!isValidToken(token)) throw new Error(`workable: invalid account slug`)
  const apiUrl = `https://apply.workable.com/api/v1/widget/accounts/${token}?details=true`
  assertAllowedHost(apiUrl, API_HOSTS)
  const json = await fetchJson<WorkableResponse>(apiUrl)
  const jobs = Array.isArray(json?.jobs) ? json.jobs : []
  const results: AtsJob[] = []
  for (const j of jobs) {
    if (!j || typeof j !== 'object') continue
    // The canonical posting URL is apply.workable.com/j/{shortcode}; the
    // payload's own `url`/`shortlink` already are that, so prefer them and
    // only rebuild from the shortcode when both are missing. Either way the
    // externalId is that stable URL — it never changes when the posting is
    // edited or the account is renamed, unlike a slug.
    const url =
      (typeof j.url === 'string' && j.url) ||
      (typeof j.shortlink === 'string' && j.shortlink) ||
      (typeof j.shortcode === 'string' && j.shortcode ? `https://apply.workable.com/j/${j.shortcode}` : '')
    if (!url) continue
    results.push({
      title: typeof j.title === 'string' ? j.title : '',
      url,
      externalId: url,
      location: formatLocation(j),
      description: htmlToPlainText(j.description),
      postedAt: toIso(j.published_on) ?? toIso(j.created_at),
    })
  }
  return results
}

export const workable: AtsProvider = {
  id: 'workable',
  detect,
  fetch: fetchJobs,
}
