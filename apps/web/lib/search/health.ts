// In-memory per-backend failure memory for lib/search/index.ts's failover
// chain — NOT database-backed (this task is DB-read-only, and per-process
// memory is exactly the right durability for this: a cache, not state). The
// problem this solves: without it, a backend that just got bot-blocked (or
// hit its monthly quota) would eat a full network round trip on EVERY call
// before the chain gives up on it and falls through — multiplied by every
// concurrent search this process handles. Remembering "X failed recently"
// lets the chain skip straight past it toward a healthier candidate instead.
//
// Skip, not ban: a backend recorded here is deprioritized for TTL_BY_REASON
// (below) worth of time, never permanently excluded. Two ways it heals:
//   1. Passive — isBackendRecentlyFailed() returns false once `retryAfter`
//      has passed, and the entry is pruned right there (self-cleaning Map,
//      no separate GC pass needed).
//   2. Active — recordBackendSuccess() clears the entry immediately the
//      moment a real attempt against that backend succeeds (lib/search/
//      index.ts's chain calls this the instant a candidate that was in its
//      "recently failed" bucket gets tried as a last resort and works).
//
// Resets on a cold start / rolls over per serverless instance — same
// disclaimer as lib/search/rate-limit.ts's in-memory window: a sanity
// governor, not a durability guarantee.

import type { SearchBackendId, SearchFailureReason } from './types'

export interface BackendHealthRecord {
  backend: SearchBackendId
  reason: SearchFailureReason
  detail?: string
  /** epoch ms this failure was recorded. */
  failedAt: number
  /** epoch ms this backend becomes eligible for normal-priority retry again. */
  retryAfter: number
}

/**
 * How long a failure keeps a backend deprioritized, by reason. Deliberately
 * NOT uniform: a transient rate limit is worth retrying soon; a monthly
 * quota cap will not self-heal for a long time, so hammering it every couple
 * of minutes is pure waste. 'no_key' isn't included — "not configured" is a
 * live config check every call (lib/search/index.ts reads it fresh from
 * opts/DB each time), not a failure worth remembering here; the same goes
 * for 'empty_query', which never even reaches a backend.
 */
const TTL_BY_REASON: Partial<Record<SearchFailureReason, number>> = {
  blocked: 10 * 60_000, // a bot-challenge rarely clears in under several minutes
  quota: 30 * 60_000, // a monthly cap will not reset soon; still short enough to self-heal without a redeploy
  rate_limited: 2 * 60_000, // the classic "worth another try shortly" case
  request_failed: 5 * 60_000, // bad key / malformed response / DNS — usually a config issue, not instantly fixed
}
const DEFAULT_TTL_MS = 5 * 60_000

const failures = new Map<SearchBackendId, BackendHealthRecord>()

/** Record a failure just observed for `backend`. A reason with no TTL entry
 *  above (i.e. none configured, all currently-defined reasons in
 *  SearchFailureReason DO have one) falls back to DEFAULT_TTL_MS rather than
 *  being silently ignored, so a future reason value fails safe. */
export function recordBackendFailure(
  backend: SearchBackendId,
  reason: SearchFailureReason,
  detail?: string,
  now: number = Date.now()
): void {
  const ttl = TTL_BY_REASON[reason] ?? DEFAULT_TTL_MS
  failures.set(backend, { backend, reason, detail, failedAt: now, retryAfter: now + ttl })
}

/** Clear any remembered failure for `backend` — called the moment a real
 *  attempt against it succeeds, so a backend that recovers mid-TTL is
 *  immediately trusted again rather than waiting out the clock. */
export function recordBackendSuccess(backend: SearchBackendId): void {
  failures.delete(backend)
}

/** True if `backend` failed recently enough that the chain should try other
 *  candidates first. Self-prunes an expired entry as a side effect, so a
 *  caller never has to separately garbage-collect this map. */
export function isBackendRecentlyFailed(backend: SearchBackendId, now: number = Date.now()): boolean {
  return getBackendHealthRecord(backend, now) !== null
}

/** The live failure record for `backend`, or null if none is remembered /
 *  its TTL has already passed (pruned here, same self-cleaning behavior as
 *  isBackendRecentlyFailed). Mainly for the Settings page's honest
 *  "duckduckgo: recently blocked, retry in 4m" status line. */
export function getBackendHealthRecord(backend: SearchBackendId, now: number = Date.now()): BackendHealthRecord | null {
  const rec = failures.get(backend)
  if (!rec) return null
  if (now >= rec.retryAfter) {
    failures.delete(backend)
    return null
  }
  return rec
}

/** Every currently-remembered failure, pruning expired ones along the way —
 *  the Settings page's backend-status panel reads this to explain why a
 *  backend is (temporarily) being skipped. */
export function getAllBackendHealth(now: number = Date.now()): BackendHealthRecord[] {
  const out: BackendHealthRecord[] = []
  for (const [backend, rec] of failures) {
    if (now >= rec.retryAfter) {
      failures.delete(backend)
      continue
    }
    out.push(rec)
  }
  return out
}

/** Test-only: clear all recorded state between test runs. */
export function _resetSearchHealthState(): void {
  failures.clear()
}
