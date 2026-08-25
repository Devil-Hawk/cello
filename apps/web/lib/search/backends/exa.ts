// Exa (exa.ai) backend — optional BYOK upgrade over the free DuckDuckGo
// default: better structured results, ~$7/1k searches with a free monthly
// credit allowance (see docs/PRODUCT-VISION.md, "Sourcing"). Off unless the
// caller passes a key (see lib/search/keys.ts for how a route resolves one
// from profiles.preferences.api_keys.exa) — this module never reads the DB
// itself and never throws at import time for a missing key; with no key,
// lib/search/index.ts simply never selects this backend.
//
// Request/response shape verified against Exa's live API reference
// (https://docs.exa.ai/reference/search) while building this.

import { retryFetch } from '../fetch'
import type { SearchResult } from '../types'

const ENDPOINT = 'https://api.exa.ai/search'
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 25
/** Cap on extracted text per result. This is a search tool, not a page
 *  reader — a short snippet is enough to judge relevance, and keeping the
 *  request small keeps Exa's per-search cost down (content extraction is
 *  billed separately from the base search). */
const SNIPPET_MAX_CHARS = 500

interface ExaResultRow {
  title?: string | null
  url?: string
  publishedDate?: string | null
  text?: string | null
  summary?: string | null
}

interface ExaSearchResponseBody {
  results?: ExaResultRow[]
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

export interface ExaSearchOptions {
  limit?: number
  /** ISO 8601 date — only results published on/after this date. */
  startPublishedDate?: string
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * Run one Exa search. Throws on any request/parse failure —
 * lib/search/index.ts wraps this and turns it into the tool's structured
 * {ok:false, reason} response, same contract as searchDuckDuckGo.
 */
export async function searchExa(query: string, apiKey: string, opts: ExaSearchOptions = {}): Promise<SearchResult[]> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)))

  const res = await retryFetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      query,
      numResults: limit,
      type: 'auto',
      ...(opts.startPublishedDate ? { startPublishedDate: opts.startPublishedDate } : {}),
      contents: { text: { maxCharacters: SNIPPET_MAX_CHARS } },
    }),
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    retries: 2,
  })

  const data = (await res.json()) as ExaSearchResponseBody
  const rows = Array.isArray(data.results) ? data.results : []

  const out: SearchResult[] = []
  for (const row of rows) {
    if (typeof row.url !== 'string' || !row.url) continue
    const hostname = hostnameOf(row.url)
    if (!hostname) continue
    out.push({
      title: (row.title ?? '').trim() || row.url,
      url: row.url,
      snippet: (row.text ?? row.summary ?? '').trim(),
      publishedAt: row.publishedDate ?? undefined,
      source: hostname,
    })
  }
  return out
}
