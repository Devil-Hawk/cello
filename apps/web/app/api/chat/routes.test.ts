// The Chat routes: who may call them and what they hand on. The library under them has its own tests.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { makeFakeAdmin, type FakeAdmin } from '@/lib/agents/testing/fake-admin'

const state = vi.hoisted(() => ({ user: { id: 'u1' } as { id: string } | null, db: undefined as unknown }))

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }) }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => state.db }))
vi.mock('@/lib/memory/mem0-store', () => ({ getMemoryStore: () => ({ getAll: async () => [], add: async () => undefined, search: async () => [], deleteAll: async () => undefined }) }))
// The default reader loads the scoring module; the routes here only need "this person's thing reads, another's does not".
vi.mock('@/lib/chat/ports/commands.stub', () => ({
  getObject: async (_db: unknown, userId: string, kind: string, ref: Record<string, string>) =>
    userId === 'u1' ? { kind, id: ref.id ?? ref.chat_id, title: 'A thing', company: null, facts: [], body: null } : null,
}))

import { GET as list } from './route'
import { DELETE as remove, GET as one, PATCH as patch } from './[id]/route'
import { DELETE as untile, POST as tile } from './[id]/attachments/route'
import { POST as stop } from './[id]/stop/route'
import { GET as suggestions } from './suggest/route'
import { GET as made } from './made/route'

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ctx = (id: string) => ({ params: { id } })
const req = (url: string, init: RequestInit = {}) => new NextRequest(`http://localhost${url}`, { headers: { 'content-type': 'application/json' }, ...init })
const json = (url: string, method: string, body: unknown) => req(url, { method, body: JSON.stringify(body) })

let db: FakeAdmin
beforeEach(() => {
  state.user = { id: 'u1' }
  db = makeFakeAdmin({
    instance_flags: [{ key: 'chat_shown', on: true }],
    chats: [
      { id: 'c1', user_id: 'u1', title: 'Mine', last_turn_at: '2026-10-05T00:00:00Z', archived_at: null, pinned_at: null },
      { id: 'c2', user_id: 'u2', title: 'Theirs', last_turn_at: '2026-10-05T00:00:00Z', archived_at: null, pinned_at: null },
    ],
    chat_turns: [],
    chat_attachments: [],
    agent_tasks: [{ id: 'w1', user_id: 'u2', turn_id: 't9', finished_at: null }],
    copilot_conversations: [{ id: 'k1', user_id: 'u1', title: 'Old', updated_at: '2026-09-01T00:00:00Z' }],
    profiles: [{ id: 'u1', full_name: 'Ankit Punjabi' }],
    role_reactions: [],
    applications: [],
    artifacts: [],
  })
  state.db = db
})

describe('the door', () => {
  it('needs a signed in person', async () => {
    state.user = null
    expect((await list(req('/api/chat'))).status).toBe(401)
    expect((await one(req('/api/chat/c1'), ctx('c1'))).status).toBe(401)
  })

  it('answers 404 with no body while Chat is closed, for everyone but the owner', async () => {
    db.tables.instance_flags[0].on = false
    const res = await list(req('/api/chat'))
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('')
    process.env.OWNER_USER_ID = 'u1'
    expect((await list(req('/api/chat'))).status).toBe(200)
    delete process.env.OWNER_USER_ID
  })
})

describe('reading', () => {
  it('lists the person\'s chats, or their earlier Copilot conversations', async () => {
    expect((await (await list(req('/api/chat'))).json()).chats.map((c: { id: string }) => c.id)).toEqual(['c1'])
    expect((await (await list(req('/api/chat?earlier=1'))).json()).earlier.map((c: { id: string }) => c.id)).toEqual(['k1'])
  })

  it('opens their own chat and says not found for another person\'s', async () => {
    expect((await one(req('/api/chat/c1'), ctx('c1'))).status).toBe(200)
    expect((await one(req('/api/chat/c2'), ctx('c2'))).status).toBe(404)
  })

  it('gives suggestions with a greeting by name, and lists made things', async () => {
    const body = await (await suggestions(req('/api/chat/suggest?tz=UTC'))).json()
    expect(body.greeting).toMatch(/, Ankit\.$/)
    expect(body.suggestions.length).toBeGreaterThan(0)
    expect((await made(req('/api/chat/made'))).status).toBe(200)
  })
})

