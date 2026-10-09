// GET /api/approvals and POST /api/approvals/[id]: the door to the one send path.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = vi.hoisted(() => ({
  user: { id: 'u1', email: 'dana@gmail.com' } as { id: string; email: string } | null,
  decide: vi.fn(),
  list: vi.fn(async () => [{ approval: { id: 'p1' }, artifact: null }]),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }), getSession: async () => ({ data: { session: { provider_token: 'tok' } } }) } }),
}))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/agents/approvals', async (orig) => ({ ...(await orig<typeof import('@/lib/agents/approvals')>()), decideApproval: state.decide }))
vi.mock('@/lib/agents/api', async (orig) => ({ ...(await orig<typeof import('@/lib/agents/api')>()), listApprovals: state.list }))

import { GET } from './route'
import { POST } from './[id]/route'

beforeEach(() => {
  vi.clearAllMocks()
  state.user = { id: 'u1', email: 'dana@gmail.com' }
})

const req = (body?: unknown, url = 'http://localhost/api/approvals/a1') => new NextRequest(url, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
const at = { params: { id: 'a1' } }

describe('GET /api/approvals', () => {
  it('lists pending by default, and refuses a status it does not know', async () => {
    const res = await GET(new NextRequest('http://localhost/api/approvals'))
    expect(await res.json()).toEqual({ approvals: [{ approval: { id: 'p1' }, artifact: null }] })
    expect(state.list.mock.calls[0]).toMatchObject([{}, 'u1', 'pending'])
    expect((await GET(new NextRequest('http://localhost/api/approvals?status=nope'))).status).toBe(400)
  })

  it('needs a signed in person', async () => {
    state.user = null
    expect((await GET(new NextRequest('http://localhost/api/approvals'))).status).toBe(401)
  })
})

describe('POST /api/approvals/[id]', () => {
  it('hands the persons decision to the one decide path as the person, with their session', async () => {
    state.decide.mockResolvedValueOnce({ status: 200, approval: { id: 'a1', status: 'done' }, copy: 'Sent to Dana Lee.' })
    const res = await POST(req({ decision: 'approve', edits: { body: 'Hi Dana.' }, acknowledge_version: 2 }), at)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ approval: { id: 'a1', status: 'done' }, copy: 'Sent to Dana Lee.' })
    expect(state.decide.mock.calls[0][0]).toMatchObject({ id: 'a1', decision: 'approve', by: 'user', user: { id: 'u1' }, session: { provider_token: 'tok' }, edits: { body: 'Hi Dana.' }, acknowledgeVersion: 2 })
  })

  it('returns the status the decide path chose, with its fix', async () => {
    state.decide.mockResolvedValueOnce({ status: 409, approval: null, copy: 'The draft changed after it was queued. Review the new version and approve again.', error: 'Changed', fix: 'Show the new version.' })
    const res = await POST(req({ decision: 'approve' }), at)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'Changed', fix: 'Show the new version.' })
  })

  it('a decision that is not approve or skip never reaches the decide path', async () => {
    expect((await POST(req({ decision: 'send' }), at)).status).toBe(400)
    expect((await POST(req(), at)).status).toBe(400)
    expect(state.decide).not.toHaveBeenCalled()
  })

  it('cannot be decided by a rule from here: the decider is always the person', async () => {
    state.decide.mockResolvedValueOnce({ status: 200, approval: null, copy: 'x' })
    await POST(req({ decision: 'skip', by: 'rule' }), at)
    expect(state.decide.mock.calls[0][0]).toMatchObject({ by: 'user', decision: 'skip' })
  })

  it('needs a signed in person', async () => {
    state.user = null
    expect((await POST(req({ decision: 'approve' }), at)).status).toBe(401)
    expect(state.decide).not.toHaveBeenCalled()
  })
})
