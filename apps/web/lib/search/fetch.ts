// Shared retry-wrapped fetch for search backends — the exact same p-retry +
// classifyError policy lib/ats/http.ts's fetchJson already established for
// ATS sources, generalized to hand back the raw Response instead of parsed
// JSON: DuckDuckGo returns HTML (parsed by backends/duckduckgo.ts via
// cheerio) and Exa returns JSON (parsed by backends/exa.ts), so this layer
// stays format-agnostic. Framework-free.
//
// Per docs/PRODUCT-VISION.md's reliability bar: "no tool call, no web search
// ... ever hard-crashes the request" — this function still THROWS on failure
// (same contract as fetchJson) so its own retry behavior stays simple and
// unit-testable; it is lib/search/index.ts's job to catch that and turn it
// into the tool's honest {ok:false, reason} contract.

import pRetry from 'p-retry'
import { isTransient } from '../util/retry'

const DEFAULT_TIMEOUT_MS = 10_000

export interface RetryFetchOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  /** Abort a single attempt after this many ms (default 10s). */
  timeoutMs?: number
  /** Extra attempts on a transient failure, beyond the first (default 2). */
  retries?: number
  backoffBaseMs?: number
  backoffCapMs?: number
  signal?: AbortSignal
}

/** Thrown for a non-2xx HTTP response; `status` is what classifyError()
 *  (lib/util/retry) reads to decide transient vs permanent. */
export class SearchHttpError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'SearchHttpError'
    this.status = status
  }
}

/** Combine two AbortSignals into one that aborts when either does — ported
 *  verbatim from lib/ats/http.ts (same need, kept local so this module has
 *  no import of that file's other JSON-specific concerns). */
function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b])
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (a.aborted || b.aborted) controller.abort()
  else {
    a.addEventListener('abort', onAbort, { once: true })
    b.addEventListener('abort', onAbort, { once: true })
  }
  return controller.signal
}

async function fetchOnce(url: string, opts: RetryFetchOptions): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = combineSignals(opts.signal, controller.signal)
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: opts.headers,
      body: opts.body,
      // Both destination hosts (html.duckduckgo.com, api.exa.ai) are fixed,
      // not user-supplied — refusing redirects is defense in depth, same
      // stance as lib/ats/http.ts and lib/apify/client.ts.
      redirect: 'error',
      signal,
    })
    if (!res.ok) {
      throw new SearchHttpError(
        `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} for ${url}`,
        res.status
      )
    }
    return res
  } finally {
    clearTimeout(timer)
  }
}

/**
 * GET/POST with the shared transient/permanent classifier driving p-retry —
 * a rate limit, a 5xx, or a dropped connection gets a couple of retries with
 * backoff; a permanent failure (bad key, bad request) fails on the first
 * attempt. Never used for JSON parsing — callers read the Response body
 * themselves (`.text()` or `.json()`).
 */
export async function retryFetch(url: string, opts: RetryFetchOptions = {}): Promise<Response> {
  const retries = Math.max(0, opts.retries ?? 2)
  return pRetry(() => fetchOnce(url, opts), {
    retries,
    factor: 2,
    minTimeout: opts.backoffBaseMs ?? 400,
    maxTimeout: opts.backoffCapMs ?? 4_000,
    randomize: true,
    signal: opts.signal,
    shouldRetry: ({ error }) => isTransient(error),
  })
}
