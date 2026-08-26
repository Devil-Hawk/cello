// Throttle on demo access-code redemption attempts.
//
// WHY NOT lib/search/rate-limit.ts
//   That limiter is keyed by user id, budgets 12 attempts a MINUTE, and exists
//   to stop a runaway loop from burning a metered search API. This endpoint is
//   a different shape in every way that matters:
//
//     * It runs BEFORE anyone is authenticated, so the key has to be something
//       anonymous and attacker-influenced rather than a user id.
//     * A user-id-keyed Map is bounded by the number of users. A key derived
//       from request headers is bounded by nothing, so this one has to defend
//       its own memory.
//     * It guards a bearer credential, not a bill.
//
//   Same in-memory sliding-window shape as the search limiter, deliberately —
//   it is the pattern this codebase already uses, and the same caveat applies:
//   state is per serverless instance and resets on a cold start. A governor,
//   not a hard security boundary.
//
// WHAT IT IS ACTUALLY FOR
//   An access code carries ~59 bits, so online brute force was never going to
//   work: at the global cap below it is ~10^13 years to cover half the space.
//   The limiter earns its place for the other reasons — it stops the endpoint
//   being a free oracle to bang on, it caps the cost of a flood (every attempt
//   that gets past the shape check costs a database round trip), and it slows
//   down spraying a code that leaked into a group chat.
//
// THE GLOBAL CAP
//   The per-client key comes from proxy headers. Behind Vercel those are set by
//   the platform, but this code should not assume its deployment target: anyone
//   who can forge the header gets a fresh bucket per request and the per-client
//   limit evaporates. The global cap does not depend on the key at all, so it
//   is the part that still holds in that case. It is set high enough that real
//   demo traffic — a handful of people typing a code — never reaches it.

/** One window. Long, because a human typing a 12-character code is slow. */
const WINDOW_MS = 10 * 60_000

/** Per client. Generous enough to survive typos, tight enough to be useless
 *  for guessing. */
const MAX_PER_CLIENT = 12

/** Per instance, regardless of client key. See "THE GLOBAL CAP" above. */
const MAX_GLOBAL = 240

/** Ceiling on distinct keys held in memory, so a flood cannot grow the Map
 *  without bound. */
const MAX_TRACKED_CLIENTS = 5_000

const clientHits = new Map<string, number[]>()
let globalHits: number[] = []

export type RedeemGate =
  | { allowed: true }
  /** `scope` is for server-side logging only — the caller must not tell the
   *  person at the keyboard which cap they hit. */
  | { allowed: false; scope: 'client' | 'global' }

/**
 * Whether this redemption attempt may proceed.
 *
 * Records the attempt whether or not it is allowed, so the window keeps sliding
 * while a client is over the limit — someone hammering the endpoint does not
 * get to reset their own clock by hammering it harder.
 */
export function allowRedeemAttempt(clientKey: string, now: number = Date.now()): RedeemGate {
  const windowStart = now - WINDOW_MS

  globalHits = globalHits.filter((t) => t > windowStart)
  const recent = (clientHits.get(clientKey) ?? []).filter((t) => t > windowStart)

  // Record first, decide second: both counters must move even on a refusal.
  globalHits.push(now)
  recent.push(now)
  clientHits.set(clientKey, recent)
  pruneClients(windowStart)

  // Compare against `> MAX` because the current attempt is already counted.
  if (globalHits.length > MAX_GLOBAL) return { allowed: false, scope: 'global' }
  if (recent.length > MAX_PER_CLIENT) return { allowed: false, scope: 'client' }
  return { allowed: true }
}

/**
 * Drop keys whose attempts have all aged out.
 *
 * If that is not enough — which means someone is minting fresh keys faster than
 * the window retires them — the whole table goes. Clearing loses the counters
 * of legitimate clients, but the global cap is still standing and does not
 * depend on this table at all, so the endpoint stays protected. Unbounded
 * growth is the worse failure: it takes down the process for everyone.
 */
function pruneClients(windowStart: number): void {
  if (clientHits.size <= MAX_TRACKED_CLIENTS) return

  for (const [key, times] of clientHits) {
    if (times.length === 0 || times[times.length - 1] <= windowStart) clientHits.delete(key)
  }

  if (clientHits.size > MAX_TRACKED_CLIENTS) clientHits.clear()
}

/**
 * The bucket key for a request. In memory only — this is the one place in the
 * feature that handles a raw address, and it never reaches a database. The
 * audit trail's attribution is a different thing entirely and is derived
 * separately, non-reversibly, in lib/access/audit.ts.
 *
 * `x-real-ip` is preferred over `x-forwarded-for` because a proxy sets it to a
 * single value it determined itself, whereas x-forwarded-for is a client-
 * supplied chain a proxy appends to. (audit.ts reads x-forwarded-for first, and
 * is right to: a hint a human reads is allowed to trust a header that a
 * security decision must not.) Vercel overwrites both, but nothing here should
 * depend on the deployment target — the global cap above is what holds when
 * this key can be forged.
 *
 * Falls back to a SHARED bucket, not a unique one. An unidentifiable caller
 * sharing one bucket with every other unidentifiable caller is the restrictive
 * failure; a private bucket per unidentifiable caller would let anyone opt out
 * of the limit by stripping headers.
 */
export function clientKey(headers: Headers): string {
  const realIp = headers.get('x-real-ip')?.trim()
  if (realIp) return realIp

  const forwarded = headers.get('x-forwarded-for')
  const first = forwarded?.split(',')[0]?.trim()
  if (first) return first

  return 'unattributed'
}

/** Test-only: clear all recorded state between test runs. */
export function _resetRedeemRateLimitState(): void {
  clientHits.clear()
  globalHits = []
}

/** Test-only: the caps, so tests assert against the real numbers. */
export const _REDEEM_LIMITS = {
  WINDOW_MS,
  MAX_PER_CLIENT,
  MAX_GLOBAL,
  MAX_TRACKED_CLIENTS,
} as const
