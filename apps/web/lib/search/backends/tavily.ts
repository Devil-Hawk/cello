// Tavily backend — the new free-default upgrade over the keyless DuckDuckGo
// scrape (see docs/PRODUCT-VISION.md, "Sourcing"): 1,000 search credits per
// month, RECURRING, no credit card required — the best keyless-friction-free
// option a production/self-hosted Cello can actually rely on, unlike
// DuckDuckGo's HTML scrape which is bot-challenged from a datacenter egress
// IP on the very first request (see backends/duckduckgo.ts). Off unless the
// caller passes a key (BYOK, same profiles.preferences.api_keys.tavily slot
// every other opt-in provider key lives in — see lib/search/keys.ts's
// getTavilyKey) — this module never reads the DB itself and never throws at
// import time for a missing key.
//
// Request/response shape verified LIVE against Tavily's API reference
// (https://docs.tavily.com/documentation/api-reference/endpoint/search,
// cross-checked against docs.tavily.com/welcome and the llms.txt index)
// while building this:
//   - POST https://api.tavily.com/search
//   - auth: `Authorization: Bearer <key>` HEADER — confirmed explicitly:
//     "the JSON request body does NOT include an api_key field; authentication
//     occurs exclusively through the Authorization header using the bearer
//     token scheme." (Older examples floating around the web show the key in
//     the body — that is not what the live docs say today.)
//   - body: { query, max_results (0-20, default 5), search_depth
//     ('basic'|'advanced'), topic ('general'|'news'), time_range
//     ('day'|'week'|'month'|'year'), ... }
//   - success 200: { results: [{ title, url, content, score, ... }],
//     response_time, request_id, ... }
//   - 401 = missing/invalid key -> permanent, never retry
//   - 429 = "excessive requests" rate limit -> transient, worth a retry
//   - 432 = plan usage limit exceeded, 433 = pay-as-you-go limit exceeded ->
//     both quota-exhaustion, permanent (retrying spends nothing since the
//     account is capped, but it will never succeed until the cap resets, so
//     it must not be retried in-request either)
//   - the free tier itself (1,000 credits/month, recurring, no card) was
//     confirmed today via docs.tavily.com/welcome: "A free API key offering
//     1,000 credits/month, no credit card required".

import { retryFetch } from '../fetch'
import type { SearchResult } from '../types'

const ENDPOINT = 'https://api.tavily.com/search'
const DEFAULT_LIMIT = 10
/** Tavily's own hard cap on `max_results` (its docs: "Range: 0–20") — tighter
 *  than the 25-result convention Exa/DuckDuckGo use, so clamp to Tavily's
 *  real ceiling rather than over-requesting and letting Tavily silently clamp
 *  it itself. */
const TAVILY_MAX_RESULTS = 20

interface TavilyResultRow {
  title?: string | null
  url?: string
  content?: string | null
  /** Only populated for some queries/topics; not documented as always
   *  present, so always treated as optional. */
  published_date?: string | null
}

interface TavilySearchResponseBody {
  results?: TavilyResultRow[]
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

export interface TavilySearchOptions {
  limit?: number
  /** Maps 1:1 onto Tavily's `time_range` — Tavily accepts exactly these four
   *  tokens, same as WebSearchOptions['freshness']. */
  freshness?: 'day' | 'week' | 'month' | 'year'
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * Run one Tavily search. Throws on any request/parse failure —
 * lib/search/index.ts wraps this and turns it into the tool's structured
 * {ok:false, reason} response, same contract as searchExa/searchDuckDuckGo.
 */
export async function searchTavily(
  query: string,
  apiKey: string,
  opts: TavilySearchOptions = {}
): Promise<SearchResult[]> {
  const limit = Math.min(TAVILY_MAX_RESULTS, Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)))

  const res = await retryFetch(ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      query,
      max_results: limit,
      search_depth: 'basic',
      topic: 'general',
      ...(opts.freshness ? { time_range: opts.freshness } : {}),
    }),
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    retries: 2,
  })

  const data = (await res.json()) as TavilySearchResponseBody
  const rows = Array.isArray(data.results) ? data.results : []

  const out: SearchResult[] = []
  for (const row of rows) {
    if (typeof row.url !== 'string' || !row.url) continue
    const hostname = hostnameOf(row.url)
    if (!hostname) continue
    out.push({
      title: (row.title ?? '').trim() || row.url,
      url: row.url,
      snippet: (row.content ?? '').trim(),
      publishedAt: row.published_date ?? undefined,
      source: hostname,
    })
  }
  return out
}
