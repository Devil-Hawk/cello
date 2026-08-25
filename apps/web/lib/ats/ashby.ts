// Ashby adapter — public posting API, no auth required.
// GET https://api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true
//
// Ashby's public posting API carries a high server-side latency floor
// (roughly independent of board size) and rate-limits repeated
// unauthenticated hits, so this adapter uses a 30s timeout plus up to
// 2 retries with backoff 1000*2^(n-1) + rand(0..500)ms.

import type { AtsJob, AtsProvider, DetectInput, FetchContext } from './types'
import { isValidToken } from './types'
import { assertAllowedHost, fetchJson } from './http'

const API_HOSTS = new Set(['api.ashbyhq.com'])
const BOARD_HOST = 'jobs.ashbyhq.com'

const ASHBY_TIMEOUT_MS = 30_000
const ASHBY_RETRIES = 2

const MAX_DESCRIPTION_CHARS = 20_000

// Annualization multipliers for compensation intervals.
const INTERVAL_MULTIPLIERS: Record<string, number> = {
  '1 HOUR': 2080,
  '1 DAY': 260,
  '1 WEEK': 52,
  '2 WEEK': 26,
  '0.5 MONTH': 24,
  '1 MONTH': 12,
  '2 MONTH': 6,
  '3 MONTH': 4,
  '6 MONTH': 2,
  '1 YEAR': 1,
}

interface AshbyCompensationComponent {
  compensationType?: string
  interval?: string
  currencyCode?: string
  minValue?: number | string | null
  maxValue?: number | string | null
}

interface AshbyCompensation {
  // Some payloads carry the range at the top level…
  interval?: string
  currency?: string
  minValue?: number | string | null
  maxValue?: number | string | null
  // …others nest it under summaryComponents / tiers with summary strings.
  summaryComponents?: AshbyCompensationComponent[]
  compensationTierSummary?: string
  scrapeableCompensationSalarySummary?: string
}

interface AshbySecondaryLocation {
  location?: string
  address?: { postalAddress?: { addressLocality?: string; addressCountry?: string } }
}

interface AshbyJob {
  title?: string
  jobUrl?: string
  location?: string
  secondaryLocations?: AshbySecondaryLocation[]
  publishedAt?: string
  isListed?: boolean
  descriptionPlain?: string
  compensation?: AshbyCompensation
}

interface AshbyResponse {
  jobs?: AshbyJob[]
}

function toIso(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString()
}

function toNonNegativeNumber(value: unknown): number | null {
  if (value == null) return null
  if (typeof value === 'string' && value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function annualize(
  minValue: unknown,
  maxValue: unknown,
  interval: unknown,
  currency: unknown
): string | null {
  const multiplier = INTERVAL_MULTIPLIERS[typeof interval === 'string' ? interval : '1 YEAR']
  if (!multiplier) return null
  const min = toNonNegativeNumber(minValue)
  const max = toNonNegativeNumber(maxValue)
  if (min == null && max == null) return null
  const lo = (min ?? max) as number
  const hi = (max ?? min) as number
  const annualLo = Math.round(Math.min(lo, hi) * multiplier)
  const annualHi = Math.round(Math.max(lo, hi) * multiplier)
  const code = typeof currency === 'string' && currency.trim() ? `${currency.trim().toUpperCase()} ` : ''
  const fmt = (n: number) => n.toLocaleString('en-US')
  const span = annualLo === annualHi ? fmt(annualLo) : `${fmt(annualLo)}–${fmt(annualHi)}`
  return `${code}${span} / yr`
}

/** Build a salary string from Ashby compensation data, annualized. */
function formatSalary(comp: AshbyCompensation | undefined): string | undefined {
  if (!comp || typeof comp !== 'object') return undefined

  // 1) Top-level range (flattened payloads).
  const topLevel = annualize(comp.minValue, comp.maxValue, comp.interval, comp.currency)
  if (topLevel) return topLevel

  // 2) Salary component inside summaryComponents.
  if (Array.isArray(comp.summaryComponents)) {
    for (const c of comp.summaryComponents) {
      if (!c || typeof c !== 'object') continue
      if (typeof c.compensationType === 'string' && c.compensationType.toLowerCase() !== 'salary') continue
      const fromComponent = annualize(c.minValue, c.maxValue, c.interval, c.currencyCode)
      if (fromComponent) return fromComponent
    }
  }

  // 3) Fall back to Ashby's own pre-rendered summary strings.
  if (typeof comp.scrapeableCompensationSalarySummary === 'string' && comp.scrapeableCompensationSalarySummary.trim()) {
    return comp.scrapeableCompensationSalarySummary.trim()
  }
  if (typeof comp.compensationTierSummary === 'string' && comp.compensationTierSummary.trim()) {
    return comp.compensationTierSummary.trim()
  }
  return undefined
}

// Fold secondaryLocations (extra hiring regions) into the location string so
// e.g. an EU-eligible role whose primary label is "Canada" still surfaces
// "Berlin", "Germany". Deduped, joined with " · ".
function formatLocation(j: AshbyJob): string | undefined {
  const parts: string[] = []
  if (typeof j.location === 'string' && j.location.trim()) parts.push(j.location.trim())
  if (Array.isArray(j.secondaryLocations)) {
    for (const s of j.secondaryLocations) {
      if (!s || typeof s !== 'object') continue
      if (typeof s.location === 'string' && s.location.trim()) parts.push(s.location.trim())
      const pa = s.address?.postalAddress
      if (pa) {
        for (const key of ['addressLocality', 'addressCountry'] as const) {
          const value = pa[key]
          if (typeof value === 'string' && value.trim()) parts.push(value.trim())
        }
      }
    }
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
  if (url.hostname !== BOARD_HOST) return null
  const token = url.pathname.split('/').filter(Boolean)[0]
  return isValidToken(token) ? { token } : null
}

async function fetchJobs(token: string, ctx?: FetchContext): Promise<AtsJob[]> {
  if (!isValidToken(token)) throw new Error(`ashby: invalid org token`)
  const apiUrl = `https://api.ashbyhq.com/posting-api/job-board/${token}?includeCompensation=true`
  assertAllowedHost(apiUrl, API_HOSTS)
  const json = await fetchJson<AshbyResponse>(apiUrl, {
    timeoutMs: ASHBY_TIMEOUT_MS,
    retries: ASHBY_RETRIES,
    backoffBaseMs: 1000,
    sleep: ctx?.sleep,
  })
  const jobs = Array.isArray(json?.jobs) ? json.jobs : []
  const results: AtsJob[] = []
  for (const j of jobs) {
    if (!j || typeof j.jobUrl !== 'string' || !j.jobUrl) continue
    if (j.isListed === false) continue
    results.push({
      title: typeof j.title === 'string' ? j.title : '',
      url: j.jobUrl,
      externalId: j.jobUrl,
      location: formatLocation(j),
      description:
        typeof j.descriptionPlain === 'string' && j.descriptionPlain
          ? j.descriptionPlain.slice(0, MAX_DESCRIPTION_CHARS)
          : undefined,
      postedAt: toIso(j.publishedAt),
      salary: formatSalary(j.compensation),
    })
  }
  return results
}

export const ashby: AtsProvider = {
  id: 'ashby',
  detect,
  fetch: fetchJobs,
}
