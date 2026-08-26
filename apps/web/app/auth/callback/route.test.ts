// The one place a Google `provider_refresh_token` is ever seen — persisting
// it (encrypted, same helper as api_keys) alongside the "monitor mailbox"
// grant it belongs to, and only when Google's session actually carries the
// gmail.readonly scope. Everything else (identity-only sign-in, a "send"-only
// grant, a write the demo lockdown trigger refuses) must be a no-op that
// still redirects — this is best-effort, never allowed to block sign-in.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { isEncrypted, decrypt } from '@/lib/crypto'

const exchangeCodeForSession = vi.fn()
let profileRow: Record<string, unknown> | null
let writeError: { code?: string; message?: string } | null
const writes: Record<string, unknown>[] = []
const reads: string[] = []

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}))

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { exchangeCodeForSession: (...args: unknown[]) => exchangeCodeForSession(...args) },
    from: (_table: string) => ({
      select: (columns: string) => {
        reads.push(columns)
        return {
          eq: () => ({
            maybeSingle: async () => ({ data: profileRow, error: null }),
          }),
        }
      },
      update: (patch: Record<string, unknown>) => ({
        eq: async () => {
          if (writeError) return { data: null, error: writeError }
          writes.push(patch)
          profileRow = { ...(profileRow ?? {}), ...patch }
          return { data: null, error: null }
        },
      }),
    }),
  }),
}))

import { GET } from './route'

const ORIGINAL_FETCH = global.fetch
const READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

/** Controls what Google's tokeninfo endpoint (fetchGrantedGoogleScopes) reports. */
function mockGrantedScopes(scopes: string[]) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ scope: scopes.join(' ') }),
  }) as unknown as typeof fetch
}

function request() {
  return new NextRequest('http://localhost/auth/callback?code=abc123')
}

beforeEach(() => {
  profileRow = { preferences: { model: 'gpt-5' } }
  writeError = null
  writes.length = 0
  reads.length = 0
  exchangeCodeForSession.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  global.fetch = ORIGINAL_FETCH
  vi.restoreAllMocks()
})

describe('GET /auth/callback', () => {
  it('redirects to /dashboard with no code param, touching nothing', async () => {
    exchangeCodeForSession.mockResolvedValue({ data: {}, error: null })
    const response = await GET(new NextRequest('http://localhost/auth/callback'))
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toContain('/dashboard')
    expect(exchangeCodeForSession).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  it('identity-only sign-in (no provider_refresh_token) never touches the profile', async () => {
    exchangeCodeForSession.mockResolvedValue({
      data: { user: { id: 'user-1' }, session: { provider_token: 'ya29.x', provider_refresh_token: null } },
      error: null,
    })
    const response = await GET(request())
    expect(response.status).toBe(307)
    expect(reads).toEqual([])
    expect(writes).toEqual([])
  })

  it('a refresh token present but the LIVE scope does not include gmail.readonly (e.g. "send" grant) writes nothing', async () => {
    mockGrantedScopes(['https://www.googleapis.com/auth/gmail.send'])
    exchangeCodeForSession.mockResolvedValue({
      data: { user: { id: 'user-1' }, session: { provider_token: 'ya29.x', provider_refresh_token: 'refresh-1' } },
      error: null,
    })
    const response = await GET(request())
    expect(response.status).toBe(307)
    expect(writes).toEqual([])
  })

  it('THE POINT: gmail.readonly granted + a refresh token persists it encrypted and records the monitor grant in one write', async () => {
    mockGrantedScopes([READONLY_SCOPE])
    exchangeCodeForSession.mockResolvedValue({
      data: { user: { id: 'user-1' }, session: { provider_token: 'ya29.x', provider_refresh_token: 'the-raw-refresh-token' } },
      error: null,
    })
    profileRow = { preferences: { model: 'gpt-5', budget: { monthlyUsd: 10 } } }

    const response = await GET(request())
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toContain('/dashboard')

    expect(writes).toHaveLength(1)
    const preferences = writes[0].preferences as Record<string, unknown>

    // Never the raw token, anywhere in the write.
    expect(JSON.stringify(preferences)).not.toContain('the-raw-refresh-token')

    const gmailSync = preferences.gmail_sync as { refreshToken: string; revokedAt: string | null }
    expect(isEncrypted(gmailSync.refreshToken)).toBe(true)
    expect(decrypt(gmailSync.refreshToken)).toBe('the-raw-refresh-token')
    expect(gmailSync.revokedAt).toBeNull()

    const monitor = (preferences.gmail_permissions as { monitor: { enabled: boolean; grantedAt: string | null } }).monitor
    expect(monitor.enabled).toBe(true)
    expect(monitor.grantedAt).toEqual(expect.any(String))

    // Untouched neighbours survive the read-modify-write.
    expect(preferences.model).toBe('gpt-5')
    expect(preferences.budget).toEqual({ monthlyUsd: 10 })
  })

  it('a write the demo lockdown trigger refuses (42501) is swallowed — sign-in still completes', async () => {
    mockGrantedScopes([READONLY_SCOPE])
    writeError = { code: '42501', message: 'demo profiles cannot change Gmail sync state' }
    exchangeCodeForSession.mockResolvedValue({
      data: { user: { id: 'demo-1' }, session: { provider_token: 'ya29.x', provider_refresh_token: 'refresh-2' } },
      error: null,
    })

    const response = await GET(request())
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toContain('/dashboard')
  })

  it('an exchange error skips persistence entirely', async () => {
    exchangeCodeForSession.mockResolvedValue({ data: {}, error: { message: 'bad code' } })
    const response = await GET(request())
    expect(response.status).toBe(307)
    expect(reads).toEqual([])
    expect(writes).toEqual([])
  })
})
