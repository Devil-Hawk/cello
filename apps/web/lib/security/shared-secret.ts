// Constant-time shared-secret checks for the machine-to-machine routes
// (cron ticks, browser-runner callbacks). One copy so the five routes that
// used to carry their own `===` comparison cannot drift.
//
// Both sides are hashed first so timingSafeEqual always sees two 32-byte
// buffers: it never throws on a length mismatch and the secret's length is
// not leaked either.

import { createHash, timingSafeEqual } from 'node:crypto'

const digest = (s: string) => createHash('sha256').update(s).digest()

/** True only when both values are non-empty and equal. An unset secret never matches. */
export function secretMatches(given: string | null | undefined, secret: string | undefined): boolean {
  if (!given || !secret) return false
  return timingSafeEqual(digest(given), digest(secret))
}

/** The token of an `Authorization: Bearer <token>` header (scheme is case-insensitive), else null. */
function bearerToken(request: Request): string | null {
  const auth = request.headers.get('authorization')
  return auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null
}

/**
 * CRON_SECRET, presented as `Authorization: Bearer <secret>` (what Vercel Cron
 * and the GitHub workflows send) or `X-Cron-Secret: <secret>`. Never read from
 * the query string. Fails closed when CRON_SECRET is unset.
 */
export function isCronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  // Both are always evaluated, no early exit between them.
  const viaBearer = secretMatches(bearerToken(request), secret)
  const viaHeader = secretMatches(request.headers.get('x-cron-secret'), secret)
  return viaBearer || viaHeader
}

/** BROWSER_RUNNER_SECRET as a bearer token only. Fails closed when unset. */
export function isRunnerAuthorized(request: Request): boolean {
  return secretMatches(bearerToken(request), process.env.BROWSER_RUNNER_SECRET)
}
