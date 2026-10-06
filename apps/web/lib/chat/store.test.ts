import { describe, expect, it } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import { archiveChat, chatsHolding, earlier, getChat, listChats, listMade, pinChat, renameChat } from './store'

const day = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString()
const chat = (id: string, user: string, over: Record<string, unknown> = {}) => ({
  id,
  user_id: user,
  title: id,
  created_at: day(1),
  last_turn_at: day(1),
  archived_at: null,
  pinned_at: null,
  ...over,
})

describe('listChats', () => {
  it('puts pinned chats first, then newest first, and leaves out archived and other people', async () => {
    const db = makeFakeAdmin({
      chats: [
        chat('old', 'u1', { last_turn_at: day(2) }),
        chat('new', 'u1', { last_turn_at: day(5) }),
        chat('pinned', 'u1', { last_turn_at: day(1), pinned_at: day(3) }),
        chat('gone', 'u1', { last_turn_at: day(9), archived_at: day(9) }),
        chat('theirs', 'u2', { last_turn_at: day(9) }),
      ],
    })
    expect((await listChats(db, 'u1')).map((c) => c.id)).toEqual(['pinned', 'new', 'old'])
    expect((await listChats(db, 'u1', { archived: true })).map((c) => c.id)).toEqual(['gone'])
  })

  it('pages with before and never repeats the pinned chats', async () => {
    const db = makeFakeAdmin({
      chats: [
        chat('a', 'u1', { last_turn_at: day(5) }),
        chat('b', 'u1', { last_turn_at: day(4) }),
        chat('c', 'u1', { last_turn_at: day(3) }),
        chat('p', 'u1', { pinned_at: day(1) }),
      ],
    })
    const first = await listChats(db, 'u1', { limit: 2 })
    expect(first.map((c) => c.id)).toEqual(['p', 'a', 'b'])
    const next = await listChats(db, 'u1', { limit: 2, before: first[first.length - 1].last_turn_at })
    expect(next.map((c) => c.id)).toEqual(['c'])
  })
})

