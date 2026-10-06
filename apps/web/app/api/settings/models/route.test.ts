// Settings > Models backend: no session is refused, a ceiling that is not a rung is
// refused, credit_bought goes through set_autonomy merged into the current pipeline,
// and the ceiling and order are saved beside the rest of preferences.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

let user: { id: string; email: string } | null
let preferences: Record<string, unknown>
const rpc = vi.fn(async (..._args: unknown[]) => ({ error: null as { code?: string } | null }))
const updates: Record<string, unknown>[] = []

const supabase = {
  auth: {
    getUser: async () => ({ data: { user }, error: null }),
    getSession: async () => ({ data: { session: null }, error: null }),
  },
  rpc: (...args: unknown[]) => rpc(...args),
  from: () => ({
    select: () => ({ eq: () => ({ single: async () => ({ data: { preferences }, error: null }) }) }),
    update: (patch: Record<string, unknown>) => ({
      eq: async () => {
        updates.push(patch)
        return { error: null }
      },
    }),
  }),
}
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabase }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/harness/keys', () => ({
  readProfileForDemoGuards: async () => ({ row: { is_demo: false, demo_expires_at: null }, error: null }),
}))

import { GET, PUT } from './route'

const put = (body: unknown) =>
  PUT(new NextRequest('http://localhost/api/settings/models', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }))

beforeEach(() => {
  user = { id: 'user-1', email: 'a@b.co' }
  preferences = { pipeline: { auto_send: true }, models: { ceiling: 'R3' }, targeting: { roles: ['Engineer'] } }
  rpc.mockClear()
  updates.length = 0
})

describe('/api/settings/models', () => {
  it('answers 401 with no session, for a read and a write', async () => {
    user = null
    expect((await GET(new NextRequest('http://localhost/api/settings/models'))).status).toBe(401)
    expect((await put({ ceiling: 'R2' })).status).toBe(401)
    expect(updates).toEqual([])
  })

  it('refuses a ceiling that is not a rung', async () => {
    expect((await put({ ceiling: 'R9' })).status).toBe(400)
    expect((await put({})).status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
    expect(updates).toEqual([])
  })

  it('sends credit_bought through set_autonomy with the current pipeline kept', async () => {
    const res = await put({ creditBought: true })
    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('set_autonomy', { p_pipeline: { auto_send: true, credit_bought: true } })
    expect(updates).toEqual([]) // no ceiling or order given, so preferences is not rewritten
  })

  it('saves the ceiling and order without losing the rest of preferences', async () => {
    const res = await put({ ceiling: 'R2', order: ['R2', 'R3'] })
    expect(res.status).toBe(200)
    expect(updates).toEqual([{ preferences: { pipeline: { auto_send: true }, models: { ceiling: 'R2', order: ['R2', 'R3'] }, targeting: { roles: ['Engineer'] } } }])
  })
})
