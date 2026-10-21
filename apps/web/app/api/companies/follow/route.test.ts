import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const followMock = vi.fn()
const unfollowMock = vi.fn()

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) } }) }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({ admin: true }) }))
vi.mock('@/lib/companies/read-employer', () => ({ loadPerson: async () => [] }))
vi.mock('@/lib/companies/follow', () => ({
  followAndRead: (...args: unknown[]) => followMock(...args),
  unfollowEmployer: (...args: unknown[]) => unfollowMock(...args),
}))

import { DELETE, POST } from './route'

const ID = '11111111-1111-4111-8111-111111111111'
const crossSite = { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }
const req = (method: string, headers: Record<string, string>, body: unknown) =>
  new NextRequest('http://localhost/api/companies/follow', { method, headers, body: JSON.stringify(body) })

describe('/api/companies/follow cross-site refusal', () => {
  it('refuses a cross-site follow and a cross-site unfollow before anything is written', async () => {
    expect((await POST(req('POST', crossSite, { employerId: ID }))).status).toBe(403)
    expect((await DELETE(req('DELETE', crossSite, { employerId: ID }))).status).toBe(403)
    expect(followMock).not.toHaveBeenCalled()
    expect(unfollowMock).not.toHaveBeenCalled()
  })
})
