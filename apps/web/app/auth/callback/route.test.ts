// /auth/callback: two things that were wrong:
//   - the Google refresh token was only kept when gmail.readonly was granted, so a
//     send-only user had nothing to send with once the one-hour token died;
//   - ?next= was ignored, so the incremental Gmail grant started in Settings
//     landed on the dashboard.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { decrypt } from '@/lib/crypto'

const SEND = 'https://www.googleapis.com/auth/gmail.send'
const READ = 'https://www.googleapis.com/auth/gmail.readonly'

let scopes: string[]
let session: { provider_token?: string; provider_refresh_token?: string } | null
let preferences: Record<string, unknown>
let writes: Record<string, unknown>[]

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }))
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      exchangeCodeForSession: async () => ({ data: { user: { id: 'user-1' }, session }, error: null }),
    },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { preferences }, error: null }) }) }),
      update: (patch: Record<string, unknown>) => ({
        eq: async () => {
          writes.push(patch)
          return { error: null }
        },
      }),
    }),
  }),
}))
vi.mock('@/lib/gmail/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/gmail/permissions')>()),
  fetchGrantedGoogleScopes: async () => scopes,
}))

import { GET } from './route'

function callback(query: string) {
  return GET(new NextRequest(`http://localhost:3000/auth/callback${query}`))
}

const saved = () => (writes[0]?.preferences ?? {}) as Record<string, any>

beforeEach(() => {
  scopes = []
  session = { provider_token: 'google-access', provider_refresh_token: 'google-refresh' }
  preferences = {}
  writes = []
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('persisting the Google refresh token', () => {
  it('keeps it for a SEND-only grant, encrypted, without switching any permission on', async () => {
    scopes = [SEND]
    preferences = { api_keys: { openrouter: 'enc:x' } }

    await callback('?code=abc')

    expect(writes).toHaveLength(1)
    expect(decrypt(saved().gmail_sync.refreshToken)).toBe('google-refresh')
    expect(saved().gmail_sync.revokedAt).toBeNull()
    expect(saved().gmail_permissions).toBeUndefined() // the send toggle stays the user's own
    expect(saved().api_keys).toEqual({ openrouter: 'enc:x' })
  })

  it('still keeps it for the monitor grant, and records that tier as before', async () => {
    scopes = [READ]

    await callback('?code=abc')

    expect(decrypt(saved().gmail_sync.refreshToken)).toBe('google-refresh')
    expect(saved().gmail_permissions.monitor.enabled).toBe(true)
  })

  it('stores nothing for an identity-only sign-in (no Gmail scope granted)', async () => {
    scopes = ['openid', 'email']
    await callback('?code=abc')
    expect(writes).toEqual([])
  })

  it('stores nothing when Google handed back no refresh token', async () => {
    scopes = [SEND]
    session = { provider_token: 'google-access' }
    await callback('?code=abc')
    expect(writes).toEqual([])
  })
})

describe('where the user lands', () => {
  it('goes to the dashboard by default', async () => {
    const res = await callback('?code=abc')
    expect(new URL(res.headers.get('location')!).pathname).toBe('/dashboard')
  })

  it('goes back to a same-site next path, query included', async () => {
    const res = await callback('?code=abc&next=%2Fsettings%3Ftab%3Dconnections')
    const to = new URL(res.headers.get('location')!)
    expect(to.origin).toBe('http://localhost:3000')
    expect(to.pathname + to.search).toBe('/settings?tab=connections')
  })

  it.each(['https://evil.example/', '//evil.example/', '/\\evil.example', '/\t/evil.example'])(
    'ignores the off-site next %s',
    async (next) => {
      const res = await callback(`?code=abc&next=${encodeURIComponent(next)}`)
      const to = new URL(res.headers.get('location')!)
      expect(to.origin).toBe('http://localhost:3000')
      expect(to.pathname).toBe('/dashboard')
      expect(to.hostname).not.toBe('evil.example')
    }
  )
})
