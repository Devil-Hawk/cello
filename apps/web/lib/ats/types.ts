// ATS provider contract shared by the Next.js refresh route and the
// scheduled CI script. This module (and everything under lib/ats/) is
// framework-free: no next/* imports, no path aliases, no Node-only APIs
// beyond global fetch/URL. The one exception is careers-page.ts, which reads a
// company's own site and so uses node:dns for its SSRF check; no client
// component imports lib/ats.

export type AtsProviderId =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'workday'
  | 'smartrecruiters'
  | 'workable'
  | 'recruitee'
  | 'personio'
  | 'eightfold'

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
  /** The capped plain text of the posting: what search and the parsers read. */
  description?: string
  /**
   * The employer's own HTML for the posting, whole and uncleaned (the provider's content field, a JSON-LD
   * description, a detail page's main block). syncJobs cleans it and keeps it as Markdown (lib/ingest/markdown.ts).
   * Absent when the source listed only a snippet.
   */
  descriptionHtml?: string
  /** Where descriptionHtml came from. Defaults to the applicant system's API for a board, else the tier that read it. */
  descriptionSource?: 'api' | 'jsonld' | 'detail' | 'rendered' | 'listing'
  /** The employer's apply link, when it is not the posting's own address. */
  applyUrl?: string
  /** ISO 8601 timestamp when the posting was published, if known. */
  postedAt?: string
  /** Human-readable salary string (annualized when the source uses intervals). */
  salary?: string
  /** The employer the posting names, when the source says (a JobPosting's hiringOrganization, a search result's company_name). */
  employer?: string
  /** ISO 8601: the posting is not open after this. */
  validThrough?: string
  /** The employer's own requisition id, one per role across every way of reading it. */
  requisitionId?: string
  /** The page describes an event (a career fair, a webinar), not a role. */
  isEvent?: boolean
  /**
   * Hosts the posting body links to (the plain-text description drops hrefs).
   * Used only as board-ownership evidence (./verify.ts); never stored.
   */
  linkHosts?: string[]
}

export interface DetectInput {
  careerUrl: string | null
  domain: string | null
}

export interface FetchContext {
  /** Injectable sleep for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>
  /**
   * True when a job with this externalId is already stored WITH a description.
   * A provider whose list call carries no body (Workday, SmartRecruiters) uses
   * it to spend its per-run detail budget on the postings that still lack one,
   * instead of re-reading the same newest few every refresh and leaving the
   * rest of a large board empty forever.
   */
  hasDescription?: (externalId: string) => boolean
  /**
   * What the person is looking for, as search words ("data engineer"). A board
   * with a search of its own asks for these instead of listing everything; one
   * without ignores them.
   */
  query?: string[]
}

export interface AtsProvider {
  id: AtsProviderId
  /** Pure URL-based detection — never performs network I/O, never throws. */
  detect(input: DetectInput): { token: string } | null
  /** Fetch all open roles for a board token. Throws on transport failure. */
  fetch(token: string, ctx?: FetchContext): Promise<AtsJob[]>
  /**
   * Set by a provider that returns at most this many postings however many are
   * open. A list that reaches the cap is a window, not the whole board, so a
   * posting missing from it has not necessarily closed.
   */
  maxJobs?: number
  /** True for a board that lists only what matches FetchContext.query: a role missing from the list is not thereby closed. */
  searchesByQuery?: boolean
}

/** Shape persisted at companies.metadata.ats (column is additive/optional). */
export interface AtsMetadata {
  provider: AtsProviderId
  token: string
  source: 'url' | 'probe' | 'manual' | 'known'
  discovered_at: string
  /** How a guessed board was tied to the company (see ./verify.ts). Absent on boards stored before verification existed. */
  verified_by?: 'careers_url' | 'manual' | 'known_board' | 'careers_page_link' | 'board_links_home' | 'provider_name'
  verified_at?: string
}

/** Board tokens/slugs must match this before being interpolated into URLs. */
export const TOKEN_RE = /^[A-Za-z0-9._-]+$/

export function isValidToken(token: unknown): token is string {
  return typeof token === 'string' && token.length > 0 && token.length <= 128 && TOKEN_RE.test(token)
}
