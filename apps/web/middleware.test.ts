import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/middleware', () => ({
  updateSession: async () => {
    throw new Error('a retired page must redirect before the session is read')
  },
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
