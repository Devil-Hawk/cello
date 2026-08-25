// In-memory per-user rate limiter for /api/search. Deliberately NOT
// database-backed — this task is DB-read-only, and a sliding-window Map is
// good enough to stop one user/loop from hammering Exa (paid, ~$7/1k
// searches) or DuckDuckGo (a shared free resource we don't want every user
// getting IP-blocked on). Resets on a cold start / rolls over per serverless
// instance — a sanity governor, not a hard security boundary.

const WINDOW_MS = 60_000
/** Generous for the free DuckDuckGo path, still cheap even if every call
 *  happened to land on the paid Exa backend (worst case ~$0.084/user/min). */
const MAX_PER_WINDOW = 12

const hits = new Map<string, number[]>()

/** True if this request should be allowed; records the attempt either way so
 *  the window keeps sliding even while a user is over the limit. */
export function allowSearchRequest(userId: string, now: number = Date.now()): boolean {
  const windowStart = now - WINDOW_MS
  const recent = (hits.get(userId) ?? []).filter((t) => t > windowStart)
  const allowed = recent.length < MAX_PER_WINDOW
  if (allowed) recent.push(now)
  hits.set(userId, recent)
  return allowed
}

/** Test-only: clear all recorded state between test runs. */
export function _resetSearchRateLimitState(): void {
  hits.clear()
}
