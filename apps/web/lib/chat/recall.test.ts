import { describe, expect, it } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import { writeTurnMemories, type TurnMemories } from './memory'
import { inMemoryStore } from './ports/memory.stub'
import { recall } from './recall'

const turn = (over: Partial<TurnMemories>): TurnMemories => ({ chatId: 'c1', turnId: 't1', typed: '', attached: [], made: [], decided: [], ...over })

const rows = () =>
  makeFakeAdmin({
    chats: [
      { id: 'c1', user_id: 'u1', title: 'AI roles at fintechs' },
      { id: 'c2', user_id: 'u2', title: 'Their own chat' },
    ],
    chat_turns: [
      { id: 't40', user_id: 'u1', chat_id: 'c1', kind: 'person', typed: 'I will only take roles that pay at least 200k' },
      { id: 't1', user_id: 'u1', chat_id: 'c1', kind: 'person', typed: 'Compare the six AI roles at fintechs' },
      { id: 'u2t', user_id: 'u2', chat_id: 'c2', kind: 'person', typed: 'I will only take roles that pay at least 200k' },
    ],
    artifacts: [{ id: 'a1', user_id: 'u1', type: 'comparison', title: 'Comparison of 6 AI roles', chat_turn_id: 't1' }],
  })

describe('recall', () => {
  it('finds a fact typed in the 40th turn from a new chat, reads it from its row and names its source', async () => {
    const store = inMemoryStore()
    await writeTurnMemories(store, 'u1', turn({ turnId: 't40', typed: 'I will only take roles that pay at least 200k' }))
    const hits = await recall(rows(), store, 'u1', 'which roles pay at least 200k, like I said')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      kind: 'said',
      text: 'I will only take roles that pay at least 200k',
      chat: { id: 'c1', title: 'AI roles at fintechs' },
      turnId: 't40',
      link: { kind: 'chat', id: 'c1', role: 'recalled', source: { chat_id: 'c1', turn_id: 't40' } },
    })
  })

  it('never returns another person\'s chat, even for the same words', async () => {
    const store = inMemoryStore()
    await writeTurnMemories(store, 'u1', turn({ turnId: 't40', typed: 'I will only take roles that pay at least 200k' }))
    await writeTurnMemories(store, 'u2', turn({ chatId: 'c2', turnId: 'u2t', typed: 'I will only take roles that pay at least 200k' }))
    const db = rows()
    expect((await recall(db, store, 'u1', 'roles that pay at least 200k')).map((h) => h.chat?.id)).toEqual(['c1'])
    expect((await recall(db, store, 'u2', 'roles that pay at least 200k')).map((h) => h.chat?.id)).toEqual(['c2'])
  })

  it('drops a hit whose row is gone, and a memory that points at another person\'s row', async () => {
    const store = inMemoryStore()
    await writeTurnMemories(store, 'u1', turn({ turnId: 't40', typed: 'I will only take roles that pay at least 200k' }))
    // A forged memory for u1 that names u2's turn.
    await writeTurnMemories(store, 'u1', turn({ chatId: 'c2', turnId: 'u2t', typed: 'roles that pay at least 200k' }))
    const db = rows()
    expect((await recall(db, store, 'u1', 'roles that pay at least 200k')).map((h) => h.turnId)).toEqual(['t40'])
    db.tables.chat_turns = db.tables.chat_turns.filter((t) => t.id !== 't40')
    expect(await recall(db, store, 'u1', 'roles that pay at least 200k')).toEqual([])
  })

  it('drops hits under the similarity floor and memories of other kinds', async () => {
    const store = inMemoryStore()
    await writeTurnMemories(store, 'u1', turn({ turnId: 't40', typed: 'I will only take roles that pay at least 200k' }))
    await store.add('u1', { fact: 'roles that pay at least 200k', scope: 'taste', refs: { chat_id: 'c1', turn_id: 't40' }, isDemo: false })
    expect(await recall(rows(), store, 'u1', 'pay and many other unrelated words about weather')).toEqual([])
    expect(await recall(rows(), store, 'u1', 'roles that pay at least 200k')).toHaveLength(1)
  })

  it('finds yesterday\'s comparison by words when the embedder is down', async () => {
    const db = rows()
    db.rpcHandlers.chat_recall_words = (args) => {
      expect(args.p_user).toBe('u1')
      expect(String(args.p_query)).toContain('compared')
      return [{ kind: 'made', chat_id: null, turn_id: 't1', artifact_id: 'a1' }]
    }
    const hits = await recall(db, inMemoryStore({ embedderDown: true }), 'u1', 'the six I compared yesterday')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      kind: 'made',
      text: 'Comparison of 6 AI roles',
      made: { id: 'a1', type: 'comparison' },
      chat: { id: 'c1', title: 'AI roles at fintechs' },
      link: { kind: 'made', table: 'artifacts', id: 'a1', role: 'recalled', source: { chat_id: 'c1', turn_id: 't1' } },
    })
  })

  it('says nothing found when the embedder is down and the query has no words', async () => {
    expect(await recall(rows(), inMemoryStore({ embedderDown: true }), 'u1', 'a b')).toEqual([])
  })
})
