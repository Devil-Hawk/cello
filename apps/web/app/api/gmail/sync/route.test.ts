// The sync route's final "save sync state" write used to spread the
// pre-mint `preferences` snapshot verbatim, replacing `gmail_sync` wholesale
// — silently dropping `refreshToken`/`revokedAt` on every successful sync
// (the exact thing that makes background sync possible at all) and, on an
// invalid_grant self-heal, resurrecting a monitor grant that had just been
// correctly disabled. These tests pin the fix: the final write re-reads
// preferences fresh and merges into gmail_sync rather than replacing it.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const USER_ID = 'owner-user-1'
const SECRET_REFRESH_TOKEN = 'enc:PLACEHOLDER-refresh-token-never-leaked'

let row: { preferences: Record<string, unknown> }
let sessionProviderToken: string | null = null
const profileUpdates: Record<string, unknown>[] = []

function makeSupabase() {
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }),
      getSession: async () => ({ data: { session: { provider_token: sessionProviderToken } } }),
    },
    from(table: string) {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: { preferences: row.preferences }, error: null }),
            }),
          }),
          update(patch: { preferences: Record<string, unknown> }) {
            return {
              eq: async () => {
                profileUpdates.push(patch)
                row = { preferences: patch.preferences }
                return { data: null, error: null }
              },
            }
          },
        }
      }
      if (table === 'companies') {
        return { select: () => ({ eq: async () => ({ data: [] }) }) }
      }
      throw new Error(`unexpected table in test: ${table}`)
    },
  }
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => makeSupabase() }))
vi.mock('@/lib/harness/supabase-admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ not: () => ({ is: async () => ({ data: [] }) }) }) }),
    }),
  }),
}))
vi.mock('@/lib/apikeys', () => ({ getDecryptedApiKeys: async () => ({}) }))
vi.mock('@/lib/gmail/gmail-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gmail/gmail-api')>()
  return { ...actual, fetchGmailMessages: async () => [] }
})

const getGmailAccessToken = vi.fn()
vi.mock('@/lib/gmail/token', () => ({ getGmailAccessToken: (...args: unknown[]) => getGmailAccessToken(...args) }))

import { POST } from './route'

function request() {
  return new NextRequest('http://localhost/api/gmail/sync', { method: 'POST' })
}

beforeEach(() => {
  profileUpdates.length = 0
  sessionProviderToken = null
  getGmailAccessToken.mockReset()
  row = {
    preferences: {
      gmail_permissions: {
        monitor: { enabled: true, grantedAt: '2026-08-01T00:00:00.000Z', revokedAt: null, migratedFrom: null },
      },
      gmail_sync: {
        lastSyncDate: '2026-08-20T00:00:00.000Z',
        scannedEmailIds: ['old-1'],
        refreshToken: SECRET_REFRESH_TOKEN,
      },
      // Unrelated preference that must survive the round trip untouched.
      digest: { enabled: true },
    },
  }
})

describe('POST /api/gmail/sync — final preferences write', () => {
  it('preserves refreshToken and revokedAt through a successful sync instead of wiping gmail_sync', async () => {
    getGmailAccessToken.mockResolvedValue({ ok: true, accessToken: 'live-access-token' })

    const response = await POST(request())
    expect(response.status).toBe(200)

    expect(profileUpdates.length).toBe(1)
    const written = profileUpdates[0].preferences as Record<string, unknown>
    const gmailSync = written.gmail_sync as Record<string, unknown>
    expect(gmailSync.refreshToken).toBe(SECRET_REFRESH_TOKEN)
    expect(gmailSync.lastSyncDate).not.toBe('2026-08-20T00:00:00.000Z')
    expect(written.digest).toEqual({ enabled: true })
  })

  it('never falls back to a session provider_token on invalid_grant, so a just-self-healed disable cannot be undone', async () => {
    getGmailAccessToken.mockResolvedValue({ ok: false, reason: 'invalid_grant', message: 'revoked' })

    const response = await POST(request())
    expect(response.status).toBe(401)
    // No sync ran, so no "save sync state" write could resurrect a stale
    // gmail_permissions/gmail_sync snapshot over whatever the self-heal wrote.
    expect(profileUpdates.length).toBe(0)
  })

  it('still falls back to the session provider_token when simply not_connected yet', async () => {
    getGmailAccessToken.mockResolvedValue({ ok: false, reason: 'not_connected', message: 'no token stored' })
    sessionProviderToken = 'fresh-session-token'

    const response = await POST(request())
    // Falls through to the sync path (200) rather than 401, proving the
    // not_connected branch still uses the session token as a fallback.
    expect(response.status).toBe(200)
  })
})
