// ATS board discovery.
//
// 1. URL parsing: if the company's careers URL is hosted on a known ATS
//    (job-boards(.eu)?.greenhouse.io/{board}, boards.greenhouse.io/{board},
//    jobs.(eu.)?lever.co/{slug}, jobs.ashbyhq.com/{org}) the token is read
//    straight off the URL with no network I/O.
// 2. Probe fallback: for branded careers pages we derive candidate slugs from
//    the company domain and name (validated ^[A-Za-z0-9._-]+$) and probe
//    greenhouse -> lever -> ashby in order; the first board returning >= 1 job
//    wins. Never throws on a miss — returns null.
//
// Persistence of the discovered board to companies.metadata.ats is done by the
// caller (refreshCompany in ./index.ts) through its store, wrapped so the code
// keeps working when the metadata column does not exist yet.

import type { AtsJob, AtsProviderId } from './types'
import { isValidToken } from './types'
import { greenhouse } from './greenhouse'
import { lever } from './lever'
import { ashby } from './ashby'

const PROBE_ORDER = [greenhouse, lever, ashby] as const

const MAX_PROBE_CANDIDATES = 4

export interface DetectAtsInput {
  careerUrl: string | null
  domain: string | null
  name: string | null
}

export interface DetectedAts {
  provider: AtsProviderId
  token: string
  source: 'url' | 'probe'
  /** When the probe already fetched the board, its jobs are reused here. */
  jobs?: AtsJob[]
}

/** Pure URL-based detection across all providers. No network I/O. */
export function detectFromUrl(input: { careerUrl: string | null; domain: string | null }): {
  provider: AtsProviderId
  token: string
} | null {
  for (const provider of PROBE_ORDER) {
    const hit = provider.detect(input)
    if (hit) return { provider: provider.id, token: hit.token }
  }
  return null
}

/** Derive candidate board slugs from a company domain and display name. */
export function candidateTokens(domain: string | null, name: string | null): string[] {
  const candidates: string[] = []

  if (typeof domain === 'string' && domain.trim()) {
    let host = domain.trim().toLowerCase()
    // Tolerate full URLs stored in the domain column.
    try {
      if (host.includes('://')) host = new URL(host).hostname
    } catch {
      /* keep raw value */
    }
    host = host.replace(/^www\./, '')
    const firstLabel = host.split('.')[0]
    if (firstLabel) candidates.push(firstLabel)
  }

  if (typeof name === 'string' && name.trim()) {
    const lower = name.trim().toLowerCase()
    // "Open AI" -> "openai"
    candidates.push(lower.replace(/[^a-z0-9]+/g, ''))
    // "Acme Corp" -> "acme-corp"
    candidates.push(lower.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
  }

  const unique: string[] = []
  for (const c of candidates) {
    if (isValidToken(c) && !unique.includes(c)) unique.push(c)
    if (unique.length >= MAX_PROBE_CANDIDATES) break
  }
  return unique
}

/**
 * Probe public ATS APIs for a board matching the company's domain/name.
 * Returns the first board with at least one open job, or null. Never throws.
 */
export async function probeAts(input: { domain: string | null; name: string | null }): Promise<DetectedAts | null> {
  const tokens = candidateTokens(input.domain, input.name)
  if (tokens.length === 0) return null

  for (const provider of PROBE_ORDER) {
    for (const token of tokens) {
      try {
        const jobs = await provider.fetch(token)
        if (jobs.length >= 1) {
          return { provider: provider.id, token, source: 'probe', jobs }
        }
      } catch {
        // Miss (404, timeout, …) — keep probing.
      }
    }
  }
  return null
}

/**
 * Full detection: URL parsing first (free), then the probe fallback.
 * Never throws; returns null when no board could be found.
 */
export async function detectAts(input: DetectAtsInput): Promise<DetectedAts | null> {
  const fromUrl = detectFromUrl(input)
  if (fromUrl) return { ...fromUrl, source: 'url' }
  return await probeAts(input)
}
