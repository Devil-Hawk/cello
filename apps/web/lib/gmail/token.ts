// Server-side Gmail access-token minting from a STORED refresh token.
//
// WHY THIS FILE EXISTS
//   Supabase hands back provider_token/provider_refresh_token only at the
//   moment of the OAuth redirect. provider_token itself is dead in about an
//   hour, and Supabase does not refresh it for you in the background — so
//   any sync that runs outside an active browser tab (a cron, a retry, this
//   same route five minutes later) has nothing to call Gmail with unless
//   something captured the refresh token and can exchange it again. That
//   capture happens once, at app/auth/callback/route.ts, into
//   preferences.gmail_sync.refreshToken (encrypted the same way api_keys
//   are — see lib/crypto.ts). This file is the other end: turn that stored
//   token back into a live access token, and self-heal when Google says the
//   grant is dead.
//
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET must be the SAME OAuth client
// Supabase's own Google provider is configured with (Supabase Dashboard ->
// Authentication -> Providers -> Google) — Google refuses to refresh a
// token issued under a different client_id.

import type { Json } from '@cello/shared'
import { decrypt, isEncrypted } from '@/lib/crypto'
import { applyGmailPermissionChange } from '@/lib/gmail/permissions'
import type { SyncState } from '@/lib/gmail/types'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

/**
 * True when a Gmail refresh token is stored for this account — the
 * prerequisite for sync running outside an active browser tab (cron, a
 * retry, this route an hour later). Never reveals the token itself; callers
 * surfacing account state to a client (e.g. GET /api/gmail/permissions) use
 * this instead of exposing `gmail_sync` directly.
 */
export function hasStoredGmailRefreshToken(preferences: Record<string, unknown>): boolean {
  const syncState = (preferences.gmail_sync || {}) as SyncState
  return typeof syncState.refreshToken === 'string' && syncState.refreshToken.length > 0
}

export type GmailAccessTokenResult =
  | { ok: true; accessToken: string }
  /** No refresh token stored yet — caller should fall back to session.provider_token if it has one. */
  | { ok: false; reason: 'not_connected'; message: string }
  | { ok: false; reason: 'not_configured'; message: string }
  /** Google revoked the grant (user removed Cello's access, password change, etc). Self-healed: monitor is now off. */
  | { ok: false; reason: 'invalid_grant'; message: string }
  | { ok: false; reason: 'network_error'; message: string }

/**
 * Raw call against Google's token endpoint. Pure — no DB, no Supabase — so
 * it is unit-testable with a mocked `fetch` alone.
 */
export async function refreshGoogleAccessToken(refreshToken: string): Promise<GmailAccessTokenResult> {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    return {
      ok: false,
      reason: 'not_configured',
      message: 'GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are not set — a stored Gmail refresh token cannot be exchanged server-side.',
    }
  }

  let res: Response
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    })
  } catch (err) {
    return { ok: false, reason: 'network_error', message: err instanceof Error ? err.message : 'network error contacting Google' }
  }

  let body: { access_token?: string; error?: string; error_description?: string } = {}
  try {
    body = await res.json()
  } catch {
    // Leave body empty — handled by the checks below, which treat a missing
    // access_token / unrecognized error the same as an unparseable one.
  }

  if (!res.ok) {
    if (body.error === 'invalid_grant') {
      return { ok: false, reason: 'invalid_grant', message: body.error_description || 'Google refused this refresh token — the grant was revoked.' }
    }
    return { ok: false, reason: 'network_error', message: body.error_description || `Google token endpoint returned ${res.status}` }
  }

  if (!body.access_token) {
    return { ok: false, reason: 'network_error', message: 'Google token endpoint returned no access_token' }
  }

  return { ok: true, accessToken: body.access_token }
}

/**
 * The end-to-end helper the sync route (and the future cron) call: read the
 * stored, encrypted refresh token out of `preferences.gmail_sync.refreshToken`,
 * decrypt it, exchange it for a fresh access token — and on `invalid_grant`,
 * self-heal by flipping "monitor" off and recording `revokedAt`/clearing the
 * dead token, through the SAME applyGmailPermissionChange every other writer
 * of this state uses, so the grant state and the token move together. This
 * makes the failure honest and terminal: the next call sees no stored token
 * at all (`not_connected`), never a loop of retrying a token Google has
 * already killed.
 *
 * `preferences` is the CALLER's already-read copy — this does exactly one
 * write, and only on the invalid_grant path.
 *
 * `db` is structurally typed (not `SupabaseClient`) for the same reason
 * lib/harness/keys.ts's readProfileForDemoGuards is: a precise structural
 * shape is enough for what this does (one `.update().eq()`) and avoids
 * tsc chasing supabase-js's query-builder generics into TS2589.
 */
export async function getGmailAccessToken(
  db: { from: (table: string) => any },
  userId: string,
  preferences: Record<string, unknown>
): Promise<GmailAccessTokenResult> {
  const syncState = (preferences.gmail_sync || {}) as SyncState
  const stored = syncState.refreshToken
  if (!stored) {
    return { ok: false, reason: 'not_connected', message: 'No Gmail refresh token stored for this account yet.' }
  }

  let refreshToken: string
  try {
    refreshToken = isEncrypted(stored) ? decrypt(stored) : stored
  } catch (err) {
    console.error(`gmail/token: failed to decrypt stored refresh token for ${userId}`, err)
    return { ok: false, reason: 'invalid_grant', message: 'Stored Gmail refresh token could not be decrypted.' }
  }

  const result = await refreshGoogleAccessToken(refreshToken)
  if (result.ok || result.reason !== 'invalid_grant') return result

  // Self-heal: the grant is dead. Turn "monitor" off and drop the token, in
  // the SAME write, so a half-updated row can never claim monitor is on with
  // no way to act on it, or vice versa.
  const now = new Date().toISOString()
  const withMonitorOff = applyGmailPermissionChange(preferences, 'monitor', false, now)
  const nextGmailSync: SyncState = { ...syncState, revokedAt: now }
  delete nextGmailSync.refreshToken

  const { error } = await db
    .from('profiles')
    .update({ preferences: { ...withMonitorOff, gmail_sync: nextGmailSync } as unknown as Json })
    .eq('id', userId)

  if (error) {
    console.error(`gmail/token: failed to record revoked Gmail grant for ${userId} — ${error.message}`)
  }

  return result
}
