// ATS provider contract shared by the Next.js refresh route and the
// scheduled CI script. This module (and everything under lib/ats/) is
// framework-free: no next/* imports, no path aliases, no Node-only APIs
// beyond global fetch/URL.

export type AtsProviderId =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'workday'
  | 'smartrecruiters'
  | 'workable'
  | 'recruitee'
  | 'personio'

/** A single job posting normalized across providers. */
export interface AtsJob {
  title: string
  /** Canonical absolute URL of the posting. */
  url: string
  /**
   * Stable identifier used for dedup. By convention this equals the
   * canonical job URL so rows upsert-merge with those written by
   * /api/scraper/trigger and the Python scraper (unique company_id,external_id).
   */
  externalId: string
  location?: string
  description?: string
  /** ISO 8601 timestamp when the posting was published, if known. */
  postedAt?: string
  /** Human-readable salary string (annualized when the source uses intervals). */
  salary?: string
}

export interface DetectInput {
  careerUrl: string | null
  domain: string | null
}

export interface FetchContext {
  /** Injectable sleep for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>
}

export interface AtsProvider {
  id: AtsProviderId
  /** Pure URL-based detection — never performs network I/O, never throws. */
  detect(input: DetectInput): { token: string } | null
  /** Fetch all open roles for a board token. Throws on transport failure. */
  fetch(token: string, ctx?: FetchContext): Promise<AtsJob[]>
}

/** Shape persisted at companies.metadata.ats (column is additive/optional). */
export interface AtsMetadata {
  provider: AtsProviderId
  token: string
  source: 'url' | 'probe' | 'manual'
  discovered_at: string
}

/** Board tokens/slugs must match this before being interpolated into URLs. */
export const TOKEN_RE = /^[A-Za-z0-9._-]+$/

export function isValidToken(token: unknown): token is string {
  return typeof token === 'string' && token.length > 0 && token.length <= 128 && TOKEN_RE.test(token)
}
