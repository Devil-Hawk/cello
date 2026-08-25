// Lever adapter — public postings API, no auth required.
// GET https://api.lever.co/v0/postings/{slug}?mode=json (top-level array)
// EU boards live on api.eu.lever.co; we fall back there on 404.

import type { AtsJob, AtsProvider, DetectInput } from './types'
import { isValidToken } from './types'
import { HttpError, assertAllowedHost, fetchJson } from './http'

const API_HOSTS = new Set(['api.lever.co', 'api.eu.lever.co'])

const BOARD_URL_RE = /^jobs\.(?:eu\.)?lever\.co$/

const MAX_DESCRIPTION_CHARS = 20_000

interface LeverPosting {
  text?: string
  hostedUrl?: string
  descriptionPlain?: string
  createdAt?: number
  country?: string
  workplaceType?: string
  categories?: {
    location?: string
    allLocations?: string[]
    commitment?: string
    team?: string
  }
  salaryRange?: {
    min?: number
    max?: number
    currency?: string
    interval?: string
  }
}

function toIsoFromEpochMs(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return new Date(value).toISOString()
}

function formatLocation(j: LeverPosting): string | undefined {
  const parts: string[] = []
  const all = j.categories?.allLocations
  if (Array.isArray(all)) {
    for (const loc of all) {
      if (typeof loc === 'string' && loc.trim()) parts.push(loc.trim())
    }
  }
  const primary = j.categories?.location
  if (parts.length === 0 && typeof primary === 'string' && primary.trim()) {
    parts.push(primary.trim())
  }
  const unique = [...new Set(parts)]
  return unique.length > 0 ? unique.join(' · ') : undefined
}

function formatSalary(j: LeverPosting): string | undefined {
  const range = j.salaryRange
  if (!range || typeof range !== 'object') return undefined
  const min = typeof range.min === 'number' && Number.isFinite(range.min) ? range.min : null
  const max = typeof range.max === 'number' && Number.isFinite(range.max) ? range.max : null
  if (min == null && max == null) return undefined
  const currency = typeof range.currency === 'string' && range.currency ? range.currency.toUpperCase() : ''
  const interval = typeof range.interval === 'string' && range.interval ? ` per ${range.interval.replace(/-/g, ' ')}` : ''
  const fmt = (n: number) => n.toLocaleString('en-US')
  const span = min != null && max != null && min !== max ? `${fmt(min)}–${fmt(max)}` : fmt((min ?? max) as number)
  return `${currency ? `${currency} ` : ''}${span}${interval}`.trim()
}

function detect(input: DetectInput): { token: string } | null {
  if (!input.careerUrl) return null
  let url: URL
  try {
    url = new URL(input.careerUrl)
  } catch {
    return null
  }
  if (!BOARD_URL_RE.test(url.hostname)) return null
  const token = url.pathname.split('/').filter(Boolean)[0]
  return isValidToken(token) ? { token } : null
}

async function fetchBoard(host: string, token: string): Promise<AtsJob[]> {
  const apiUrl = `https://${host}/v0/postings/${token}?mode=json`
  assertAllowedHost(apiUrl, API_HOSTS)
  const json = await fetchJson<LeverPosting[]>(apiUrl)
  if (!Array.isArray(json)) return []
  const results: AtsJob[] = []
  for (const j of json) {
    if (!j || typeof j.hostedUrl !== 'string' || !j.hostedUrl) continue
    results.push({
      title: typeof j.text === 'string' ? j.text : '',
      url: j.hostedUrl,
      externalId: j.hostedUrl,
      location: formatLocation(j),
      description:
        typeof j.descriptionPlain === 'string' && j.descriptionPlain
          ? j.descriptionPlain.slice(0, MAX_DESCRIPTION_CHARS)
          : undefined,
      postedAt: toIsoFromEpochMs(j.createdAt),
      salary: formatSalary(j),
    })
  }
  return results
}

async function fetchJobs(token: string): Promise<AtsJob[]> {
  if (!isValidToken(token)) throw new Error(`lever: invalid board slug`)
  try {
    return await fetchBoard('api.lever.co', token)
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return await fetchBoard('api.eu.lever.co', token)
    }
    throw error
  }
}

export const lever: AtsProvider = {
  id: 'lever',
  detect,
  fetch: fetchJobs,
}
