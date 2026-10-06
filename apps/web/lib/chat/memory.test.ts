import { describe, expect, it, vi } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import { deleteChat, deleteChatMemories, isChatMemory, renderDecided, renderMade, renderSaid, SAID_MAX, writeTurnMemories, type TurnMemories } from './memory'
import { inMemoryStore } from './ports/memory.stub'

const turn = (over: Partial<TurnMemories> = {}): TurnMemories => ({
  chatId: 'c1',
  turnId: 't1',
  typed: 'Compare the six AI roles at fintechs',
  attached: ['Ramp', 'Linear'],
  made: [{ id: 'a1', type: 'comparison', title: 'Comparison of 6 AI roles', created_at: '2026-10-05T18:00:00Z' }],
  decided: [{ sentence: 'Started 1 role', at: '2026-10-05T18:01:00Z', eventId: 'e1' }],
  ...over,
})

describe('writeTurnMemories', () => {
  it('writes one said, one made and one decided memory whose text is code\'s rendering of the row', async () => {
    const store = inMemoryStore()
    expect(await writeTurnMemories(store, 'u1', turn())).toEqual({ written: 3, failed: 0 })
    const text = Object.fromEntries(store.items.map((m) => [String(m.metadata?.scope), m.memory]))
    expect(text['chat.said']).toBe(renderSaid('Compare the six AI roles at fintechs'))
    expect(text['chat.made']).toBe('Made comparison: Comparison of 6 AI roles. Oct 5.')
    expect(text['chat.made']).toBe(renderMade({ type: 'comparison', title: 'Comparison of 6 AI roles', created_at: '2026-10-05T18:00:00Z' }))
    expect(text['chat.decided']).toBe(renderDecided({ sentence: 'Started 1 role', at: '2026-10-05T18:01:00Z' }))
    expect(text['chat.decided']).toBe('Decided: Started 1 role. Oct 5.')
  })

  it('writes the typed line as a fact, never as messages for a model to read, and with no params', async () => {
    const store = inMemoryStore()
    const add = vi.spyOn(store, 'add')
    await writeTurnMemories(store, 'u1', turn())
    for (const [, input] of add.mock.calls) {
      expect(typeof input.fact).toBe('string')
      expect(input).not.toHaveProperty('messages')
      expect(input.refs).not.toHaveProperty('params')
      expect(input.isDemo).toBe(false)
    }
    expect(add.mock.calls.find(([, i]) => i.scope === 'chat.said')?.[1].refs).toMatchObject({ chat_id: 'c1', turn_id: 't1', attached: ['Ramp', 'Linear'], origin: 'person' })
    expect(add.mock.calls.find(([, i]) => i.scope === 'chat.made')?.[1].refs).toMatchObject({ table: 'artifacts', id: 'a1', origin: 'code' })
  })

  it('cuts a said memory at 400 characters', async () => {
    const store = inMemoryStore()
    await writeTurnMemories(store, 'u1', turn({ typed: 'word '.repeat(300), made: [], decided: [] }))
    expect(store.items[0].memory.length).toBeLessThanOrEqual(SAID_MAX)
    expect(renderSaid('short  line')).toBe('short line')
  })

  it('does not fail the turn when a write fails, and writes nothing for a demo session', async () => {
    const store = inMemoryStore()
    vi.spyOn(store, 'add').mockRejectedValueOnce(new Error('store down'))
    expect(await writeTurnMemories(store, 'u1', turn())).toEqual({ written: 2, failed: 1 })
    expect(await writeTurnMemories(inMemoryStore(), 'u1', turn(), true)).toEqual({ written: 0, failed: 0 })
  })

  it('marks its memories so a list of learnings can leave them out', () => {
    expect(isChatMemory({ metadata: { scope: 'chat.said' } })).toBe(true)
    expect(isChatMemory({ metadata: { scope: 'copilot' } })).toBe(false)
    expect(isChatMemory({})).toBe(false)
  })
})

describe('deleting a chat', () => {
  const setup = async () => {
    const store = inMemoryStore()
    await writeTurnMemories(store, 'u1', turn())
    await writeTurnMemories(store, 'u1', turn({ chatId: 'c2', turnId: 't2', made: [], decided: [] }))
    await writeTurnMemories(store, 'u2', turn({ chatId: 'c1', made: [], decided: [] }))
    const db = makeFakeAdmin({
      chats: [
        { id: 'c1', user_id: 'u1' },
        { id: 'c2', user_id: 'u1' },
      ],
      artifacts: [{ id: 'a1', user_id: 'u1', chat_turn_id: 't1' }],
    })
    return { store, db }
  }

  it('deletes that chat\'s memories and the chat, and nothing else', async () => {
    const { store, db } = await setup()
    expect(await deleteChat(db, store, 'u1', 'c1')).toBe(true)
    expect(db.tables.chats.map((c) => c.id)).toEqual(['c2'])
    expect(db.tables.artifacts).toHaveLength(1)
    expect(store.items.filter((m) => m.userId === 'u1' && m.metadata?.chat_id === 'c1')).toHaveLength(0)
    expect(store.items.filter((m) => m.userId === 'u1' && m.metadata?.chat_id === 'c2')).toHaveLength(1)
    expect(store.items.filter((m) => m.userId === 'u2')).toHaveLength(1)
  })

  it('refuses a chat that is not the person\'s and deletes none of its memories', async () => {
    const { store, db } = await setup()
    expect(await deleteChat(db, store, 'u2', 'c1')).toBe(false)
    expect(db.tables.chats).toHaveLength(2)
    expect(store.items).toHaveLength(3 + 1 + 1)
    expect(await deleteChatMemories(store, 'u2', 'c2')).toBe(0)
  })
})
