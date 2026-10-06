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
})
