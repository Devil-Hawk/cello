import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { isEncrypted } from '@/lib/crypto'

let user: { id: string } | null
let profile: Record<string, unknown> | null
let writeError: { code?: string; message?: string } | null
const writes: Record<string, unknown>[] = []

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user } }) },
    from: () => ({
      update: (patch: Record<string, unknown>) => ({
        eq: async () => {
          if (writeError) return { error: writeError }
          writes.push(patch)
          return { error: null }
        },
      }),
    }),
  }),
}))

vi.mock('@/lib/harness/keys', () => ({
  readProfileForDemoGuards: async () => ({ row: profile, error: null }),
}))

import { GET } from './route'

const REAL_FETCH = global.fetch
const exchange = vi.fn()

const cookie = (v: unknown) => `cello_or_pkce=${encodeURIComponent(JSON.stringify(v))}`

function call(query = 'code=abc', cookieValue: string | null = cookie({ v: 'the-verifier', r: '/welcome' })) {
  return GET(
    new NextRequest(`http://localhost/api/auth/openrouter/callback?${query}`, {
      headers: cookieValue ? { cookie: cookieValue } : {},
    }),
  )
}

const location = (res: Response) => {
  const to = new URL(res.headers.get('location')!)
  return to.pathname + to.search
}

beforeEach(() => {
  user = { id: 'u1' }
  profile = { id: 'u1', is_demo: false, demo_expires_at: null, preferences: { model: 'x' } }
  writeError = null
  writes.length = 0
  exchange.mockReset()
  exchange.mockResolvedValue({ ok: true, json: async () => ({ key: 'sk-or-v1-PLACEHOLDER' }) })
  global.fetch = exchange as unknown as typeof fetch
})
afterEach(() => {
  global.fetch = REAL_FETCH
})

describe('GET /api/auth/openrouter/callback', () => {
  it('answers 400 with no cookie', async () => {
    const res = await call('code=abc', null)
    expect(res.status).toBe(400)
    expect(exchange).not.toHaveBeenCalled()
  })

  it('exchanges the code with the verifier and stores the key encrypted', async () => {
    const res = await call()
    expect(res.status).toBe(303)
    expect(location(res)).toBe('/welcome?models=free')
    const [url, init] = exchange.mock.calls[0]
    expect(url).toBe('https://openrouter.ai/api/v1/auth/keys')
    expect(JSON.parse(init.body)).toEqual({ code: 'abc', code_verifier: 'the-verifier', code_challenge_method: 'S256' })
    const saved = (writes[0].preferences as { api_keys: { openrouter: string } }).api_keys.openrouter
    expect(isEncrypted(saved)).toBe(true)
    expect(saved).not.toContain('sk-or-v1-PLACEHOLDER')
    expect((writes[0].preferences as Record<string, unknown>).model).toBe('x')
  })

  it('does not save a key that does not start sk-or-', async () => {
    exchange.mockResolvedValue({ ok: true, json: async () => ({ key: 'sk-other-123' }) })
    const res = await call()
    expect(location(res)).toBe('/welcome?models=failed')
    expect(writes).toEqual([])
  })

  it('refuses a demo and never calls OpenRouter for it', async () => {
    profile = { id: 'u1', is_demo: true, demo_expires_at: new Date(Date.now() + 3600_000).toISOString(), preferences: {} }
    const res = await call()
    expect(location(res)).toBe('/welcome?models=failed')
    expect(exchange).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  it('refuses when the profile cannot be read', async () => {
    profile = null
    expect(location(await call())).toBe('/welcome?models=failed')
    expect(writes).toEqual([])
  })

  it('clears the cookie on every outcome', async () => {
    for (const res of [await call(), await call('')]) {
      expect(res.headers.get('set-cookie')).toMatch(/cello_or_pkce=;/)
      expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/i)
    }
  })

  it('fails when OpenRouter refuses the exchange', async () => {
    exchange.mockResolvedValue({ ok: false, json: async () => ({}) })
    expect(location(await call())).toBe('/welcome?models=failed')
  })

  it('sends a return path off the allowlist to Welcome', async () => {
    const res = await call('code=abc', cookie({ v: 'v', r: 'https://evil.example/x' }))
    expect(location(res)).toBe('/welcome?models=free')
  })

  it('goes back to Settings when that is where it started', async () => {
    expect(location(await call('code=abc', cookie({ v: 'v', r: '/settings' })))).toBe('/settings?models=free')
  })

  it('sends a signed-out visitor to sign in', async () => {
    user = null
    expect(new URL((await call()).headers.get('location')!).pathname).toBe('/login')
  })
})
