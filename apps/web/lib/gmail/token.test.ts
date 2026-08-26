// Tests for lib/gmail/token.ts — minting a Gmail access token from a STORED
// refresh token, and the self-heal path when Google says the grant is dead.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '@/lib/crypto'
import { getGmailAccessToken, hasStoredGmailRefreshToken, refreshGoogleAccessToken } from './token'

const ORIGINAL_CLIENT_ID = process.env.GOOGLE_CLIENT_ID
const ORIGINAL_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET
const ORIGINAL_FETCH = global.fetch

function setGoogleClientEnv() {
  process.env.GOOGLE_CLIENT_ID = 'test-client-id'
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret'
}

beforeEach(() => {
  setGoogleClientEnv()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  if (ORIGINAL_CLIENT_ID === undefined) delete process.env.GOOGLE_CLIENT_ID
  else process.env.GOOGLE_CLIENT_ID = ORIGINAL_CLIENT_ID
  if (ORIGINAL_CLIENT_SECRET === undefined) delete process.env.GOOGLE_CLIENT_SECRET
  else process.env.GOOGLE_CLIENT_SECRET = ORIGINAL_CLIENT_SECRET
  global.fetch = ORIGINAL_FETCH
  vi.restoreAllMocks()
})

function jsonResponse(ok: boolean, body: unknown, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body } as Response
}

describe('hasStoredGmailRefreshToken', () => {
  it('is true only when a non-empty refreshToken string is stored', () => {
    expect(hasStoredGmailRefreshToken({ gmail_sync: { refreshToken: 'enc:abc' } })).toBe(true)
    expect(hasStoredGmailRefreshToken({ gmail_sync: { refreshToken: '' } })).toBe(false)
    expect(hasStoredGmailRefreshToken({ gmail_sync: {} })).toBe(false)
    expect(hasStoredGmailRefreshToken({})).toBe(false)
  })
})

describe('refreshGoogleAccessToken', () => {
  it('returns not_configured when GOOGLE_CLIENT_ID/SECRET are unset', async () => {
    delete process.env.GOOGLE_CLIENT_ID
    delete process.env.GOOGLE_CLIENT_SECRET
    const result = await refreshGoogleAccessToken('refresh-token')
    expect(result).toEqual({ ok: false, reason: 'not_configured', message: expect.any(String) })
  })

  it('exchanges a refresh token for an access token', async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(true, { access_token: 'ya29.fresh', expires_in: 3600 })) as unknown as typeof fetch
    const result = await refreshGoogleAccessToken('a-real-refresh-token')
    expect(result).toEqual({ ok: true, accessToken: 'ya29.fresh' })

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const body = init.body as URLSearchParams
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('a-real-refresh-token')
    expect(body.get('client_id')).toBe('test-client-id')
  })

  it('reports invalid_grant distinctly from other failures', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse(false, { error: 'invalid_grant', error_description: 'Token has been revoked' })
    ) as unknown as typeof fetch
    const result = await refreshGoogleAccessToken('revoked-token')
    expect(result).toEqual({ ok: false, reason: 'invalid_grant', message: 'Token has been revoked' })
  })

  it('a non-invalid_grant HTTP failure is a network_error, not invalid_grant', async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(false, { error: 'server_error' }, 500)) as unknown as typeof fetch
    const result = await refreshGoogleAccessToken('some-token')
    expect(result.ok).toBe(false)
    expect((result as { reason: string }).reason).toBe('network_error')
  })

  it('a thrown fetch (offline) is a network_error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch
    const result = await refreshGoogleAccessToken('some-token')
    expect(result).toEqual({ ok: false, reason: 'network_error', message: 'offline' })
  })
})

/** A minimal fake of the one query shape getGmailAccessToken issues. */
function fakeDb(row: { preferences: Record<string, unknown> }) {
  const writes: Record<string, unknown>[] = []
  const db = {
    from: (_table: string) => ({
      update: (patch: Record<string, unknown>) => ({
        eq: async () => {
          writes.push(patch)
          row.preferences = (patch.preferences as Record<string, unknown>) ?? row.preferences
          return { error: null }
        },
      }),
    }),
  }
  return { db, writes }
}

