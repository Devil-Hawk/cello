// Shared types for Cello's own web_search TOOL (lib/search/**) — the harness
// owning its own provider-agnostic search, exactly like Claude Code / opencode
// own theirs, instead of leaning on a per-provider capability (see
// docs/PRODUCT-VISION.md, "Sourcing"). Framework-free (no next/* imports) so
// this is safe to use from a route handler AND a future harness/cron
// context, same discipline as lib/ats/types.ts.

/** One normalized search hit, backend-agnostic. */
export interface SearchResult {
  title: string
  url: string
  snippet: string
  /** ISO 8601 timestamp, only when the backend reports one. */
  publishedAt?: string
  /** Hostname the result points at (e.g. "boards.greenhouse.io") — lets a
   *  caller filter/group by site without re-parsing `url` itself. */
  source: string
}

/**
 * Every backend lib/search/index.ts's failover chain can try, in priority
 * order (see index.ts's CHAIN_ORDER): the three optional BYOK aggregators
 * (tavily/serper/exa), a self-hosted searxng instance, and the free, keyless
 * duckduckgo scrape as the final last-resort attempt. 'tavily' | 'serper' |
 * 'searxng' are backend IDS this module knows about even before their
 * lib/search/backends/*.ts implementation lands — see index.ts's
 * loadOptionalBackendFn() for how a not-yet-present module degrades to "skip
 * this candidate" rather than a compile or runtime failure.
 */
export type SearchBackendId = 'duckduckgo' | 'exa' | 'tavily' | 'serper' | 'searxng'

/**
 * Every reason a search can come back short of "ok:true with hits". A caller
 * (a copilot tool, a harness agent) reads this to decide whether to retry
 * with a different query, fall back to another source, or just report
 * honestly instead of silently claiming nothing was found.
 */
export type SearchFailureReason =
  | 'empty_query'
  /** This backend needs configuration (an API key, or for searxng a base
   *  URL) that isn't present — either it was never selected as a candidate,
   *  or `opts.backend` explicitly forced a backend with nothing configured. */
  | 'no_key'
  /** The backend recognized its own bot-verification/anti-automation
   *  challenge instead of serving results (DuckDuckGo's html endpoint does
   *  this; any BYOK backend can signal the same by throwing SearchBlockedError
   *  or naming its error class/message with "blocked"). */
  | 'blocked'
  /** A transient transport failure (429/5xx/timeout/reset) — worth another try shortly. */
  | 'rate_limited'
  /** The backend's own metered quota/credit allotment is exhausted (e.g. a
   *  monthly free-tier cap) — unlike rate_limited, this will NOT self-heal on
   *  a quick retry. Signaled via SearchQuotaExceededError, an HTTP 402, or an
   *  error name/message containing "quota". */
  | 'quota'
  /** Any other request/parse failure (bad key, malformed response, DNS, ...). */
  | 'request_failed'

/** Thrown by a search backend that recognizes it has been bot-blocked —
 *  DuckDuckGoBlockedError (backends/duckduckgo.ts) predates this shared class
 *  and is still recognized on its own by name; a future backend can throw
 *  this directly (or just name its own error class/message "...blocked...")
 *  and lib/search/index.ts's chain will map either to reason:'blocked'. */
export class SearchBlockedError extends Error {
  constructor(message = 'Search backend reported a bot-verification challenge') {
    super(message)
    this.name = 'SearchBlockedError'
  }
}

/** Thrown by a search backend that recognizes its own metered allotment is
 *  exhausted (e.g. Tavily's 1,000 free searches/month). lib/search/index.ts's
 *  chain maps this (or an HTTP 402, or any error named/messaged "...quota...")
 *  to reason:'quota'. */
export class SearchQuotaExceededError extends Error {
  constructor(message = 'Search backend quota exhausted') {
    super(message)
    this.name = 'SearchQuotaExceededError'
  }
}

export interface WebSearchOptions {
  /** Max results to return, backend-clamped (default 10, hard cap 25). */
  limit?: number
  /**
   * Restrict to results published within this recent window, when the
   * backend supports it (DuckDuckGo: the `df` date-filter param; Exa:
   * `startPublishedDate`). Silently ignored by a backend that can't apply it
   * — never an error.
   */
  freshness?: 'day' | 'week' | 'month' | 'year'
  /**
   * Already-resolved BYOK credentials, when the caller has them in hand —
   * e.g. lib/search/job-discovery.ts resolves every configured credential
   * ONCE up front (one combined DB round trip) and forwards the fields
   * directly so its several site-scoped queries don't each re-resolve via
   * `userId` below. Each field here takes precedence over the corresponding
   * DB-resolved value below and skips that one field's DB round trip. None
   * are required; the chain simply treats an absent one as "not configured"
   * for that backend.
   */
  exaKey?: string
  tavilyKey?: string
  serperKey?: string
  /** Base URL of a self-hosted SearXNG instance (e.g. "https://searx.example.com"). */
  searxngUrl?: string
  /**
   * Resolve every not-already-provided BYOK credential above for this user id
   * (profiles.preferences.api_keys.{exa,tavily,serper,searxng_url}, via
   * lib/search/keys.ts's getSearchProviderKeys() + the service-role admin
   * client) in a single DB round trip. This is the normal path for both the
   * HTTP route and harness callers (e.g. lib/search/job-discovery.ts) — pass
   * whichever of `userId` or the direct fields above is convenient, never
   * both are required. Resolution failure (missing env, DB error, no keys
   * configured) degrades every field to `undefined`, never a throw — the
   * chain simply falls back further, down to keyless 'duckduckgo'.
   */
  userId?: string
  /** Force a specific backend and skip the failover chain entirely — mainly
   *  for tests and a Settings "test this backend" diagnostic; normal callers
   *  omit this and let the chain pick. */
  backend?: SearchBackendId
  timeoutMs?: number
  signal?: AbortSignal
}

/** One backend's outcome within a chain run — only populated on
 *  WebSearchResponse when the chain tried more than one candidate this call,
 *  so a caller (copilot, the Settings page) can explain precisely what
 *  happened instead of guessing from a single flat reason. Listed in the
 *  chain's fixed priority order regardless of which one actually ran first. */
export interface SearchAttempt {
  backend: SearchBackendId
  ok: boolean
  reason?: SearchFailureReason | 'no_results'
  detail?: string
}

export interface WebSearchResponse {
  /** The backend that produced `results` (ok:true), or — when every
   *  candidate failed — the last one actually attempted; see `attempts` for
   *  the full, ordered picture in that case. */
  backend: SearchBackendId
  results: SearchResult[]
  /** False only when every candidate backend failed/was blocked — a
   *  successful call with zero hits is still ok:true (see `reason`). */
  ok: boolean
  /** Set on ok:false (why), on ok:true with an empty `results` ('no_results'),
   *  or 'all_failed' when the chain exhausted every candidate. */
  reason?: SearchFailureReason | 'no_results' | 'all_failed'
  /** Human-readable detail for logs/debugging — never shown to the end user
   *  as a bare error. On 'all_failed' this names every backend tried and why
   *  each one failed, plus an actionable next step (see index.ts's
   *  describeAttempts()). */
  detail?: string
  /** Every candidate the chain considered this call, in priority order —
   *  present whenever more than one backend was in play (including a
   *  successful call that only succeeded after an earlier one failed). */
  attempts?: SearchAttempt[]
}
