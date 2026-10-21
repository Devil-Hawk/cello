import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const followMock = vi.fn()
const unfollowMock = vi.fn()

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) } }) }))
const admin = vi.fn((): unknown => ({ admin: true }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => admin() }))
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

  it('writes one follow timing row per call, and still answers when the timing insert throws', async () => {
    followMock.mockResolvedValue({ ok: true })
    const insert = vi.fn(async () => ({ error: null }))
    admin.mockImplementation(() => ({ from: () => ({ insert }) }))
    expect((await POST(req('POST', { 'content-type': 'application/json' }, { employerId: ID }))).status).toBe(200)
    expect(insert).toHaveBeenCalledWith({ route: 'follow', ms: expect.any(Number), ok: true })

    admin.mockImplementation(() => ({ from: () => { throw new Error('insert failed') } }))
    const res = await POST(req('POST', { 'content-type': 'application/json' }, { employerId: ID }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    admin.mockImplementation(() => ({ admin: true }))
    followMock.mockReset()
  })

  it('refuses a follow or an unfollow with no employer id, a bad id, or a dream flag that is not a boolean', async () => {
    const bad = [{}, { employerId: 'nope' }, { employerId: ID, dream: 'yes' }]
    for (const body of bad) {
      expect((await POST(req('POST', { 'content-type': 'application/json' }, body))).status, JSON.stringify(body)).toBe(400)
      expect((await DELETE(req('DELETE', { 'content-type': 'application/json' }, { employerId: 'nope' }))).status).toBe(400)
    }
    const notJson = new NextRequest('http://localhost/api/companies/follow', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' })
    expect((await POST(notJson)).status).toBe(400)
    expect(followMock).not.toHaveBeenCalled()
    expect(unfollowMock).not.toHaveBeenCalled()
  })
})
