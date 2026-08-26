// Personal access tokens: the machine-surface credential for MCP and A2A.
//
// A human signs in with a Supabase session and a cookie. An MCP host or an A2A
// caller polling a task has neither, so it needs something it can hold and
// present on every request instead. This file is that credential's whole
// lifecycle: mint one, hash it, validate a bearer against the hash, and
// revoke it — the same shape lib/access/codes.ts already established for demo
// codes, applied to a token that grants API access rather than a demo
// workspace.
//
// THE SAME THREE PROPERTIES access_codes CARRIES, FOR THE SAME REASON:
//   * The plaintext is never stored — only a SHA-256 hash. A dump of
//     api_tokens must not hand anyone a working credential.
//   * Expiry is evaluated at VALIDATION time against a stored timestamp, not
//     swept by a job — a token is dead the instant it lapses even if nothing
//     ever cleans the row up.
//   * Revocation is immediate and independent of expiry.
//
// EVERY WRITE GOES THROUGH THE SERVICE-ROLE ADMIN CLIENT, PASSED IN EXPLICITLY.
// supabase/migrations/20260819000001_api_tokens.sql gives `authenticated` no
// insert or update policy on this table at all — see that migration's header
// for why: issuing means generating + hashing + a show-once response, none of
// which a bare PostgREST insert can do, and revoking/touching are server-side
// for the same reason a demo profile must never reach them directly. Every
// function below takes its AdminClient as the first argument (matching
// lib/harness/spend.ts's assertWithinBudget/recordSpend) rather than building
// one internally, so a caller cannot forget which authority it is writing
// with and a test can inject a fake.

import { createHash, randomInt } from 'node:crypto'
import type { AdminClient } from '@/lib/harness/types'
import { ALPHABET } from './codes'

const TABLE = 'api_tokens'

/** Every token starts with this, so a leaked value is recognizable on sight
 *  (in a log line, a git diff, a Slack message) the way `sk-` or `ghp_` are. */
export const TOKEN_PREFIX = 'cello_pat_'

/** Characters after the prefix. 30 symbols ^ 32 => ~157 bits of entropy —
 *  this is pasted into config files and MCP client settings, not read aloud,
 *  so there is no reason to keep it as short as a spoken demo code. */
const TOKEN_RANDOM_LENGTH = 32

/** How throttled last_used_at writes are. A hot polling loop (A2A task
 *  status) must not cost a write per request; this is a courtesy timestamp
 *  for the settings list, not an audit trail. ponytail: an in-memory
 *  comparison against the row's own last_used_at, not a queue or a cron —
 *  upgrade to a real rate limiter only if this table's write volume ever
 *  matters. */
const TOUCH_THROTTLE_MS = 60_000

/**
 * A fresh plaintext token: `cello_pat_` + 32 characters from the same
 * unambiguous alphabet lib/access/codes.ts uses. randomInt is rejection-
 * sampled by Node, so this carries no modulo bias.
 */
export function generateToken(): string {
  let random = ''
  for (let i = 0; i < TOKEN_RANDOM_LENGTH; i++) random += ALPHABET[randomInt(0, ALPHABET.length)]
  return `${TOKEN_PREFIX}${random}`
}

/** SHA-256 hex of the plaintext. The only form ever persisted. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Cheap shape check before touching the database — same role
 *  looksLikeAccessCode() plays for demo codes. */
export function looksLikeToken(value: string): boolean {
  if (!value.startsWith(TOKEN_PREFIX)) return false
  const random = value.slice(TOKEN_PREFIX.length)
  if (random.length !== TOKEN_RANDOM_LENGTH) return false
  for (const ch of random) if (!ALPHABET.includes(ch)) return false
  return true
}

export interface CreateTokenInput {
  userId: string
  name: string
  scopes: string[]
  /** Omit for a token that never expires. */
  expiresAt?: Date | null
}

export interface ApiTokenRecord {
  id: string
  name: string
  scopes: string[]
  expiresAt: string | null
  revokedAt: string | null
  lastUsedAt: string | null
  createdAt: string
}

export interface IssuedToken extends ApiTokenRecord {
  /** THE ONLY TIME THIS VALUE EXISTS OUTSIDE THE CALLER'S HANDS. Never
   *  stored, never logged, never recoverable from any later read. */
  token: string
}

