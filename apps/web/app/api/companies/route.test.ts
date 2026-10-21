import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const pages: Record<string, unknown>[] = []
vi.mock('@/lib/companies', async (original) => ({
  ...(await original<typeof import('@/lib/companies')>()),
  companiesPage: async (_db: unknown, userId: string, opts: Record<string, unknown>) => (pages.push({ userId, ...opts }), { header: { following: 1 }, rows: [{ employerId: 'e1' }], limit: opts.limit, offset: opts.offset }),
}))

let user: { id: string } | null = { id: 'u1' }
const rpcs: { name: string; args: Record<string, unknown> }[] = []
const pendingQueries: string[] = []

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user }, error: null }) } }) }))
vi.mock('@/lib/harness/supabase-admin', () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args })
      return { data: name === 'search_company_directory' ? [{ id: 'e1', name: 'Retell AI', name_norm: 'retell ai', domain: 'retellai.com' }] : [{ id: 'e1', name: 'Retell AI' }], error: null }
    },
    from: () => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (c: string, v: string) => (pendingQueries.push(`${c}=${v}`), b),
        like: (c: string, v: string) => (pendingQueries.push(`${c} like ${v}`), b),
        limit: async () => ({ data: [{ id: 'c1', name: 'Retell Labs', domain: null }, { id: 'c2', name: 'Retell AI', domain: 'retellai.com' }], error: null }),
      }
      return b
    },
  }),
}))

import { GET } from './route'

const get = (qs = '') => GET(new NextRequest(`http://localhost/api/companies${qs}`))

beforeEach(() => {
  user = { id: 'u1' }
  rpcs.length = 0
  pendingQueries.length = 0
  pages.length = 0
})

describe('GET /api/companies', () => {
  it('refuses a caller who is not signed in', async () => {
    user = null
    expect((await get()).status).toBe(401)
    expect(rpcs).toEqual([])
  })

  it('returns the wall for the signed-in person a page at a time and clamps the page', async () => {
    const res = await get('?limit=9999&offset=-4')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, header: { following: 1 }, rows: [{ employerId: 'e1' }], limit: 100, offset: 0 })
    expect(pages[0]).toEqual({ userId: 'u1', type: undefined, showClosed: false, limit: 100, offset: 0 })
  })

  it('passes a role type and show_closed through, and refuses a type that is not one', async () => {
    expect((await get('?type=forward-deployed-engineer&show_closed=1&limit=20&offset=40')).status).toBe(200)
    expect(pages[0]).toEqual({ userId: 'u1', type: 'forward-deployed-engineer', showClosed: true, limit: 20, offset: 40 })
    expect((await get('?type=wizard')).status).toBe(400)
    expect(pages).toHaveLength(1)
  })

  it('refuses a search longer than 120 characters', async () => {
    expect((await get(`?q=${'a'.repeat(121)}`)).status).toBe(400)
    expect(rpcs).toEqual([])
  })

  it('searches verified employers, and shows a waiting candidate as not checked, never one already listed', async () => {
    const body = await (await get('?q=retell')).json()
    expect(body.employers.map((e: { name: string }) => e.name)).toEqual(['Retell AI'])
    expect(body.notChecked).toEqual([{ id: 'c1', name: 'Retell Labs', domain: null }])
    expect(pendingQueries).toContain('state=pending')
    expect(pendingQueries).toContain('name_norm like retell%')
  })

  it('answers an empty search with nothing, and reads nothing for it', async () => {
    const body = await (await get('?q=%20')).json()
    expect(body).toMatchObject({ employers: [], notChecked: [] })
    expect(rpcs).toEqual([])
  })
})
