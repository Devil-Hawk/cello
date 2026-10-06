// POST /api/roles/:id/type: signed in only, a real type or null, done as the signed-in person.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = { user: { id: 'u1' } as { id: string } | null }
const rpc = vi.fn()
const client = { auth: { getUser: async () => ({ data: { user: state.user }, error: null }) }, rpc }
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => client }))

import { POST } from './route'

const ID = '4f5ad7eb-912c-4e15-ab3c-0f8248113d69'
const post = (body: unknown, id = ID) =>
  POST(new NextRequest(`http://localhost/api/roles/${id}/type`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' } }), { params: { id } })

beforeEach(() => {
  vi.clearAllMocks()
  state.user = { id: 'u1' }
  rpc.mockResolvedValue({ data: 3, error: null })
})

describe('POST /api/roles/:id/type', () => {
  it('is 401 for a signed-out visitor, before anything is written', async () => {
    state.user = null
    expect((await post({ typeId: 'ai-engineer' })).status).toBe(401)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('changes the type as the signed-in person and says how many roles moved', async () => {
    const res = await post({ typeId: 'ai-engineer' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ moved: 3 })
    expect(rpc).toHaveBeenCalledWith('set_person_role_type', { p_user: 'u1', p_job: ID, p_type: 'ai-engineer' })
  })

  it('takes the correction back with null, which is what Undo sends', async () => {
    expect((await post({ typeId: null })).status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('set_person_role_type', { p_user: 'u1', p_job: ID, p_type: null })
  })

  it('refuses a made-up type, "other", a body that is not a type and a role id that is not an id', async () => {
    for (const bad of [{ typeId: 'wizard' }, { typeId: 'other' }, {}, { typeId: 4 }, 'not json']) expect((await post(bad)).status).toBe(400)
    expect((await post({ typeId: 'ai-engineer' }, 'nope')).status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })
})
