// ATS board discovery.
//
// 1. URL parsing: if the company's careers URL is hosted on a known ATS the
//    token is read straight off the URL with no network I/O. Every provider in
//    URL_DETECT_ORDER participates.
// 2. Probe fallback: for branded careers pages we derive candidate slugs from
//    the company domain and name (validated ^[A-Za-z0-9._-]+$) and probe the
//    providers in PROBE_ORDER. A board that answers is only a GUESS: it is
//    accepted when ./verify.ts finds evidence it belongs to this company (its
//    careers page links to it, its postings point at the company's domain, or
//    the provider names the same employer) and its newest posting is under a
//    year old. Otherwise the answer is null: no readable source, never a guess.
//    Never throws on a miss.
//
// Persistence of the discovered board to companies.metadata.ats is done by the
// caller (refreshCompany in ./index.ts) through its store, wrapped so the code
// keeps working when the metadata column does not exist yet.

import type { AtsJob, AtsProvider, AtsProviderId } from './types'
import { isValidToken } from './types'
import { greenhouse } from './greenhouse'
import { lever } from './lever'
import { ashby } from './ashby'
import { workday } from './workday'
import { smartrecruiters } from './smartrecruiters'
import { workable } from './workable'
import { recruitee } from './recruitee'
import { personio } from './personio'
import { eightfold } from './eightfold'
import { fetchCareersHtml, findBoardLinks } from './careers-page'
import { isRecentBoard, verifyBoard, type BoardRef, type VerifiedBy } from './verify'
import { isKnownEmployer, knownBoard } from '../companies/known-companies'

/**
 * Every provider, for URL-based detection. Free (no network I/O), so order
 * here is irrelevant — the host patterns are mutually exclusive.
 */
const URL_DETECT_ORDER: readonly AtsProvider[] = [
  greenhouse,
  lever,
  ashby,
  workday,
  smartrecruiters,
  workable,
  recruitee,
  personio,
  eightfold,
]

/**
 * Order for the NETWORK probe, where order is the whole cost model: a company
 * on the last provider pays a miss against every provider before it, times up
 * to MAX_PROBE_CANDIDATES slugs.
 *
 * Ordered by measured hit rate on this user's watchlist first, then by
 * measured miss latency. Every miss below is a single request that
 * classifyError() treats as permanent, so none of them retry:
 *
 *   greenhouse       62/133 known boards   404 in 0.11s
 *   ashby            49/133                404 in 0.12s
 *   lever            22/133                404 in 0.99s
 *   workable         unmeasured            404 in 0.12s
 *   recruitee        unmeasured            404 in 0.29s
 *   smartrecruiters  unmeasured            200 + totalFound:0 in 0.47s
 *   personio         unmeasured            307 in 0.65s (see fetchText's
 *                                          redirect:'manual' — without it this
 *                                          miss would cost four requests)
 *
 * ashby moves ahead of lever on that evidence: it is more than twice as likely
 * to hit and its miss is ~8x cheaper, so a Lever company now pays one extra
 * 0.12s miss while every Ashby company saves a 0.99s one.
 *
 * The five new providers go after the three measured ones because their hit
 * rate here is unknown, and among themselves in ascending miss cost. Personio
 * is last on both counts: slowest miss, and the narrowest slug space (European
 * SMB boards) of the set.
 *
 * workday is absent on purpose — its token needs a data centre and a site id
 * that cannot be derived from a company name. See ./workday.ts.
 */
const PROBE_ORDER: readonly AtsProvider[] = [
  greenhouse,
  ashby,
  lever,
  workable,
  recruitee,
  smartrecruiters,
  personio,
]

const MAX_PROBE_CANDIDATES = 4

export interface DetectAtsInput {
  careerUrl: string | null
  domain: string | null
  name: string | null
}

export interface DetectedAts {
  provider: AtsProviderId
  token: string
  source: 'url' | 'probe' | 'known'
  /** Why this board is the company's (see ./verify.ts). */
  verifiedBy: VerifiedBy
  /** When the probe already fetched the board, its jobs are reused here. */
  jobs?: AtsJob[]
}

