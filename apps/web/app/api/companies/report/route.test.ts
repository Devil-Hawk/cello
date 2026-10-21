import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { ADD_LINES } from '@/lib/companies/add-link'

const reportMock = vi.fn()

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) } }) }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({ admin: true }) }))
vi.mock('@/lib/companies/follow', () => ({ reportEmployer: (...args: unknown[]) => reportMock(...args) }))

import { POST } from './route'

const ID = '11111111-1111-4111-8111-111111111111'
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/companies/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))

beforeEach(() => {
  reportMock.mockReset()
})

describe('POST /api/companies/report refusals', () => {
  it('answers 403 with the demo line for a demo account, and writes nothing', async () => {
    reportMock.mockResolvedValueOnce({ ok: false, reason: 'demo' })
    const res = await post({ employerId: ID })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: ADD_LINES.demo })
    expect(reportMock).toHaveBeenCalledTimes(1)
  })

  it('answers 404 with the not-found line for an employer Cello does not have', async () => {
    reportMock.mockResolvedValueOnce({ ok: false, reason: 'not_found' })
    const res = await post({ employerId: ID })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: ADD_LINES.not_found })
  })
})