/**
 * Mint a token, hash it, and store the hash. Returns the plaintext ONCE —
 * nothing after this call can ever produce it again.
 *
 * Does not check is_demo itself: that refusal belongs to the route, which can
 * answer in a sentence a person or an MCP client reads, before this function
 * is ever reached. The migration's forbid_demo_api_tokens trigger is the
 * backstop for any caller that forgets — see its header for why there is
 * deliberately no exemption for this call to route around.
 */
export async function createToken(
  admin: AdminClient,
  input: CreateTokenInput
): Promise<IssuedToken> {
  const token = generateToken()
  const { data, error } = await admin
    .from(TABLE)
    .insert({
      user_id: input.userId,
      name: input.name,
      token_hash: hashToken(token),
      scopes: input.scopes,
      expires_at: input.expiresAt ? input.expiresAt.toISOString() : null,
    })
    .select('id, name, scopes, expires_at, revoked_at, last_used_at, created_at')
    .single()

  if (error || !data) {
    throw new Error(error?.message ?? 'Failed to create access token')
  }

  return { ...rowToRecord(data), token }
}

export type TokenRefusalReason = 'expired' | 'revoked' | 'unknown'

export interface TokenValidation {
  ok: boolean
  userId?: string
  scopes?: string[]
  reason?: TokenRefusalReason
}

/**
 * Validate a bearer value against the store.
 *
 * FAILS CLOSED, same rule accessCodeUsability follows: a token that does not
 * look like ours, is not found, is revoked, or has an unreadable/lapsed
 * expiry all refuse. `expired` is distinguished from `unknown` because it is
 * checked at USE time against the stored timestamp — no sweeper deletes an
 * expired row, so it is still there to say why.
 */
export async function validateToken(admin: AdminClient, bearer: string): Promise<TokenValidation> {
  if (!looksLikeToken(bearer)) return { ok: false, reason: 'unknown' }

  const { data, error } = await admin
    .from(TABLE)
    .select('id, user_id, scopes, expires_at, revoked_at, last_used_at')
    .eq('token_hash', hashToken(bearer))
    .maybeSingle()

  if (error || !data) return { ok: false, reason: 'unknown' }
  if (data.revoked_at) return { ok: false, reason: 'revoked' }

  if (data.expires_at) {
    const expiresMs = new Date(data.expires_at).getTime()
    // Every comparison against NaN is false — an unreadable expiry must not
    // read as "not yet expired" and work forever, same lesson
    // accessCodeUsability's own comment names.
    if (!Number.isFinite(expiresMs) || Date.now() >= expiresMs) {
      return { ok: false, reason: 'expired' }
    }
  }

  await touchLastUsed(admin, data.id, data.last_used_at)

  return { ok: true, userId: data.user_id, scopes: data.scopes ?? [] }
}

/**
 * Stamp last_used_at, throttled to about once a minute per token so a hot
 * polling loop is not a write on every request. Failures are logged, never
 * thrown — a missed "last used" timestamp must not turn a valid credential
 * into a refused request.
 */
async function touchLastUsed(
  admin: AdminClient,
  id: string,
  lastUsedAt: string | null
): Promise<void> {
  if (lastUsedAt) {
    const lastMs = new Date(lastUsedAt).getTime()
    if (Number.isFinite(lastMs) && Date.now() - lastMs < TOUCH_THROTTLE_MS) return
  }
  const { error } = await admin.from(TABLE).update({ last_used_at: new Date().toISOString() }).eq('id', id)
  if (error) console.error('[access:tokens] failed to touch last_used_at', error.message)
}

/**
 * Revoke a token the caller owns. Soft — sets revoked_at rather than
 * deleting the row — so validateToken() can still tell a revoked token apart
 * from one that never existed. Scoped to `userId` so one owner can never
 * revoke another's row even though this runs on the admin client.
 *
 * Returns false when no matching, still-live row was found (already revoked,
 * wrong owner, or unknown id) so the route can answer 404 rather than a
 * false 200.
 */
export async function revokeToken(admin: AdminClient, userId: string, id: string): Promise<boolean> {
  const { data, error } = await admin
    .from(TABLE)
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId)
    .is('revoked_at', null)
    .select('id')
    .maybeSingle()

  if (error) throw new Error(error.message)
  return Boolean(data)
}

interface ApiTokenRow {
  id: string
  name: string
  scopes: string[] | null
  expires_at: string | null
  revoked_at: string | null
  last_used_at: string | null
  created_at: string
}

function rowToRecord(row: ApiTokenRow): ApiTokenRecord {
  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes ?? [],
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  }
}
