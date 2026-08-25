// Serper backend — a paid-but-cheap upgrade to REAL Google SERP results:
// 2,500 free queries ONE TIME (not recurring — verified today, do not treat
// it as a monthly allowance), then $0.30-$1.00 per 1,000 depending on plan.
// Off unless the caller passes a key (BYOK, same
// profiles.preferences.api_keys.serper slot every other opt-in provider key
// lives in — see lib/search/keys.ts's getSerperKey) — this module never
// reads the DB itself and never throws at import time for a missing key.
//
// Request/response shape: Serper has no public docs.serper.dev site (it
// publishes docs only inside a signed-in dashboard/playground at
// serper.dev/playground) — LIVE-verified instead against:
//   - serper.dev's own marketing/demo homepage (shows the real
//     `organic: [{ title, link, snippet, position }]` response shape)
//   - the actively-maintained open-source `GoogleSerperAPIWrapper` reference
//     implementation (github.com/OpenBMB/BMTools,
//     bmtools/tools/google_serper/api.py — the same wrapper
//     langchain_community.utilities.GoogleSerperAPIWrapper mirrors), which
//     shows the literal request construction: POST
//     `https://google.serper.dev/{search_type}` with header
//     `X-API-KEY: <key>` + `Content-Type: application/json`
//   - third-party integration docs (CrewAI's SerperDevTool, community
//     threads) confirming the same endpoint/header and a plain JSON `-d`
//     body (`{"q": "..."}`), not query-string params
// All independently agree on:
//   - POST https://google.serper.dev/search
//   - auth: `X-API-KEY: <key>` HEADER (not a query param, not in the body)
//   - JSON body: { q, num, gl, hl, tbs, ... }
//   - success: { organic: [{ title, link, snippet, date?, position }],
//     searchParameters, credits, ... }
//   - a missing/bad key returns 403 Forbidden -> permanent, never retry
//     ("A 401 or 403 means a missing or wrong X-API-KEY" — confirmed against
//     multiple integrators' error-handling docs/issue threads); an
//     exhausted-credits account also surfaces as 403 at the HTTP layer
//     (indistinguishable from a bad key here — both are permanent, so no
//     special-casing is needed beyond "any 4xx we don't retry")
//   - 429 = rate limited -> transient, worth a retry

import { retryFetch } from '../fetch'
import type { SearchResult } from '../types'

const ENDPOINT = 'https://google.serper.dev/search'
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 25

export interface SerperSearchOptions {
  limit?: number
  freshness?: 'day' | 'week' | 'month' | 'year'
  timeoutMs?: number
  signal?: AbortSignal
}

/** Google's `tbs=qdr:X` date-restrict param — the same passthrough field
 *  every Google-SERP-over-REST client (including Serper's own reference
 *  wrapper, which exposes a raw `tbs` kwarg) uses for a recency filter. */
const TBS_QDR: Record<NonNullable<SerperSearchOptions['freshness']>, string> = {
  day: 'qdr:d',
  week: 'qdr:w',
  month: 'qdr:m',
  year: 'qdr:y',
}

interface SerperOrganicRow {
  title?: string
  link?: string
  snippet?: string
  position?: number
}

interface SerperSearchResponseBody {
  organic?: SerperOrganicRow[]
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/**
 * Run one Serper (real Google SERP) search. Throws on any request/parse
 * failure — lib/search/index.ts wraps this and turns it into the tool's
 * structured {ok:false, reason} response, same contract as
 * searchExa/searchDuckDuckGo.
 */
export async function searchSerper(
  query: string,
  apiKey: string,
  opts: SerperSearchOptions = {}
): Promise<SearchResult[]> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)))

  const res = await retryFetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      q: query,
      num: limit,
      ...(opts.freshness ? { tbs: TBS_QDR[opts.freshness] } : {}),
    }),
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    retries: 2,
  })

  const data = (await res.json()) as SerperSearchResponseBody
  const rows = Array.isArray(data.organic) ? data.organic : []

  const out: SearchResult[] = []
  for (const row of rows) {
    if (typeof row.link !== 'string' || !row.link) continue
    const hostname = hostnameOf(row.link)
    if (!hostname) continue
    out.push({
      title: (row.title ?? '').trim() || row.link,
      url: row.link,
      snippet: (row.snippet ?? '').trim(),
      // Serper's optional `date` field (when present) is a human string like
      // "3 days ago" or "Jul 20, 2026", not a reliable ISO 8601 timestamp —
      // SearchResult.publishedAt promises ISO 8601 when set, so it is left
      // unset here rather than passing through a format that isn't
      // guaranteed (the same stance backends/duckduckgo.ts takes: no
      // publishedAt field at all).
      source: hostname,
    })
  }
  return out
}
