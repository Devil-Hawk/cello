// DuckDuckGo backend — Cello's DEFAULT, keyless web_search backend. Scrapes
// the plain HTML results endpoint (no official search API, no key, works out
// of the box for every user) using the same approach career-ops's
// searchForNewUrl fallback already runs in production (see
// /home/ankit/career-ops/scan.mjs ~line 471, read-only reference) — ported
// here without a browser: we only need to parse a static HTML document, not
// execute JS, so a real HTML parser (cheerio) over a plain fetch replaces
// Playwright's page.goto()/evaluate(). This repo's REINVENTION-AUDIT.md rules
// out hand-rolled regex scraping, hence cheerio rather than a homegrown
// tag-matcher.
//
// DuckDuckGo has no public terms for this endpoint and actively challenges
// automated traffic with an "anomaly" bot-check page (an image CAPTCHA, no
// API to solve it, no api key that unblocks it) — confirmed directly against
// the live endpoint while building this (every request from this sandbox's
// egress IP got challenged, even a first request with no prior traffic).
// parseDuckDuckGoHtml() recognizes that page and reports it as a distinct
// `blocked` failure rather than silently returning zero results.

import * as cheerio from 'cheerio'
import { retryFetch } from '../fetch'
import type { SearchResult } from '../types'

const ENDPOINT = 'https://html.duckduckgo.com/html/'
// A realistic desktop Chrome UA — DuckDuckGo's HTML endpoint is far more
// likely to serve (rather than challenge) a request that looks like an
// ordinary browser than one carrying a bot-flavored UA string.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 25

/** DDG's date-filter query param: last day/week/month/year. */
const DATE_FILTER: Record<NonNullable<DuckDuckGoSearchOptions['freshness']>, string> = {
  day: 'd',
  week: 'w',
  month: 'm',
  year: 'y',
}

/** Thrown when DuckDuckGo served its bot-verification challenge page instead
 *  of results — a distinct, honest failure mode from "zero results found". */
export class DuckDuckGoBlockedError extends Error {
  constructor(message = 'DuckDuckGo returned its bot-verification challenge instead of search results') {
    super(message)
    this.name = 'DuckDuckGoBlockedError'
  }
}

/**
 * DDG wraps every organic result href in a `/l/?uddg=<encoded>` redirect —
 * unwrap it to the real destination so hostname/domain checks (and the
 * caller) see the actual site instead of duckduckgo.com. Ported from
 * career-ops's resolveSearchHref (scan.mjs).
 */
function resolveResultHref(raw: string): string {
  try {
    const url = new URL(raw, 'https://duckduckgo.com')
    const isDdgHost = url.hostname === 'duckduckgo.com' || url.hostname.endsWith('.duckduckgo.com')
    if (isDdgHost && url.pathname === '/l/') {
      const target = url.searchParams.get('uddg')
      if (target) return target
    }
    return url.toString()
  } catch {
    return raw
  }
}

/**
 * Parse a DuckDuckGo HTML results page into normalized hits. Throws
 * DuckDuckGoBlockedError when the page is the bot-challenge instead of
 * results. Pure (no I/O) so it is unit-testable against a saved HTML fixture
 * with no network involved.
 */
export function parseDuckDuckGoHtml(html: string, limit: number): SearchResult[] {
  const $ = cheerio.load(html)

  // The challenge page renders a `#challenge-form` / `.anomaly-modal` puzzle
  // instead of any `.result` markup — check for it before assuming an empty
  // `.result` set means "no matches".
  if ($('#challenge-form, .anomaly-modal').length > 0) {
    throw new DuckDuckGoBlockedError()
  }

  const results: SearchResult[] = []

  $('a.result__a').each((_, el) => {
    if (results.length >= limit) return false

    const link = $(el)
    const title = link.text().trim()
    const href = resolveResultHref(link.attr('href') ?? '')
    if (!title || !href) return

    // Sponsored slots share the same result__a markup but their container
    // (the div wrapping result__body) carries a `result--ad` class — best
    // effort, non-fatal if DDG ever renames it (we'd just include an ad row,
    // never crash).
    const container = link.closest('.result__body').parent()
    if (container.hasClass('result--ad') || container.find('.badge--ad').length > 0) return

    let hostname: string
    try {
      hostname = new URL(href).hostname
    } catch {
      return // not a real absolute URL — skip rather than emit a broken row
    }

    const snippetNode = container.find('.result__snippet').first()
    const snippet = snippetNode.text().trim()

    results.push({ title, url: href, snippet, source: hostname })
  })

  return results
}

export interface DuckDuckGoSearchOptions {
  limit?: number
  freshness?: 'day' | 'week' | 'month' | 'year'
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * Run one DuckDuckGo HTML search. Throws on any request/parse failure
 * (including DuckDuckGoBlockedError) — lib/search/index.ts wraps this call
 * and turns every failure into the tool's structured {ok:false, reason}
 * response; this function itself stays a thin, honestly-throwing fetch+parse
 * so its own unit tests can assert on the specific error types.
 */
export async function searchDuckDuckGo(query: string, opts: DuckDuckGoSearchOptions = {}): Promise<SearchResult[]> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)))

  const params = new URLSearchParams({ q: query })
  if (opts.freshness) params.set('df', DATE_FILTER[opts.freshness])

  const res = await retryFetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    // DDG's bot-challenge is a 2xx page, not a retryable HTTP status — the
    // shared classifier here only ever fires for a genuine transport-level
    // blip (429/5xx/reset/timeout), so 2 retries is plenty.
    retries: 2,
  })

  const html = await res.text()
  return parseDuckDuckGoHtml(html, limit)
}
