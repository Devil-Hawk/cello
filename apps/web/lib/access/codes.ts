// Demo access codes: generation, hashing, and the usability rules.
//
// A code is a bearer credential typed by a human. That combination drives every
// decision here:
//
//   * It is READ ALOUD AND RETYPED, so the alphabet excludes characters people
//     confuse (0/O, 1/I/L) and comparison is case- and separator-insensitive.
//     A demo that fails because someone typed a lowercase l is a bug.
//   * It is a BEARER CREDENTIAL, so it needs real entropy (60 bits here) and is
//     stored only as a SHA-256 hash. A dump of access_codes must not hand
//     anyone a working code.
//   * It EXPIRES, and expiry is evaluated at use time against the stored
//     timestamp rather than swept by a job — a code is dead the moment it
//     lapses even if no cleanup ever runs.

import { createHash, randomInt } from 'node:crypto'

/** How long a freshly issued code lasts. The product promise is 72 hours. */
export const ACCESS_CODE_TTL_HOURS = 72

/**
 * Unambiguous when spoken or retyped: no O/0, no I/1/L, no U (heard as "you").
 * 30 symbols, 12 characters => ~58.8 bits of entropy.
 *
 * Exported so lib/access/tokens.ts's PAT generator draws from the SAME
 * alphabet rather than a second copy that could drift — a token is typed and
 * pasted far less often than a demo code, but there is no reason its
 * characters should be more confusable.
 */
export const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'
const CODE_LENGTH = 12
const GROUP_SIZE = 4

/** How many characters of the code are stored in the clear, for list display. */
export const CODE_PREFIX_LENGTH = 4

/**
 * A new code in display form, e.g. "P7QK-3M9X-TCR2".
 *
 * randomInt is rejection-sampled by Node, so this has no modulo bias — a subtle
 * way to lose entropy that `randomBytes[i] % ALPHABET.length` would introduce
 * silently, since 256 is not a multiple of 30.
 */
export function generateAccessCode(): string {
  let raw = ''
  for (let i = 0; i < CODE_LENGTH; i++) raw += ALPHABET[randomInt(0, ALPHABET.length)]
  return raw.match(new RegExp(`.{1,${GROUP_SIZE}}`, 'g'))!.join('-')
}

/**
 * Reduce anything a human might type to the canonical form used for hashing.
 *
 * Accepts lowercase, spaces, en/em dashes and stray punctuation, because all of
 * those turn up when a code travels through chat apps, autocorrect, or a
 * phone call.
 */
export function normalizeAccessCode(input: string): string {
  return (input || '')
    .toUpperCase()
    .replace(/[\s‐-―_.]/g, '')
    .replace(/-/g, '')
    .trim()
}

/** SHA-256 hex of the normalized code. The only form ever persisted. */
export function hashAccessCode(input: string): string {
  return createHash('sha256').update(normalizeAccessCode(input)).digest('hex')
}

/** The clear-text fragment kept for display, derived the same way every time. */
export function accessCodePrefix(input: string): string {
  return normalizeAccessCode(input).slice(0, CODE_PREFIX_LENGTH)
}

/** Shape-check before touching the database — cheap rejection of nonsense. */
export function looksLikeAccessCode(input: string): boolean {
  const n = normalizeAccessCode(input)
  if (n.length !== CODE_LENGTH) return false
  for (const ch of n) if (!ALPHABET.includes(ch)) return false
  return true
}

/** When a code issued now should stop working. */
export function accessCodeExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + ACCESS_CODE_TTL_HOURS * 60 * 60 * 1000)
}

/** The subset of an access_codes row the usability rules need. */
export interface AccessCodeRecord {
  expires_at: string | null
  revoked_at: string | null
}

export type AccessCodeRefusal =
  | 'expired'
  | 'revoked'
  | 'unreadable-expiry'

export interface AccessCodeUsability {
  usable: boolean
  reason?: AccessCodeRefusal
  /** Plain sentence for the person holding the code. */
  message?: string
}

/**
 * Whether a stored code may still be redeemed.
 *
 * FAILS CLOSED on an unreadable expiry. Every comparison against NaN is false,
 * so a naive `now > expiry` check would treat a corrupt timestamp as "not yet
 * expired" and leave the code working forever. That is the same fail-open shape
 * this codebase already had to fix once, in the outreach guardrails.
 */
export function accessCodeUsability(
  record: AccessCodeRecord,
  now: Date = new Date()
): AccessCodeUsability {
  if (record.revoked_at) {
    return { usable: false, reason: 'revoked', message: 'This access code was turned off.' }
  }

  const expiresMs = record.expires_at ? new Date(record.expires_at).getTime() : Number.NaN
  if (!Number.isFinite(expiresMs)) {
    return {
      usable: false,
      reason: 'unreadable-expiry',
      message: 'This access code is not valid.',
    }
  }

  if (now.getTime() >= expiresMs) {
    return { usable: false, reason: 'expired', message: 'This access code has expired.' }
  }

  return { usable: true }
}

/** Human phrasing for how long a code has left, for the owner's list. */
export function describeTimeRemaining(expiresAt: string, now: Date = new Date()): string {
  const ms = new Date(expiresAt).getTime() - now.getTime()
  if (!Number.isFinite(ms)) return 'unknown'
  if (ms <= 0) return 'expired'
  const hours = Math.floor(ms / 3_600_000)
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    const rem = hours % 24
    return rem ? `${days}d ${rem}h left` : `${days}d left`
  }
  if (hours >= 1) return `${hours}h left`
  return `${Math.max(1, Math.floor(ms / 60_000))}m left`
}