/** Pure URL-based detection across all providers. No network I/O. */
export function detectFromUrl(input: { careerUrl: string | null; domain: string | null }): {
  provider: AtsProviderId
  token: string
} | null {
  for (const provider of URL_DETECT_ORDER) {
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

function hostOnly(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

/**
 * The boards the company's own careers page and homepage link to or embed.
 * Two plain GETs at most; empty when a page cannot be read.
 */
export async function findPageBoards(input: {
  careerUrl: string | null
  domain: string | null
}): Promise<BoardRef[]> {
  const urls = new Set<string>()
  if (input.careerUrl) urls.add(input.careerUrl)
  const home = hostOnly(input.domain)
  if (home) urls.add(`https://${home}/`)
  const boards = new Map<string, BoardRef>()
  for (const url of urls) {
    const html = await fetchCareersHtml(url, input.domain)
    if (!html) continue
    for (const b of findBoardLinks(html, (u) => detectFromUrl({ careerUrl: u, domain: null }))) {
      boards.set(`${b.provider}:${b.token.toLowerCase()}`, b)
    }
  }
  return [...boards.values()]
}

/**
 * Find a board that is verifiably this company's. Boards its own site links to
 * come first, then guessed slugs across PROBE_ORDER, each accepted only with
 * evidence (see ./verify.ts) and only while alive. Returns null when nothing
 * verifies. Never throws.
 */
export async function probeAts(input: {
  domain: string | null
  name: string | null
  careerUrl?: string | null
  pageBoards?: readonly BoardRef[]
}): Promise<DetectedAts | null> {
  const company = { name: input.name, domain: input.domain }
  const pageBoards = input.pageBoards ?? []
  const known = isKnownEmployer(input)
  const tried = new Set<string>()

  const attempt = async (provider: AtsProvider, token: string): Promise<DetectedAts | null> => {
    const key = `${provider.id}:${token.toLowerCase()}`
    if (tried.has(key)) return null
    tried.add(key)
    try {
      const jobs = await provider.fetch(token)
      if (jobs.length < 1) return null
      const verifiedBy = await verifyBoard({ provider: provider.id, token, jobs, company, pageBoards, knownEmployer: known })
      return verifiedBy ? { provider: provider.id, token, source: 'probe', verifiedBy, jobs } : null
    } catch {
      return null // Miss (404, timeout, ...) — keep going.
    }
  }

  for (const board of pageBoards) {
    const provider = URL_DETECT_ORDER.find((p) => p.id === board.provider)
    const hit = provider ? await attempt(provider, board.token) : null
    if (hit) return hit
  }

  // A known employer is never slug-guessed: its curated board or a link from
  // its own site, nothing else.
  if (known) return null
  const tokens = candidateTokens(input.domain, input.name)
  for (const provider of PROBE_ORDER) {
    for (const token of tokens) {
      const hit = await attempt(provider, token)
      if (hit) return hit
    }
  }
  return null
}

/**
 * Full detection: URL parsing first (free), then a known employer's curated
 * board, then the company's own careers page, then verified probing. Never throws; returns null when no board could
 * be tied to the company.
 */
export async function detectAts(input: DetectAtsInput): Promise<DetectedAts | null> {
  const fromUrl = detectFromUrl(input)
  if (fromUrl) return { ...fromUrl, source: 'url', verifiedBy: 'careers_url' }
  const curated = knownBoard(input)
  if (curated) {
    const provider = URL_DETECT_ORDER.find((p) => p.id === curated.provider)
    try {
      const jobs = provider ? await provider.fetch(curated.token) : []
      // Hand-checked, so only liveness is asked of it.
      if (jobs.length > 0 && isRecentBoard(jobs)) {
        return { ...curated, source: 'known', verifiedBy: 'known_board', jobs }
      }
    } catch {
      /* fall through to the company's own page */
    }
  }
  let pageBoards: BoardRef[] = []
  try {
    pageBoards = await findPageBoards(input)
  } catch {
    /* no page evidence */
  }
  return await probeAts({ ...input, pageBoards })
}
