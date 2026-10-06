import { describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

// Throws unless a test hands it a session, so a page that must answer before
// the session is read (a retired page, a fixture) proves it by never reaching this.
const readSession = vi.hoisted(() =>
  vi.fn(async (): Promise<{ response: unknown; user: unknown }> => {
    throw new Error('a retired page must redirect before the session is read')
  }),
)

vi.mock('@/lib/supabase/middleware', () => ({
  updateSession: () => readSession(),
}))

import { middleware, RETIRED_PAGES } from './middleware'

describe('retired pages', () => {
  it('sends the prep page to Today', () => {
    expect(RETIRED_PAGES.prep).toBe('/dashboard')
  })

  it.each(Object.entries(RETIRED_PAGES))('%s and its sub-paths answer 307 to %s before auth', async (segment, to) => {
    for (const path of [`/${segment}`, `/${segment}/abc-123`]) {
      const res = await middleware(new NextRequest(`http://localhost${path}`))
      expect(res.status).toBe(307)
      expect(new URL(res.headers.get('location')!).pathname).toBe(to)
    }
  })

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])('does not treat /%s as a retired page', async (name) => {
    // Falling through to the session read (mocked to throw) proves no redirect.
    await expect(middleware(new NextRequest(`http://localhost/${name}`))).rejects.toThrow('a retired page must redirect')
  })
})

describe('fixture pages', () => {
  it('answers 404 without the flag, before the session is read', async () => {
    vi.stubEnv('CELLO_FIXTURES', '')
    vi.stubEnv('VERCEL_ENV', 'production')
    const res = await middleware(new NextRequest('http://localhost/fixtures/today'))
    expect(res.status).toBe(404)
    vi.unstubAllEnvs()
  })

  it('lets them through on a fixture build and on a preview, with no session', async () => {
    vi.stubEnv('CELLO_FIXTURES', '1')
    expect((await middleware(new NextRequest('http://localhost/fixtures/today'))).status).toBe(200)
    vi.stubEnv('CELLO_FIXTURES', '')
    vi.stubEnv('VERCEL_ENV', 'preview')
    expect((await middleware(new NextRequest('http://localhost/fixtures/roles'))).status).toBe(200)
    vi.unstubAllEnvs()
  })
})

describe('Landing and the first-run page', () => {
  it('sends the old onboarding address to Welcome', async () => {
    const res = await middleware(new NextRequest('http://localhost/onboarding'))
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get('location')!).pathname).toBe('/welcome')
  })

  it('does not redirect a signed-out visitor away from Landing', async () => {
    readSession.mockResolvedValueOnce({ response: NextResponse.next(), user: null })
    const res = await middleware(new NextRequest('http://localhost/'))
    expect(res.status).toBe(200)
    expect(res.headers.get('location')).toBeNull()
  })

  it('still sends a signed-out visitor to sign in from any other page', async () => {
    readSession.mockResolvedValueOnce({ response: NextResponse.next(), user: null })
    const res = await middleware(new NextRequest('http://localhost/roles'))
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login')
  })
})