describe('getChat and archiveChat', () => {
  const seed = () =>
    makeFakeAdmin({
      chats: [chat('c1', 'u1')],
      chat_turns: [
        { id: 't2', user_id: 'u1', chat_id: 'c1', kind: 'cello', created_at: day(3) },
        { id: 't1', user_id: 'u1', chat_id: 'c1', kind: 'person', typed: 'hi', created_at: day(2) },
      ],
      chat_attachments: [
        { id: 'a2', user_id: 'u1', chat_id: 'c1', position: 2, kind: 'role', removed_at: day(4) },
        { id: 'a1', user_id: 'u1', chat_id: 'c1', position: 1, kind: 'company', removed_at: null },
      ],
    })

  it('returns turns in order and every tile, detached ones too', async () => {
    const view = await getChat(seed(), 'u1', 'c1')
    expect(view?.turns.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(view?.attachments.map((a) => a.id)).toEqual(['a1', 'a2'])
  })

  it('refuses another person\'s chat', async () => {
    const db = seed()
    expect(await getChat(db, 'u2', 'c1')).toBeNull()
    expect(await archiveChat(db, 'u2', 'c1')).toBe(false)
    expect(db.tables.chats[0].archived_at).toBeNull()
  })

  it('archives and brings a chat back', async () => {
    const db = seed()
    expect(await archiveChat(db, 'u1', 'c1')).toBe(true)
    expect(db.tables.chats[0].archived_at).not.toBeNull()
    expect(await archiveChat(db, 'u1', 'c1', false)).toBe(true)
    expect(db.tables.chats[0].archived_at).toBeNull()
  })
})

describe('earlier', () => {
  it('lists only the person\'s own Copilot conversations and writes nothing', async () => {
    const db = makeFakeAdmin({
      copilot_conversations: [
        { id: 'k1', user_id: 'u1', title: 'Mine', updated_at: day(2) },
        { id: 'k2', user_id: 'u2', title: 'Theirs', updated_at: day(3) },
      ],
    })
    const rows = await earlier(db, 'u1')
    expect(rows.map((r) => r.id)).toEqual(['k1'])
    expect(db.log.filter((l) => !l.startsWith('select '))).toEqual([])
  })
})

describe('pin and rename', () => {
  it('puts a pinned chat first in Recents and brings it back', async () => {
    const db = makeFakeAdmin({ chats: [chat('a', 'u1', { last_turn_at: day(5) }), chat('b', 'u1', { last_turn_at: day(2) })] })
    expect((await listChats(db, 'u1')).map((c) => c.id)).toEqual(['a', 'b'])
    expect(await pinChat(db, 'u1', 'b')).toBe(true)
    expect((await listChats(db, 'u1')).map((c) => c.id)).toEqual(['b', 'a'])
    expect(await pinChat(db, 'u1', 'b', false)).toBe(true)
    expect((await listChats(db, 'u1')).map((c) => c.id)).toEqual(['a', 'b'])
    expect(await pinChat(db, 'u2', 'a')).toBe(false)
  })

  it('renames to the person\'s words, cut at 80 characters, and refuses an empty title or another person\'s chat', async () => {
    const db = makeFakeAdmin({ chats: [chat('a', 'u1')] })
    expect(await renameChat(db, 'u1', 'a', `  My   ${'x'.repeat(100)} `)).toBe(true)
    expect(String(db.tables.chats[0].title)).toHaveLength(80)
    expect(String(db.tables.chats[0].title).startsWith('My x')).toBe(true)
    expect(await renameChat(db, 'u1', 'a', '   ')).toBe(false)
    expect(await renameChat(db, 'u2', 'a', 'Mine now')).toBe(false)
  })
})

describe('listMade', () => {
  const made = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    user_id: 'u1',
    type: 'dossier',
    title: id,
    current_version: 1,
    updated_at: day(Number(id.replace(/\D/g, '')) || 1),
    chat_turn_id: null,
    project_id: null,
    job_id: null,
    ...over,
  })
  const seed = () =>
    makeFakeAdmin({
      artifacts: [made('m1', { job_id: 'j1' }), made('m2', { project_id: 'p1' }), made('m3', { chat_turn_id: 't1' }), made('m4', { user_id: 'u2', job_id: 'j1' }), made('m5')],
      applications: [{ id: 'app1', user_id: 'u1', job_id: 'j1' }],
      projects: [{ id: 'p1', user_id: 'u1', application_id: 'app1' }],
      chat_turns: [{ id: 't1', user_id: 'u1', chat_id: 'c1', kind: 'person' }],
    })

  it('lists everything the person has made, newest first, and none of another person\'s', async () => {
    expect((await listMade(seed(), 'u1')).map((r) => r.id)).toEqual(['m5', 'm3', 'm2', 'm1'])
  })

  it('narrows to an application\'s own things, by its project or its role, and to a chat\'s turns', async () => {
    expect((await listMade(seed(), 'u1', { applicationId: 'app1' })).map((r) => r.id).sort()).toEqual(['m1', 'm2'])
    expect((await listMade(seed(), 'u1', { chatId: 'c1' })).map((r) => r.id)).toEqual(['m3'])
    expect(await listMade(seed(), 'u2', { applicationId: 'app1' })).toEqual([])
  })

  it('pages: 500 made things never come back at once', async () => {
    const db = makeFakeAdmin({ artifacts: Array.from({ length: 500 }, (_, i) => made(`m${i + 1}`, { updated_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString() })) })
    const first = await listMade(db, 'u1', { limit: 500 })
    expect(first).toHaveLength(100)
    const next = await listMade(db, 'u1', { limit: 100, before: first[first.length - 1].updated_at })
    expect(next).toHaveLength(100)
    expect(next[0].id).not.toBe(first[0].id)
  })
})

describe('chatsHolding', () => {
  it('lists the person\'s chats that hold the application as a tile, newest first, and not one that let it go', async () => {
    const tile = (chat: string, id: string, over: Record<string, unknown> = {}) => ({ user_id: 'u1', chat_id: chat, kind: 'application', ref: { id }, removed_at: null, added_at: day(1), ...over })
    const db = makeFakeAdmin({
      chat_attachments: [tile('c1', 'app1'), tile('c2', 'app1'), tile('c3', 'app1', { removed_at: day(2) }), tile('c4', 'app2'), tile('c5', 'app1', { user_id: 'u2' })],
      chats: [chat('c1', 'u1', { last_turn_at: day(3) }), chat('c2', 'u1', { last_turn_at: day(5) }), chat('c3', 'u1'), chat('c4', 'u1'), chat('c5', 'u2')],
    })
    expect((await chatsHolding(db, 'u1', 'app1')).map((c) => c.id)).toEqual(['c2', 'c1'])
  })
})
