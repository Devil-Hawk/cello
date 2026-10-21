// GET /api/roles/:id/fit: the band, the readings and the provenance of one role, for the signed-in person only.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { fakeDb } from '@/lib/companies/fake-db'

const state = { user: { id: 'u1' } as { id: string } | null }
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user }, error: null }) } }) }))
let db = fakeDb().client
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => db }))

import { GET } from './route'

const ID = '4f5ad7eb-912c-4e15-ab3c-0f8248113d69'
const get = (id = ID) => GET(new NextRequest(`http://localhost/api/roles/${id}/fit`), { params: { id } })

beforeEach(() => {
  state.user = { id: 'u1' }
  db = fakeDb({
    person_roles: [
      { user_id: 'u1', job_id: ID, band: 'possible', readings: [{ id: 'a', status: 'met', line: 2, quote: 'Go' }], prov: { step: 'role.evidence' }, judged_at: '2026-10-22T10:00:00Z' },
      { user_id: 'u2', job_id: 'other', band: 'strong', readings: [], prov: null, judged_at: null },
    ],
  }).client
})

describe('GET /api/roles/:id/fit', () => {
  it('returns the band, readings and provenance of the person own role', async () => {
    expect(await (await get()).json()).toEqual({ band: 'possible', readings: [{ id: 'a', status: 'met', line: 2, quote: 'Go' }], prov: { step: 'role.evidence' }, judgedAt: '2026-10-22T10:00:00Z' })
  })
  it('is 404 for a role the person does not hold, 401 signed out and 400 for a bad id', async () => {
    expect((await get('4f5ad7eb-912c-4e15-ab3c-0f8248113d70')).status).toBe(404)
    expect((await get('nope')).status).toBe(400)
    state.user = null
    expect((await get()).status).toBe(401)
  })
})
