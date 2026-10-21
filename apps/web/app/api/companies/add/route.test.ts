import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

let user: { id: string } | null = { id: 'u1' }
const addMock = vi.fn()
const readMock = vi.fn()
const employerRow = { id: 'e1', ats_provider: 'ashby', ats_token: 'retell-ai' }

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user }, error: null }) } }) }))
const admin = vi.fn((): unknown => ({ admin: true }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => admin() }))
vi.mock('@/lib/companies/add-link', () => ({ addCompany: (...args: unknown[]) => addMock(...args), realAddDeps: { real: true } }))
vi.mock('@/lib/companies/directory', () => ({ getEmployer: async () => employerRow }))
vi.mock('@/lib/companies/read-employer', () => ({ loadPerson: vi.fn(async () => [{ userId: 'u1' }]), readEmployer: (...args: unknown[]) => readMock(...args) }))

import { loadPerson } from '@/lib/companies/read-employer'
import { POST } from './route'

const ID = '11111111-1111-4111-8111-111111111111'
const post = (body: unknown, headers: Record<string, string> = {}) => POST(new NextRequest('http://localhost/api/companies/add', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }))
const lines = async (res: Response) => (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l))
const last = async (res: Response) => (await lines(res)).at(-1)
const added = { ok: true, companyId: 'c1', already: false, employer: { employerId: 'e1', name: 'Retell AI', domain: 'retellai.com', logoUrl: null, openCount: 12 } }

