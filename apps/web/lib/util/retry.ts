// Shared error CLASSIFIER for every network boundary in Cello: LLM provider
// calls (lib/harness/llm.ts) and outbound HTTP fetches (lib/ats/http.ts,
// which lib/sources/util.ts's getJson delegates to). One rule everywhere: a
// TRANSIENT failure (a rate limit, a 5xx, a dropped connection, a timeout)
// is worth retrying; a PERMANENT failure (bad auth, bad request, out of
// budget) is not — retrying it only wastes time and, for metered LLM calls,
// money. See classifyError() below for exactly which is which.
//
// This file is deliberately NOT a retry primitive: no attempt loop, no
// backoff/jitter math, no timers, no AbortSignal wiring. That mechanics is
// entirely delegated to `p-retry` (see package.json) — a tiny, TS-native,
// AbortSignal-aware library that already does it correctly. This module only
// answers "was this particular error worth trying again?", which every call
// site plugs in as p-retry's `shouldRetry` hook.
//
// Framework-free (no Node-only imports) so this is safe to use from both
// edge-ish HTTP transports and the harness runtime.

/** Result of classifying a caught error for retry purposes. */
export type ErrorClass = 'transient' | 'permanent' | 'unknown'

/** HTTP statuses worth retrying: rate limits, timeouts, and server-side blips. */
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524, 529])

/** HTTP statuses that will never succeed on retry — bad request/auth/budget/state. */
const PERMANENT_STATUS = new Set([400, 401, 402, 403, 404, 409, 410, 422])

/** App-level error classes that are permanent by construction (matched by
 *  `.name` so this module never has to import lib/harness — see each error's
 *  own definition in lib/harness/providers/index.ts and lib/harness/spend.ts). */
const PERMANENT_ERROR_NAMES = new Set(['MissingKeyError', 'BudgetCapError', 'TruncatedResponseError'])

/** Node/undici network-layer error codes that mean "try again". */
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
])

function errorName(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined
  const named = (err as { name?: unknown }).name
  if (typeof named === 'string' && named) return named
  const ctorName = (err as { constructor?: { name?: string } }).constructor?.name
  return typeof ctorName === 'string' ? ctorName : undefined
}

function getStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined
  const e = err as Record<string, unknown>
  if (typeof e.status === 'number') return e.status
  if (typeof e.statusCode === 'number') return e.statusCode as number
  return undefined
}

/** Walk up to a few `.cause` links looking for a Node error `code` string. */
function getCode(err: unknown, depth = 0): string | undefined {
  if (!err || typeof err !== 'object' || depth > 3) return undefined
  const e = err as Record<string, unknown>
  if (typeof e.code === 'string') return e.code
  return getCode(e.cause, depth + 1)
}

/**
 * Classify a caught error as 'transient' (worth retrying), 'permanent'
 * (never retry — it will fail the same way every time, or retrying it costs
 * real money for no chance of success), or 'unknown' (no signal either way —
 * treated the same as 'permanent' by callers: only a recognized-transient
 * error should ever be retried, so an unrecognized error never gets silently
 * retried into wasted time/spend).
 */
export function classifyError(err: unknown): ErrorClass {
  if (err === null || err === undefined) return 'unknown'

  const name = errorName(err)
  if (name && PERMANENT_ERROR_NAMES.has(name)) return 'permanent'

  const status = getStatus(err)
  if (status !== undefined) {
    if (TRANSIENT_STATUS.has(status)) return 'transient'
    if (PERMANENT_STATUS.has(status)) return 'permanent'
    // Any other 4xx we don't recognize is far more likely a permanent
    // client-side problem than a transient one — don't retry it.
    if (status >= 400 && status < 500) return 'permanent'
    // Any other 5xx is still a server-side failure — worth a retry.
    if (status >= 500) return 'transient'
  }

  const code = getCode(err)
  if (code && TRANSIENT_CODES.has(code)) return 'transient'

  // A fetch/DOMException abort. This is ambiguous by itself — it fires both
  // for a per-request timeout (retryable) and for the caller's own
  // cancel/deadline signal firing (must NOT retry). Every call site also
  // passes its own AbortSignal into p-retry's `signal` option, and p-retry
  // itself re-checks that signal before every attempt/backoff — so a genuine
  // caller-driven cancel stops the retry loop regardless of what we return
  // here; treating the ambiguous case as transient just means a plain
  // per-attempt timeout (not tied to the caller's own signal) still retries.
  if (name === 'AbortError') return 'transient'

  const message = typeof (err as { message?: unknown })?.message === 'string' ? (err as Error).message.toLowerCase() : ''
  if (
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('enotfound') ||
    message.includes('econnrefused') ||
    message.includes('fetch failed') ||
    message.includes('network error') ||
    message.includes('socket hang up') ||
    message.includes('timeout')
  ) {
    return 'transient'
  }

  return 'unknown'
}

/** Convenience predicate for p-retry's `shouldRetry` hook: `({error}) => isTransient(error)`. */
export function isTransient(err: unknown): boolean {
  return classifyError(err) === 'transient'
}
