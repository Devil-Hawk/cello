import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

let user: { id: string } | null = { id: 'u1' }
const findMock = vi.fn()

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user }, error: null }) } }) }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({ admin: true }) }))
vi.mock('@/lib/companies/find', () => ({ findEmployer: (...args: unknown[]) => findMock(...args), realFindDeps: () => ({ deps: true }) }))

import { POST } from './route'

const post = (body: unknown, headers: Record<string, string> = {}) => POST(new NextRequest('http://localhost/api/companies/find', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }))
const lines = async (res: Response) => (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l))

beforeEach(() => {
  user = { id: 'u1' }
  findMock.mockReset().mockImplementation(async (_db, _user, _name, _deps, report) => {
    report({ rung: 'directory', line: 'Checking the directory' })
    report({ rung: 'boards', line: 'Checking job boards' })
    return { candidates: [{ name: 'Retell AI', domain: 'retellai.com', foundBy: 'board', provenBy: 'the board declares retellai.com as home', jobs: 12 }] }
  })
})

describe('POST /api/companies/find', () => {
  it('streams one line per rung as it starts, then the candidates, one JSON object per line', async () => {
    const res = await post({ name: ' Retell AI ' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/x-ndjson')
    expect(await lines(res)).toEqual([
      { rung: 'directory', line: 'Checking the directory' },
      { rung: 'boards', line: 'Checking job boards' },
      { candidates: [{ name: 'Retell AI', domain: 'retellai.com', foundBy: 'board', provenBy: 'the board declares retellai.com as home', jobs: 12 }] },
    ])
    expect(findMock.mock.calls[0][1]).toBe('u1')
    expect(findMock.mock.calls[0][2]).toBe('Retell AI')
  })

  it('ends with none and its line when nothing is proven', async () => {
    findMock.mockResolvedValue({ none: true, line: 'Cello could not find Zzz. Paste its careers link.' })
    expect(await lines(await post({ name: 'Zzz' }))).toEqual([{ none: true, line: 'Cello could not find Zzz. Paste its careers link.' }])
  })

  it('refuses before streaming: not signed in, cross-site, a name outside 2 to 120 characters', async () => {
    user = null
    expect((await post({ name: 'Retell AI' })).status).toBe(401)
    user = { id: 'u1' }
    expect((await post({ name: 'Retell AI' }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    for (const body of ['not json', {}, { name: 'a' }, { name: ' x ' }, { name: 'x'.repeat(121) }, { name: 7 }]) expect((await post(body)).status, JSON.stringify(body).slice(0, 30)).toBe(400)
    expect(findMock).not.toHaveBeenCalled()
    expect((await post({ name: 'ab' })).status).toBe(200)
    expect((await post({ name: 'x'.repeat(120) })).status).toBe(200)
  })

  it('ends the stream with a plain error line, and no detail, when the search throws', async () => {
    findMock.mockRejectedValue(new Error('secret detail https://x.example'))
    const out = await lines(await post({ name: 'Retell AI' }))
    expect(out).toEqual([{ step: 'error', line: 'Cello could not finish that right now. Try again.' }])
  })
})