describe('getGmailAccessToken', () => {
  it('returns not_connected when no refresh token is stored, without ever calling Google', async () => {
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy as unknown as typeof fetch
    const { db } = fakeDb({ preferences: {} })

    const result = await getGmailAccessToken(db, 'user-1', {})
    expect(result).toEqual({ ok: false, reason: 'not_connected', message: expect.any(String) })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('decrypts the stored token, encrypted via the same helper api_keys uses, and mints an access token', async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(true, { access_token: 'ya29.minted' })) as unknown as typeof fetch
    const { db } = fakeDb({ preferences: {} })
    const preferences = { gmail_sync: { refreshToken: encrypt('the-real-refresh-token') } }

    const result = await getGmailAccessToken(db, 'user-1', preferences)
    expect(result).toEqual({ ok: true, accessToken: 'ya29.minted' })

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect((init.body as URLSearchParams).get('refresh_token')).toBe('the-real-refresh-token')
  })

  it('THE POINT: invalid_grant flips monitor off, records revokedAt, and clears the dead token — in one write', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse(false, { error: 'invalid_grant', error_description: 'revoked' })
    ) as unknown as typeof fetch
    const { db, writes } = fakeDb({ preferences: {} })
    const preferences = {
      gmail_permissions: { monitor: { enabled: true, grantedAt: '2026-01-01T00:00:00.000Z', revokedAt: null, migratedFrom: null } },
      gmail_sync: { refreshToken: encrypt('now-revoked-token'), lastSyncDate: '2026-08-01T00:00:00.000Z' },
    }

    const result = await getGmailAccessToken(db, 'user-1', preferences)
    expect(result).toEqual({ ok: false, reason: 'invalid_grant', message: 'revoked' })

    expect(writes).toHaveLength(1)
    const written = writes[0].preferences as Record<string, unknown>
    const gmailPermissions = written.gmail_permissions as { monitor: { enabled: boolean; revokedAt: string | null } }
    expect(gmailPermissions.monitor.enabled).toBe(false)
    expect(gmailPermissions.monitor.revokedAt).not.toBeNull()

    const gmailSync = written.gmail_sync as Record<string, unknown>
    expect(gmailSync.refreshToken).toBeUndefined()
    expect(gmailSync.revokedAt).not.toBeNull()
    // The rest of gmail_sync survives the write — read-modify-write discipline.
    expect(gmailSync.lastSyncDate).toBe('2026-08-01T00:00:00.000Z')
  })

  it('NEVER LOOPS: after self-healing, a second call with the resulting preferences refuses locally, without calling Google again', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(false, { error: 'invalid_grant', error_description: 'revoked' })
    )
    global.fetch = fetchSpy as unknown as typeof fetch
    const { db } = fakeDb({ preferences: {} })
    const preferences = { gmail_sync: { refreshToken: encrypt('dead-token') } }

    const first = await getGmailAccessToken(db, 'user-1', preferences)
    expect(first.ok).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // Simulate the caller re-reading the row it just wrote (no refreshToken left).
    const healedPreferences = { gmail_sync: { revokedAt: new Date().toISOString() } }
    const second = await getGmailAccessToken(db, 'user-1', healedPreferences)
    expect(second).toEqual({ ok: false, reason: 'not_connected', message: expect.any(String) })
    expect(fetchSpy).toHaveBeenCalledTimes(1) // still one — no retry against Google
  })

  it('a successful refresh never writes to the database', async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(true, { access_token: 'ya29.ok' })) as unknown as typeof fetch
    const { db, writes } = fakeDb({ preferences: {} })
    const preferences = { gmail_sync: { refreshToken: encrypt('good-token') } }

    await getGmailAccessToken(db, 'user-1', preferences)
    expect(writes).toEqual([])
  })
})
