// Recruitee adapter — public offers API, no auth required.
// GET https://{company}.recruitee.com/api/offers/
//
// One call returns the whole board *including* the posting body (`description`)
// and `requirements`, so descriptions cost no extra requests.

import type { AtsJob, AtsProvider, DetectInput } from './types'
import { isValidToken } from './types'
import { assertAllowedHostSuffix, fetchJson } from './http'
import { htmlSectionsToPlainText } from './html'

// Every customer gets {company}.recruitee.com, so the allowlist is a suffix
// rather than a fixed host — see assertAllowedHostSuffix for why that is
// still a real guard.
const API_HOST_SUFFIXES = ['.recruitee.com']

const BOARD_HOST_RE = /^([A-Za-z0-9-]+)\.recruitee\.com$/
const RESERVED_SUBDOMAINS = new Set(['www', 'api', 'app', 'jobs', 'help', 'support', 'blog'])

interface RecruiteeSalary {
  min?: string | number
  max?: string | number
  currency?: string
  period?: string
}

interface RecruiteeOffer {
  id?: number | string
  slug?: string
  title?: string
  /** Absolute URL of the posting on the company's careers site. */
  careers_url?: string
  status?: string
  location?: string
  city?: string
  country?: string
  country_code?: string
  remote?: boolean
  published_at?: string
  created_at?: string
  description?: string
  requirements?: string
  salary?: RecruiteeSalary
}

interface RecruiteeResponse {
  offers?: RecruiteeOffer[]
}

/** Recruitee stamps "2026-07-31 14:40:34 UTC" — Date.parse reads it correctly. */
function toIso(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString()
}

function toFiniteNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

// Recruitee stores salary bounds as decimal STRINGS ("75000") with a separate
// period ("year", "month", "hour"). Left as the source's own interval rather
// than annualized: unlike Ashby's fixed interval vocabulary this field is free
// text a recruiter typed, so multiplying it would be guessing.
function formatSalary(offer: RecruiteeOffer): string | undefined {
  const salary = offer.salary
  if (!salary || typeof salary !== 'object') return undefined
  const min = toFiniteNumber(salary.min)
  const max = toFiniteNumber(salary.max)
  if (min == null && max == null) return undefined
  const currency = typeof salary.currency === 'string' && salary.currency ? `${salary.currency.toUpperCase()} ` : ''
  const period = typeof salary.period === 'string' && salary.period ? ` per ${salary.period}` : ''
  const fmt = (n: number) => n.toLocaleString('en-US')
  const span = min != null && max != null && min !== max ? `${fmt(min)}–${fmt(max)}` : fmt((min ?? max) as number)
  return `${currency}${span}${period}`.trim()
}

// `location` is already a rendered label ("Berlin, Berlin, Germany"), except
// for remote roles where Recruitee replaces it with the literal string
// "Remote job" and the real city only survives in `city`/`country`.
function formatLocation(offer: RecruiteeOffer): string | undefined {
  const parts: string[] = []
  const rendered = typeof offer.location === 'string' ? offer.location.trim() : ''
  const place = [offer.city, offer.country]
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .map((p) => p.trim())
    .join(', ')
  if (offer.remote === true) {
    parts.push('Remote')
    if (place) parts.push(place)
  } else if (rendered) {
    parts.push(rendered)
  } else if (place) {
    parts.push(place)
  }
  const unique = [...new Set(parts)]
  return unique.length > 0 ? unique.join(' · ') : undefined
}

function detect(input: DetectInput): { token: string } | null {
  if (!input.careerUrl) return null
  let url: URL
  try {
    url = new URL(input.careerUrl)
  } catch {
    return null
  }
  const match = BOARD_HOST_RE.exec(url.hostname)
  if (!match) return null
  const token = match[1]
  if (RESERVED_SUBDOMAINS.has(token.toLowerCase())) return null
  return isValidToken(token) ? { token } : null
}

async function fetchJobs(token: string): Promise<AtsJob[]> {
  if (!isValidToken(token)) throw new Error(`recruitee: invalid company slug`)
  const apiUrl = `https://${token}.recruitee.com/api/offers/`
  assertAllowedHostSuffix(apiUrl, API_HOST_SUFFIXES)
  const json = await fetchJson<RecruiteeResponse>(apiUrl)
  const offers = Array.isArray(json?.offers) ? json.offers : []
  const results: AtsJob[] = []
  for (const offer of offers) {
    if (!offer || typeof offer !== 'object') continue
    // Boards also carry drafts/closed offers; only published ones are live.
    if (typeof offer.status === 'string' && offer.status !== 'published') continue
    // `careers_url` points at the company's own careers domain when they use
    // one (verified: hygraph's offers link to jobs.hygraph.com, not
    // hygraph.recruitee.com), so it is the URL a human would actually open.
    // Falling back to the recruitee.com form keeps the id stable when it is
    // absent.
    const url =
      (typeof offer.careers_url === 'string' && offer.careers_url) ||
      (typeof offer.slug === 'string' && offer.slug ? `https://${token}.recruitee.com/o/${offer.slug}` : '')
    if (!url) continue
    results.push({
      title: typeof offer.title === 'string' ? offer.title : '',
      url,
      externalId: url,
      location: formatLocation(offer),
      // The posting body is split in two on Recruitee: the pitch lives in
      // `description` and the "what we expect from you" list in
      // `requirements`. Both are what a candidate reads, so both are kept.
      description: htmlSectionsToPlainText([offer.description, offer.requirements]),
      postedAt: toIso(offer.published_at) ?? toIso(offer.created_at),
      salary: formatSalary(offer),
    })
  }
  return results
}

export const recruitee: AtsProvider = {
  id: 'recruitee',
  detect,
  fetch: fetchJobs,
}
