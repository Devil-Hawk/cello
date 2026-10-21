import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

let user: { id: string } | null = { id: 'u1' }
const addMock = vi.fn()
const readMock = vi.fn()
const employerRow = { id: 'e1', ats_provider: 'ashby', ats_token: 'retell-ai' }

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user }, error: null }) } }) }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({ admin: true }) }))
vi.mock('@/lib/companies/add-link', () => ({ addCompany: (...args: unknown[]) => addMock(...args), realAddDeps: { real: true } }))
vi.mock('@/lib/companies/directory', () => ({ getEmployer: async () => employerRow }))
vi.mock('@/lib/companies/read-employer', () => ({ loadPerson: async () => [{ userId: 'u1' }], readEmployer: (...args: unknown[]) => readMock(...args) }))

import { POST } from './route'

const ID = '11111111-1111-4111-8111-111111111111'
const post = (body: unknown, headers: Record<string, string> = {}) => POST(new NextRequest('http://localhost/api/companies/add', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }))
const lines = async (res: Response) => (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l))
const added = { ok: true, companyId: 'c1', already: false, employer: { employerId: 'e1', name: 'Retell AI', domain: 'retellai.com', logoUrl: null, openCount: 12 } }

beforeEach(() => {
  user = { id: 'u1' }
  addMock.mockReset().mockResolvedValue(added)
  readMock.mockReset().mockResolvedValue({ listed: 12, kept: 2, stored: 2, errors: [] })
})

describe('POST /api/companies/add', () => {
  it('refuses a caller who is not signed in, before anything is read', async () => {
    user = null
    expect((await post({ link: 'retellai.com/careers' })).status).toBe(401)
    expect(addMock).not.toHaveBeenCalled()
  })

  it('takes exactly one of employerId, candidateId, link or candidate, and a real id', async () => {
    const bad = ['not json', {}, { link: '' }, { link: 'a.com', employerId: ID }, { employerId: 'nope' }, { candidateId: 7 }, { link: 'x'.repeat(2001) }, { candidate: 'x' }, { candidate: {} }, { candidate: { provider: 'personio', token: 'amazon', name: 'Amazon', domain: null } }, { candidate: { provider: 'ashby', token: 'bad token!', name: 'A', domain: null } }, { candidate: { domain: 'acme.com' } }, { candidate: { provider: 'ashby', token: 'a', name: 'A', domain: null }, link: 'a.com' }]
    for (const body of bad) expect((await post(body)).status, JSON.stringify(body).slice(0, 60)).toBe(400)
    expect(addMock).not.toHaveBeenCalled()
  })

  it('adds for the signed-in person, never for an id from the body', async () => {
    await post({ link: ' retellai.com/careers ' })
    expect(addMock.mock.calls[0][1]).toBe('u1')
    expect(addMock.mock.calls[0][2]).toEqual({ link: 'retellai.com/careers' })
    await post({ employerId: ID })
    expect(addMock.mock.calls[1][2]).toEqual({ employerId: ID })
  })

  it('hands a chosen candidate to the add as a board or a site to prove again', async () => {
    await post({ candidate: { provider: 'ashby', token: 'retell-ai', name: 'Retell AI', domain: 'RetellAI.com', jobs: 99, profile: { qid: 'Q1', hq: 'forged' } } })
    expect(addMock.mock.calls[0][2]).toEqual({ board: { provider: 'ashby', token: 'retell-ai', name: 'Retell AI', domain: 'retellai.com', qid: 'Q1' } })
    await post({ candidate: { domain: 'amazon.jobs', careersUrl: 'https://www.amazon.jobs/en/search', name: 'Amazon' } })
    expect(addMock.mock.calls[1][2]).toEqual({ site: { domain: 'amazon.jobs', careersUrl: 'https://www.amazon.jobs/en/search', name: 'Amazon', qid: undefined } })
    await post({ candidate: { employerId: ID, name: 'Retell AI' } })
    expect(addMock.mock.calls[2][2]).toEqual({ employerId: ID })
  })

  it('streams each stage as a line, then added with the employer and what the first read counted', async () => {
    addMock.mockImplementation(async (_db, _user, _by, deps) => {
      deps.report({ step: 'reading', host: 'retellai.com', line: 'Reading retellai.com' })
      deps.report({ step: 'board_found', provider: 'ashby', line: 'Found an Ashby board' })
      return added
    })
    const res = await post({ link: 'retellai.com/careers' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/x-ndjson')
    expect(await lines(res)).toEqual([
      { step: 'reading', host: 'retellai.com', line: 'Reading retellai.com' },
      { step: 'board_found', provider: 'ashby', line: 'Found an Ashby board' },
      { step: 'added', companyId: 'c1', already: false, employer: added.employer, read: { listed: 12, kept: 2 }, line: 'Following. Cello checks it with the others, every 6 hours.' },
    ])
    expect(readMock).toHaveBeenCalledTimes(1)
    expect(readMock.mock.calls[0][1]).toBe(employerRow)
    expect(readMock.mock.calls[0][2]).toEqual([{ userId: 'u1' }])
  })

  it('reads nothing again for an employer the person already follows, and says so; a read that fails is null, not an error', async () => {
    addMock.mockResolvedValueOnce({ ...added, already: true })
    expect(await lines(await post({ link: 'retellai.com/careers' }))).toEqual([expect.objectContaining({ step: 'added', already: true, read: null, line: 'You follow this already.' })])
    expect(readMock).not.toHaveBeenCalled()
    readMock.mockRejectedValueOnce(new Error('boom'))
    expect(await lines(await post({ link: 'retellai.com/careers' }))).toEqual([expect.objectContaining({ step: 'added', read: null })])
  })

  it('ends a refusal with its reason, one line and the offers; the status is 200 once the stream has started', async () => {
    addMock.mockResolvedValueOnce({ ok: false, reason: 'other_owner', line: 'a line', offers: [{ kind: 'employer', name: 'Retell AI' }] })
    const res = await post({ link: 'retellai.com/careers' })
    expect(res.status).toBe(200)
    expect(await lines(res)).toEqual([{ step: 'refused', reason: 'other_owner', line: 'a line', offers: [{ kind: 'employer', name: 'Retell AI' }] }])
    for (const reason of ['demo', 'daily_limit', 'bad_link', 'not_found', 'not_saved']) {
      addMock.mockResolvedValueOnce({ ok: false, reason, line: 'a line', offers: [] })
      expect(await lines(await post({ link: 'retellai.com/careers' })), reason).toEqual([{ step: 'refused', reason, line: 'a line', offers: [] }])
    }
  })

  it('ends a page handed to the browser worker with queued and its line', async () => {
    addMock.mockResolvedValueOnce({ ok: false, reason: 'cannot_read', line: 'x', offers: [], queued: 'Cello could not read that page: the site asked for a bot check. Trying with a browser within the hour.' })
    expect(await lines(await post({ link: 'acme.com/careers' }))).toEqual([{ step: 'queued', line: 'Cello could not read that page: the site asked for a bot check. Trying with a browser within the hour.' }])
  })

  it('refuses a cross-site add before anything is read', async () => {
    const res = await post({ link: 'retellai.com/careers' }, { 'sec-fetch-site': 'cross-site' })
    expect(res.status).toBe(403)
    expect(addMock).not.toHaveBeenCalled()
  })

  it('ends the stream with a plain error line, and nothing else, when the work throws', async () => {
    addMock.mockRejectedValueOnce(new Error('secret detail'))
    const out = await lines(await post({ link: 'retellai.com/careers' }))
    expect(out).toEqual([{ step: 'error', line: 'Cello could not finish that right now. Try again.' }])
  })
})
