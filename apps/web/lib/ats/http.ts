// Shared HTTP transport for ATS adapters. Framework-free (global fetch only).
//
// Retry/backoff on a transient blip (timeout, dropped connection, 429/5xx) is
// delegated to `p-retry` — the same library lib/harness/llm.ts uses — with
// the shared classifyError() predicate (lib/util/retry) as its `shouldRetry`
// hook, so every HTTP source shares one retry policy instead of hand-rolling
// its own. A momentary failure against one board now gets a few retries
// before that source is dropped; a permanent failure (404, bad request)
// still fails on the first attempt, same as before.

import pRetry from 'p-retry'
import { isTransient } from '../util/retry'

const DEFAULT_TIMEOUT_MS = 10_000
const USER_AGENT = 'cello-job-tracker/1.0 (+https://cello-two.vercel.app)'

export class HttpError extends Error {
  readonly status: number
  readonly retryAfter: number | null

  constructor(message: string, status: number, retryAfter: number | null = null) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.retryAfter = retryAfter
  }
}

export interface FetchJsonOptions {
  /** Abort the request after this many ms (default 10s), per attempt. */
  timeoutMs?: number
  /**
   * Extra attempts on 429/5xx/network failure, on top of the first
   * (default 3, i.e. 4 total attempts — matches p-retry's `retries` option
   * name/semantics directly). Pass 0 to disable retries entirely (a single
   * request, old behavior).
   */
  retries?: number
  /** Base for exponential backoff + jitter (default 400ms — p-retry's `minTimeout`). */
  backoffBaseMs?: number
  /** Hard cap on any single backoff delay, in ms (default 8s — p-retry's `maxTimeout`). */
  backoffCapMs?: number
  headers?: Record<string, string>
  /**
   * Unused: retry timing is now owned entirely by p-retry (real timers), which
   * has no hook to substitute an injectable sleep. Kept only so existing
   * callers that pass one (e.g. lib/ats/ashby.ts's `ctx?.sleep`) still
   * type-check; nothing currently reads it.
   */
  sleep?: (ms: number) => Promise<void>
  /** Cancel/deadline signal — aborts the in-flight request and stops retrying. */
  signal?: AbortSignal
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

/** Combine two AbortSignals into one that aborts when either does. */
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

async function fetchOnce(url: string, opts: FetchJsonOptions): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = combineSignals(opts.signal, controller.signal)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'user-agent': USER_AGENT,
        accept: 'application/json',
        ...(opts.headers ?? {}),
      },
      // Never follow redirects: combined with per-adapter host allowlists this
      // guarantees the final host is one we vetted (no SSRF via redirect).
      redirect: 'error',
      signal,
    })
    if (!res.ok) {
      throw new HttpError(
        `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} for ${url}`,
        res.status,
        parseRetryAfter(res.headers.get('retry-after'))
      )
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchJson<T = unknown>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const retries = Math.max(0, opts.retries ?? 3)
  return pRetry(() => fetchOnce(url, opts), {
    retries,
    factor: 2,
    minTimeout: opts.backoffBaseMs ?? 400,
    maxTimeout: opts.backoffCapMs ?? 8_000,
    randomize: true,
    // The retry LOOP's stop signal is the caller's own cancel/deadline only
    // — NOT the per-attempt timeout controller fetchOnce builds internally.
    // A single slow attempt timing out is exactly the transient case worth
    // retrying; only an explicit caller cancel should stop the whole loop.
    signal: opts.signal,
    shouldRetry: ({ error }) => isTransient(error),
  }) as Promise<T>
}

/** Throw unless the URL is https and its host is in the allowlist. */
export function assertAllowedHost(url: string, allowedHosts: ReadonlySet<string>): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`ats: invalid URL: ${url}`)
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`ats: URL must use HTTPS: ${url}`)
  }
  if (!allowedHosts.has(parsed.hostname)) {
    throw new Error(`ats: untrusted hostname "${parsed.hostname}"`)
  }
  return url
}
