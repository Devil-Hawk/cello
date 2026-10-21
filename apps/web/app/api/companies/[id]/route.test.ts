import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

let user: { id: string } | null = { id: 'u1' }
let page: unknown = { employerId: 'e1', name: 'Retell AI' }
const calls: unknown[][] = []

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user }, error: null }) } }) }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/companies', () => ({
  companyPage: async (_db: unknown, userId: string, id: string) => (calls.push(['page', userId, id]), page),
  companyRoles: async (_db: unknown, userId: string, id: string, q: string) => (calls.push(['roles', userId, id, q]), [{ id: 'j1', title: 'Data Engineer' }]),
}))

import { GET } from './route'
import { GET as GET_ROLES } from './roles/route'

const ID = '0b6f9f7e-6c1d-4a39-8d55-1f0d2e8c9a11'
const get = (id: string) => GET(new NextRequest(`http://localhost/api/companies/${id}`), { params: { id } })
const roles = (id: string, qs = '') => GET_ROLES(new NextRequest(`http://localhost/api/companies/${id}/roles${qs}`), { params: { id } })

beforeEach(() => {
  user = { id: 'u1' }
  page = { employerId: 'e1', name: 'Retell AI' }
  calls.length = 0
})

describe('GET /api/companies/[id]', () => {
  it('refuses a caller who is not signed in', async () => {
    user = null
    expect((await get(ID)).status).toBe(401)
    expect((await roles(ID)).status).toBe(401)
    expect(calls).toEqual([])
  })

  it('returns the employer for the signed-in person', async () => {
    const res = await get(ID)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, employerId: 'e1', name: 'Retell AI' })
    expect(calls).toEqual([['page', 'u1', ID]])
  })

  it('is 404 for an id that is not one, and for an employer the directory does not hold', async () => {
    expect((await get('not-an-id')).status).toBe(404)
    expect(calls).toEqual([])
    page = null
    expect((await get(ID)).status).toBe(404)
  })
})

describe('GET /api/companies/[id]/roles', () => {
  it('searches inside the employer for the signed-in person', async () => {
    const res = await roles(ID, '?q=%20spark%20')
    expect(await res.json()).toEqual({ ok: true, query: 'spark', roles: [{ id: 'j1', title: 'Data Engineer' }] })
    expect(calls).toEqual([['roles', 'u1', ID, ' spark ']])
  })

  it('lists every role without a search, refuses a long search and a bad id', async () => {
    expect((await roles(ID)).status).toBe(200)
    expect(calls[0]).toEqual(['roles', 'u1', ID, ''])
    expect((await roles(ID, `?q=${'a'.repeat(121)}`)).status).toBe(400)
    expect((await roles('nope')).status).toBe(404)
    expect(calls).toHaveLength(1)
  })
})
