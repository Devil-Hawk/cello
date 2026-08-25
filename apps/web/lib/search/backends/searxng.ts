// SearXNG backend — the zero-cost-forever option for self-hosters: point
// Cello at ANY SearXNG instance (self-hosted, or a public one that has opted
// in to the JSON output format) and get results with no API key, no
// per-search cost, no vendor at all. Off unless a base URL is configured
// (BYO-instance, same profiles.preferences.api_keys.searxng slot other
// opt-in provider config lives in, OR the deployment-wide SEARXNG_BASE_URL
// env var for a single-tenant self-host — see lib/search/keys.ts's
// getSearxngBaseUrl) — this module itself takes an ALREADY-RESOLVED base URL
// and never reads the DB or process.env itself, so it never throws at import
// time for missing config, same discipline searchExa(query, apiKey, opts)
// already established for a resolved secret.
//
// Request/response shape: docs.searxng.org/dev/search_api.html summarizes
// this incompletely (its own copy of the accepted `time_range` values is
// missing 'week') — cross-checked directly against SearXNG's own source
// (github.com/searxng/searxng, current `master` at build time) instead:
//   - GET {baseUrl}/search?q=...&format=json&time_range=...  (searx/webapp.py
//     index(): GET/POST both accepted; using GET here keeps this a plain
//     retryFetch() with no body, same shape as a normal search route)
//   - NO api key / auth concept in SearXNG itself (searx/webapp.py has no
//     auth check on /search) — an instance an operator has put behind their
//     own reverse-proxy auth is out of scope for this backend
//   - success 200: searx/webutils.py's get_json_response() returns
//     { query, results: [{ title, url, content, engine, publishedDate, ... }
//     (searx/result_types/_base.py's MainResult struct)], answers,
//     corrections, infoboxes, suggestions, unresponsive_engines }
//   - `format=json` requests get a BARE 403 (Flask's `flask.abort(403)`, no
//     JSON error body — searx/webapp.py: `if output_format not in
//     settings['search']['formats']: flask.abort(403)`) when the instance's
//     settings.yml doesn't list `json` under `search.formats`. This is a
//     permanent, config-level failure — the same instance 403s on every call
//     until its operator opts in, so it must never be retried.
//   - `time_range` accepts exactly 'day' | 'week' | 'month' | 'year' per
//     searx/search/models.py's `typing.Literal["day", "week", "month",
//     "year"]` — a 1:1 match for WebSearchOptions['freshness'].
//   - a genuine server-side search failure surfaces as a plain 500
//     (searx/webapp.py's `except Exception` branch) — transient, worth a
//     retry, same as any other backend's 5xx.

import { retryFetch } from '../fetch'
import type { SearchResult } from '../types'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 25

interface SearxngResultRow {
  title?: string
  url?: string
  content?: string
  publishedDate?: string | null
}

interface SearxngSearchResponseBody {
  results?: SearxngResultRow[]
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** Strip trailing slash(es) so `${baseUrl}/search` never double-slashes,
 *  regardless of whether the configured value already ends in one. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

export interface SearxngSearchOptions {
  limit?: number
  freshness?: 'day' | 'week' | 'month' | 'year'
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * Run one SearXNG search against `baseUrl` (the caller's own instance — see
 * lib/search/keys.ts's getSearxngBaseUrl for how that's resolved: per-user
 * override first, deployment-wide SEARXNG_BASE_URL env var otherwise).
 * Throws on any request/parse failure — lib/search/index.ts wraps this and
 * turns it into the tool's structured {ok:false, reason} response, same
 * contract as searchExa/searchDuckDuckGo/searchTavily/searchSerper.
 */
export async function searchSearxng(
  query: string,
  baseUrl: string,
  opts: SearxngSearchOptions = {}
): Promise<SearchResult[]> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)))

  const params = new URLSearchParams({ q: query, format: 'json' })
  if (opts.freshness) params.set('time_range', opts.freshness)

  const url = `${normalizeBaseUrl(baseUrl)}/search?${params.toString()}`

  const res = await retryFetch(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    retries: 2,
  })

  const data = (await res.json()) as SearxngSearchResponseBody
  const rows = Array.isArray(data.results) ? data.results : []

  const out: SearchResult[] = []
  for (const row of rows) {
    if (out.length >= limit) break
    if (typeof row.url !== 'string' || !row.url) continue
    const hostname = hostnameOf(row.url)
    if (!hostname) continue
    out.push({
      title: (row.title ?? '').trim() || row.url,
      url: row.url,
      snippet: (row.content ?? '').trim(),
      publishedAt: row.publishedDate ?? undefined,
      source: hostname,
    })
  }
  return out
}