describe('changing', () => {
  it('renames, pins and archives their own chat, refuses another person\'s, and refuses an empty body', async () => {
    expect((await patch(json('/api/chat/c1', 'PATCH', { title: 'Renamed', pinned: true, archived: true }), ctx('c1'))).status).toBe(200)
    expect(db.tables.chats[0]).toMatchObject({ title: 'Renamed' })
    expect(db.tables.chats[0].pinned_at).toBeTruthy()
    expect(db.tables.chats[0].archived_at).toBeTruthy()
    expect((await patch(json('/api/chat/c2', 'PATCH', { title: 'Mine now' }), ctx('c2'))).status).toBe(404)
    expect(db.tables.chats[1].title).toBe('Theirs')
    expect((await patch(json('/api/chat/c1', 'PATCH', {}), ctx('c1'))).status).toBe(400)
  })

  it('deletes their own chat and not another person\'s', async () => {
    expect((await remove(req('/api/chat/c2', { method: 'DELETE' }), ctx('c2'))).status).toBe(404)
    expect(db.tables.chats).toHaveLength(2)
    expect((await remove(req('/api/chat/c1', { method: 'DELETE' }), ctx('c1'))).status).toBe(200)
    expect(db.tables.chats.map((c) => c.id)).toEqual(['c2'])
  })
})

describe('tiles', () => {
  it('adds a tile as the person, refuses a forged ref, and removes it keeping the row', async () => {
    const added = await tile(json('/api/chat/c1/attachments', 'POST', { kind: 'role', ref: { id: UUID(1) } }), ctx('c1'))
    expect(added.status).toBe(200)
    const row = db.tables.chat_attachments[0]
    expect(row).toMatchObject({ origin: 'person', prov: { door: 'chat.attach' } })
    const forged = await tile(json('/api/chat/c1/attachments', 'POST', { kind: 'role', ref: { id: UUID(1), user_id: 'u2' } }), ctx('c1'))
    expect(forged.status).toBe(422)
    expect((await tile(json('/api/chat/c1/attachments', 'POST', { ref: {} }), ctx('c1'))).status).toBe(400)
    expect((await untile(req(`/api/chat/c1/attachments?tile=${row.id}`, { method: 'DELETE' }), ctx('c1'))).status).toBe(200)
    expect(db.tables.chat_attachments).toHaveLength(1)
    expect(db.tables.chat_attachments[0].removed_at).toBeTruthy()
    expect((await untile(req('/api/chat/c1/attachments', { method: 'DELETE' }), ctx('c1'))).status).toBe(400)
  })

  it('refuses to add to another person\'s chat', async () => {
    expect((await tile(json('/api/chat/c2/attachments', 'POST', { kind: 'role', ref: { id: UUID(1) } }), ctx('c2'))).status).toBe(422)
    expect(db.tables.chat_attachments).toHaveLength(0)
  })
})

describe('stop', () => {
  it('stops a worker that is the person\'s, and a forged task id stops nothing', async () => {
    db.tables.agent_tasks.push({ id: 'w2', user_id: 'u1', turn_id: 't1', finished_at: null })
    expect((await stop(json('/api/chat/c1/stop', 'POST', { task_id: 'w1' }))).status).toBe(404)
    expect(db.tables.agent_tasks[0].stop_requested_at).toBeUndefined()
    expect((await stop(json('/api/chat/c1/stop', 'POST', { task_id: 'w2' }))).status).toBe(200)
    expect(db.tables.agent_tasks[1].stop_requested_at).toBeTruthy()
    expect((await stop(json('/api/chat/c1/stop', 'POST', {}))).status).toBe(400)
  })

  it('stops a whole turn, counting only the person\'s own rows', async () => {
    db.tables.agent_tasks.push({ id: 'w3', user_id: 'u1', turn_id: 't2', finished_at: null }, { id: 'w4', user_id: 'u1', turn_id: 't2', finished_at: null })
    expect(await (await stop(json('/api/chat/c1/stop', 'POST', { turn_id: 't2' }))).json()).toEqual({ ok: true, stopped: 2 })
    expect(await (await stop(json('/api/chat/c1/stop', 'POST', { turn_id: 't9' }))).json()).toEqual({ ok: true, stopped: 0 })
  })
})
