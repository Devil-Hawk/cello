// Throttle on demo access-code redemption attempts, shared by every serverless
// instance.
//
// WHY NOT lib/search/rate-limit.ts
//   That limiter is keyed by user id and exists to stop a runaway loop from
//   burning a metered search API. This endpoint runs BEFORE anyone is
//   authenticated, so the key has to be something anonymous and
//   attacker-influenced, and it guards a bearer credential, not a bill.
//
// WHY IT LIVES IN POSTGRES
//   The first version was an in-memory Map per serverless instance: the limit
//   was per instance and reset on every cold start, so an attacker spread across
//   instances (or just waiting for one to recycle) was never really limited.
//   The counters now live in public.access_redeem_attempts, bumped by ONE atomic
//   upsert per attempt (note_redeem_attempt, migration 20261008030001), and
//   pruned by pg_cron.
//
// WHAT IT IS ACTUALLY FOR
//   An access code carries about 59 bits, so online brute force was never going
//   to work: at the global cap below it is ~10^13 years to cover half the space.
//   The limiter earns its place because it stops the endpoint being a free
//   oracle to bang on, caps the cost of a flood (every attempt that gets past
//   the shape check costs a database round trip), and slows down spraying a code
//   that leaked into a group chat.
//
// NO RAW ADDRESS IS STORED. The client key is an HMAC of the address under a key
// derived from the server's encryption key (lib/crypto.ts deriveKey), so the
// table holds an opaque token that cannot be reversed to an IP, or even
// correlated across deployments.
//
// THE GLOBAL CAP does not depend on the client key at all, so it is the part that
// still holds if the proxy headers behind the key can be forged. It is set high
// enough that real demo traffic (a handful of people typing a code) never
// reaches it. The numbers (12 per client, 240 overall, per 10 minute window) live
// in the SQL function.
//
// FAILS CLOSED: if the database cannot answer, the attempt is refused.

import { createHmac } from 'node:crypto'
import { deriveKey } from '@/lib/crypto'
import type { AdminClient } from '@/lib/harness/types'

export type RedeemGate =
  | { allowed: true }
  /** `scope` is for server-side logging only: the caller must not tell the
   *  person at the keyboard which of these they hit. */
  | { allowed: false; scope: 'limit' | 'unavailable' }

const RATE_LIMIT_KEY_LABEL = 'cello/redeem-limit/v1'

/**
 * The raw address behind a request, for hashing only. `x-real-ip` is preferred
 * over `x-forwarded-for` because a proxy sets it to a single value it
 * determined itself, whereas x-forwarded-for is a client-supplied chain a proxy
 * appends to. (audit.ts reads x-forwarded-for first, and is right to: a hint a
 * human reads is allowed to trust a header that a security decision must not.)
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

/** The bucket key stored in Postgres: 32 hex characters of an HMAC of the
 *  address. Never contains the address. */
export function rateLimitKey(headers: Headers): string {
  return createHmac('sha256', deriveKey(RATE_LIMIT_KEY_LABEL)).update(clientKey(headers)).digest('hex').slice(0, 32)
}

/** Whether this redemption attempt may proceed. Counts the attempt either way,
 *  so someone hammering the endpoint does not get to reset their own clock. */
export async function allowRedeemAttempt(admin: AdminClient, headers: Headers): Promise<RedeemGate> {
  try {
    const { data, error } = await admin.rpc('note_redeem_attempt', { p_client: rateLimitKey(headers) })
    if (error || typeof data !== 'boolean') return { allowed: false, scope: 'unavailable' }
    return data ? { allowed: true } : { allowed: false, scope: 'limit' }
  } catch {
    return { allowed: false, scope: 'unavailable' }
  }
}
