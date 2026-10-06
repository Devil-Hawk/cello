import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

let user: { id: string } | null = { id: 'u1' }
const addMock = vi.fn()

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user }, error: null }) } }) }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({ admin: true }) }))
vi.mock('@/lib/companies/add-link', () => ({ addCompany: (...args: unknown[]) => addMock(...args) }))

import { POST } from './route'

const ID = '11111111-1111-4111-8111-111111111111'
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/companies/add', { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }))

beforeEach(() => {
  user = { id: 'u1' }
  addMock.mockReset().mockResolvedValue({ ok: true, companyId: 'c1', already: false, employer: { name: 'Retell AI' } })
})

describe('POST /api/companies/add', () => {
  it('refuses a caller who is not signed in, before anything is read', async () => {
    user = null
    expect((await post({ link: 'retellai.com/careers' })).status).toBe(401)
    expect(addMock).not.toHaveBeenCalled()
  })

  it('takes exactly one of employerId, candidateId or link, and a real id', async () => {
    for (const body of ['not json', {}, { link: '' }, { link: 'a.com', employerId: ID }, { employerId: 'nope' }, { candidateId: 7 }, { link: 'x'.repeat(2001) }]) {
      expect((await post(body)).status, JSON.stringify(body).slice(0, 40)).toBe(400)
    }
    expect(addMock).not.toHaveBeenCalled()
  })

  it('adds for the signed-in person, never for an id from the body', async () => {
    const res = await post({ link: ' retellai.com/careers ' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, companyId: 'c1' })
    expect(addMock.mock.calls[0][1]).toBe('u1')
    expect(addMock.mock.calls[0][2]).toEqual({ link: 'retellai.com/careers' })
    await post({ employerId: ID })
    expect(addMock.mock.calls[1][2]).toEqual({ employerId: ID })
  })

  it('answers a refusal with its reason, one line and the offers; the limit, the demo and a bad link have their own status', async () => {
    const refuse = (reason: string) => addMock.mockResolvedValueOnce({ ok: false, reason, line: 'a line', offers: [{ kind: 'employer', name: 'Retell AI' }] })
    refuse('other_owner')
    const res = await post({ link: 'retellai.com/careers' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false, reason: 'other_owner', line: 'a line', offers: [{ kind: 'employer', name: 'Retell AI' }] })
    const statuses: [string, number][] = [['demo', 403], ['daily_limit', 429], ['bad_link', 400], ['not_found', 404], ['not_saved', 500]]
    for (const [reason, status] of statuses) {
      refuse(reason)
      expect((await post({ link: 'retellai.com/careers' })).status, reason).toBe(status)
    }
  })

  it('says it could not add, and nothing else, when the work throws', async () => {
    addMock.mockRejectedValueOnce(new Error('secret detail'))
    const res = await post({ link: 'retellai.com/careers' })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret')
  })
})
