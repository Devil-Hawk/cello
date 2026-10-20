// POST /api/chat/[id]/proposals/[pid]: who may decide a proposal and what each answer is.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { makeFakeAdmin, type FakeAdmin } from '@/lib/agents/testing/fake-admin'

const state = vi.hoisted(() => ({ user: { id: 'u1' } as { id: string } | null, db: undefined as unknown }))
const call = vi.hoisted(() => vi.fn())

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }) }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => state.db }))
vi.mock('@/lib/agents/user-mcp', () => ({ callUserMcpTool: call }))

import { POST } from './route'

const payload = { server: 'notes', tool: 'search', args: { q: 'rent' } }
const ctx = (id: string, pid: string) => ({ params: { id, pid } })
const post = (body: unknown) => new NextRequest('http://localhost/api/chat/c1/proposals/p1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

let db: FakeAdmin
beforeEach(() => {
  state.user = { id: 'u1' }
  call.mockReset().mockResolvedValue({ ok: true, text: 'two notes', isError: false })
  db = makeFakeAdmin({
    instance_flags: [{ key: 'chat_shown', on: true }],
    profiles: [{ id: 'u1', is_demo: false, demo_expires_at: null }],
    chats: [
      { id: 'c1', user_id: 'u1', last_turn_at: null },
      { id: 'c3', user_id: 'u1', last_turn_at: null },
    ],
    chat_turns: [],
    proposals: [
      { id: 'p1', user_id: 'u1', chat_id: 'c1', kind: 'mcp', payload, status: 'open' },
      { id: 'p2', user_id: 'u2', chat_id: 'c2', kind: 'mcp', payload, status: 'open' },
    ],
  })
  state.db = db
})

describe('the proposal route', () => {
  it('confirms the person\'s own proposal, runs the call as them and stores the answer', async () => {
    const res = await POST(post({ decision: 'confirm' }), ctx('c1', 'p1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(call).toHaveBeenCalledWith({ admin: db, userId: 'u1', isDemo: false }, 'notes', 'search', { q: 'rent' })
    expect(db.tables.proposals[0]).toMatchObject({ status: 'confirmed' })
    expect(db.tables.chat_turns).toHaveLength(1)
  })

  it('reads a demo account from the profile', async () => {
    db.tables.profiles[0].is_demo = true
    await POST(post({ decision: 'confirm' }), ctx('c1', 'p1'))
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ isDemo: true }), 'notes', 'search', { q: 'rent' })
  })

  it('dismisses without calling the server', async () => {
    const res = await POST(post({ decision: 'dismiss' }), ctx('c1', 'p1'))
    expect(res.status).toBe(200)
    expect(db.tables.proposals[0]).toMatchObject({ status: 'dismissed' })
    expect(call).not.toHaveBeenCalled()
  })

  it('answers 404 for another person\'s proposal and for one in another chat', async () => {
    for (const [id, pid] of [['c2', 'p2'], ['c3', 'p1'], ['c1', 'nope']]) {
      const res = await POST(post({ decision: 'confirm' }), ctx(id, pid))
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not_found', message: 'That was not found.' })
    }
    expect(call).not.toHaveBeenCalled()
    expect(db.tables.proposals[1]).toMatchObject({ status: 'open' })
  })

  it('answers 409 with the message and fix of a refusal, and the proposal can be tried again', async () => {
    call.mockResolvedValue({ ok: false, reason: 'Could not reach notes.', fix: 'Try Confirm again.' })
    const res = await POST(post({ decision: 'confirm' }), ctx('c1', 'p1'))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'refused', message: 'Could not reach notes.', fix: 'Try Confirm again.' })
    expect(db.tables.proposals[0]).toMatchObject({ status: 'open' })
  })

  it('keeps a confirmed call whose outcome is unknown confirmed, stores the words, and a second Confirm sends nothing', async () => {
    call.mockResolvedValue({ ok: false, unsure: true, reason: 'Cello did not get an answer from notes.', fix: 'The call may or may not have gone through. Check on the server before you try again.' })
    const res = await POST(post({ decision: 'confirm' }), ctx('c1', 'p1'))
    expect(res.status).toBe(200)
    expect(db.tables.proposals[0]).toMatchObject({ status: 'confirmed' })
    expect(db.tables.chat_turns).toHaveLength(1)
    expect(db.tables.chat_turns[0].answer).toContain('may or may not have gone through')
    expect((await POST(post({ decision: 'confirm' }), ctx('c1', 'p1'))).status).toBe(409)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('answers 409 for a proposal that is already decided', async () => {
    await POST(post({ decision: 'dismiss' }), ctx('c1', 'p1'))
    expect((await POST(post({ decision: 'confirm' }), ctx('c1', 'p1'))).status).toBe(409)
  })

  it('answers 400 for a body that is not confirm or dismiss', async () => {
    for (const body of [{}, { decision: 'approve' }, { decision: 7 }]) {
      const res = await POST(post(body), ctx('c1', 'p1'))
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ message: 'Send confirm or dismiss.' })
    }
  })

  it('needs a signed in person', async () => {
    state.user = null
    expect((await POST(post({ decision: 'confirm' }), ctx('c1', 'p1'))).status).toBe(401)
  })
})
