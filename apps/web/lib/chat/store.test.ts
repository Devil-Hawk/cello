import { describe, expect, it } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import { archiveChat, earlier, getChat, listChats } from './store'

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