beforeEach(() => {
  user = { id: 'u1' }
  addMock.mockReset().mockResolvedValue(added)
  admin.mockReset().mockImplementation(() => ({ admin: true }))
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
    // the name a client sends for a site is dropped: the add names it from its own evidence
    expect(addMock.mock.calls[1][2]).toEqual({ site: { domain: 'amazon.jobs', careersUrl: 'https://www.amazon.jobs/en/search', qid: undefined } })
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
      { step: 'reading_board', line: 'Reading the board' },
      { step: 'added', companyId: 'c1', already: false, employer: added.employer, read: { listed: 12, kept: 2 }, line: 'Following. Cello checks it with the others, every 6 hours.' },
    ])
    expect(readMock).toHaveBeenCalledTimes(1)
    expect(readMock.mock.calls[0][1]).toBe(employerRow)
    expect(readMock.mock.calls[0][2]).toEqual([{ userId: 'u1' }])
  })

  it('reads nothing again for an employer the person already follows, and says so; a read that throws is null, not an error', async () => {
    addMock.mockResolvedValueOnce({ ...added, already: true })
    expect(await last(await post({ link: 'retellai.com/careers' }))).toEqual(expect.objectContaining({ step: 'added', already: true, read: null, line: 'You follow this already.' }))
    expect(readMock).not.toHaveBeenCalled()
    readMock.mockRejectedValueOnce(new Error('boom'))
    expect(await last(await post({ link: 'retellai.com/careers' }))).toEqual(expect.objectContaining({ step: 'added', read: null }))
  })

  it('sends read null, never 0 open, when the first read failed; kept is null when the person has no targets', async () => {
    readMock.mockResolvedValueOnce({ listed: 0, kept: 0, stored: 0, errors: [], failure: 'cannot_read' })
    expect(await last(await post({ link: 'retellai.com/careers' }))).toEqual(expect.objectContaining({ step: 'added', read: null }))
    vi.mocked(loadPerson).mockResolvedValueOnce([])
    expect(await last(await post({ link: 'retellai.com/careers' }))).toEqual(expect.objectContaining({ step: 'added', read: { listed: 12, kept: null } }))
  })

  it('hands a first read that runs past 8 s off, as a follow does: read null and the hand-off line', async () => {
    vi.useFakeTimers()
    try {
      readMock.mockReturnValueOnce(new Promise(() => {}))
      const pending = post({ link: 'retellai.com/careers' })
      await vi.advanceTimersByTimeAsync(8000)
      expect(await last(await pending)).toEqual(expect.objectContaining({ step: 'added', read: null, line: 'Following. Cello reads its board within the hour.' }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers a refusal known before any network call as plain JSON with its status, and a streamed one with 200', async () => {
    const statuses: Record<string, number> = { demo: 403, daily_limit: 429, bad_link: 400, not_found: 404, not_saved: 500, other_owner: 200 }
    for (const [reason, status] of Object.entries(statuses)) {
      addMock.mockResolvedValueOnce({ ok: false, reason, line: 'a line', offers: [] })
      const res = await post({ link: 'retellai.com/careers' })
      expect(res.status, reason).toBe(status)
      expect(res.headers.get('content-type'), reason).toContain('application/json')
      expect(await res.json(), reason).toEqual({ step: 'refused', reason, line: 'a line', offers: [] })
    }
    addMock.mockImplementationOnce(async (_db, _user, _by, deps) => {
      deps.report({ step: 'reading', host: 'retellai.com', line: 'Reading retellai.com' })
      return { ok: false, reason: 'other_owner', line: 'a line', offers: [{ kind: 'employer', name: 'Retell AI' }] }
    })
    const res = await post({ link: 'retellai.com/careers' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/x-ndjson')
    expect(await lines(res)).toEqual([{ step: 'reading', host: 'retellai.com', line: 'Reading retellai.com' }, { step: 'refused', reason: 'other_owner', line: 'a line', offers: [{ kind: 'employer', name: 'Retell AI' }] }])
  })

  it('does not start the stream on a directory hit, which can still end in the daily limit', async () => {
    addMock.mockImplementationOnce(async (_db, _user, _by, deps) => {
      deps.report({ step: 'directory_hit', following: false, line: 'In the directory, not on your page yet' })
      return { ok: false, reason: 'daily_limit', line: 'a line', offers: [] }
    })
    const res = await post({ employerId: ID })
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ step: 'refused', reason: 'daily_limit' })
    addMock.mockImplementationOnce(async (_db, _user, _by, deps) => {
      deps.report({ step: 'directory_hit', following: false, line: 'In the directory, not on your page yet' })
      return added
    })
    // The board read of an added employer is a network step: the answer streams from there, with the hit before it.
    const hit = await post({ employerId: ID })
    expect(hit.status).toBe(200)
    expect(hit.headers.get('content-type')).toContain('application/x-ndjson')
    expect(await lines(hit)).toEqual([
      { step: 'directory_hit', following: false, line: 'In the directory, not on your page yet' },
      { step: 'reading_board', line: 'Reading the board' },
      expect.objectContaining({ step: 'added', employer: added.employer }),
    ])
  })

  it('answers a candidate add as plain JSON until its first network step, then as NDJSON', async () => {
    const candidate = { candidate: { provider: 'ashby', token: 'retell-ai', name: 'Retell AI', domain: 'retellai.com' } }
    // refused before any network call (here, the day's limit): plain JSON with its status
    addMock.mockResolvedValueOnce({ ok: false, reason: 'daily_limit', line: 'a line', offers: [] })
    const plain = await post(candidate)
    expect(plain.status).toBe(429)
    expect(plain.headers.get('content-type')).toContain('application/json')
    // checked: the first step is told before the board is fetched, so the answer streams
    addMock.mockImplementationOnce(async (_db, _user, _by, deps) => {
      deps.report({ step: 'reading', host: 'retellai.com', line: 'Reading retellai.com' })
      return { ok: false, reason: 'cannot_read', line: 'a line', offers: [] }
    })
    const streamed = await post(candidate)
    expect(streamed.status).toBe(200)
    expect(streamed.headers.get('content-type')).toContain('application/x-ndjson')
    expect(await lines(streamed)).toEqual([
      { step: 'reading', host: 'retellai.com', line: 'Reading retellai.com' },
      { step: 'refused', reason: 'cannot_read', line: 'a line', offers: [] },
    ])
  })

  it('streams a proven board from board_found, which is its first network step', async () => {
    addMock.mockImplementationOnce(async (_db, _user, _by, deps) => {
      deps.report({ step: 'board_found', provider: 'ashby', line: 'Found an Ashby board' })
      return { ok: false, reason: 'other_owner', line: 'a line', offers: [] }
    })
    const res = await post({ candidate: { provider: 'ashby', token: 'retell-ai', name: 'Retell AI', domain: null } })
    expect(res.headers.get('content-type')).toContain('application/x-ndjson')
    expect((await lines(res)).map((l) => l.step)).toEqual(['board_found', 'refused'])
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

  it('writes one timing row per call, and still answers when the timing insert throws', async () => {
    const insert = vi.fn(async () => ({ error: null }))
    admin.mockImplementation(() => ({ from: () => ({ insert }) }))
    const answer = await post({ link: 'retellai.com/careers' })
    expect(answer.status).toBe(200)
    await answer.text()
    expect(insert).toHaveBeenCalledWith({ route: 'add', ms: expect.any(Number), ok: true })

    admin.mockImplementation(() => ({ from: () => { throw new Error('insert failed') } }))
    const res = await post({ link: 'retellai.com/careers' })
    expect(res.status).toBe(200)
    expect(await last(res)).toMatchObject({ step: 'added', companyId: 'c1' })
  })

  it('writes no timing row for a call refused at the door: no session, a bad body, or cross-site', async () => {
    const insert = vi.fn(async () => ({ error: null }))
    admin.mockImplementation(() => ({ from: () => ({ insert }) }))
    user = null
    expect((await post({ link: 'retellai.com/careers' })).status).toBe(401)
    user = { id: 'u1' }
    expect((await post({})).status).toBe(400)
    const crossSite = new NextRequest('http://localhost/api/companies/add', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ link: 'retellai.com/careers' }) })
    expect((await POST(crossSite)).status).toBe(403)
    expect(insert).not.toHaveBeenCalled()
  })

  it('answers 500 with a plain error line, and nothing else, when the work throws before the stream; an error line after it', async () => {
    addMock.mockRejectedValueOnce(new Error('secret detail'))
    const res = await post({ link: 'retellai.com/careers' })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ step: 'error', line: 'Cello could not finish that right now. Try again.' })
    addMock.mockImplementationOnce(async (_db, _user, _by, deps) => {
      deps.report({ step: 'reading', host: 'retellai.com', line: 'Reading retellai.com' })
      throw new Error('secret detail')
    })
    expect(await lines(await post({ link: 'retellai.com/careers' }))).toEqual([{ step: 'reading', host: 'retellai.com', line: 'Reading retellai.com' }, { step: 'error', line: 'Cello could not finish that right now. Try again.' }])
  })
})
