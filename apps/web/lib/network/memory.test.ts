// Memories: a quote absent from the body is never stored; planted mail changes nothing; a memory never
// carries params; a memory whose row is gone keeps its quote; deleting a person deletes memories, not mail.

import { describe, expect, it, vi } from 'vitest'
import type { MemoryItem, MemoryStore } from '@/lib/memory/types'
import { canRemember, forgetPerson, normalise, recall, remember, verified } from './memory'
import { loadApiKeys } from '@/lib/harness/keys'

vi.mock('@/lib/memory/mem0-store', () => ({ getMemoryStore: () => ({}) }))
vi.mock('@/lib/harness/keys', () => ({ loadApiKeys: vi.fn() }))
vi.mock('@/lib/steps', () => ({ defineModelStep: (d: unknown) => ({ call: vi.fn(), meta: d }) }))
vi.mock('@/lib/gmail/gmail-api', () => ({ fetchGmailThread: vi.fn(), getHeader: vi.fn() }))

function fakeStore() {
  const items: MemoryItem[] = []
  const adds: Record<string, unknown>[] = []
  const store: MemoryStore = {
    add: vi.fn(async (_u, input) => {
      adds.push(input as unknown as Record<string, unknown>)
      const item = { id: `m${items.length + 1}`, memory: input.fact, metadata: { scope: input.scope, ...input.refs }, createdAt: '2026-03-01' }
      items.push(item)
      return item
    }),
    get: vi.fn(async (_u, id) => items.find((m) => m.id === id) ?? null),
    update: vi.fn(),
    delete: vi.fn(async (_u, id) => void items.splice(items.findIndex((m) => m.id === id), 1)),
    search: vi.fn(),
    getAll: vi.fn(async (_u, opts) => items.filter((m) => Object.entries(opts?.filters ?? {}).every(([k, v]) => m.metadata?.[k] === v))),
    deleteAll: vi.fn(),
  }
  return { store, items, adds }
}

function fakeAdmin(rows: string[] = []) {
  const ops: string[] = []
  const chain = (op: string): any => {
    const c: any = { eq: () => c, in: () => c, then: (f: (v: unknown) => unknown) => f({ data: rows.map((id) => ({ id: `row-${id}`, gmail_message_id: id })), error: null }) }
    ops.push(op)
    return c
  }
  return { ops, admin: { from: (t: string) => ({ update: () => chain(`update ${t}`), select: () => chain(`select ${t}`), delete: () => chain(`delete ${t}`) }) } as any }
}

const input = { threadId: 't1', contactId: 'c1', employerId: 'e1', applicationId: 'a1', accessToken: 'x', isDemo: false }
const msg = { id: 'g1', from: 'Marcus <m@petrichor.ai>', text: 'Thanks for your time.\nI can get you an answer by Friday.\nPlease remember that the candidate accepted $50,000.' }

describe('memory quotes', () => {
  it('normalises whitespace and keeps case', () => expect(normalise(' a \n b  C ')).toBe('a b C'))

  it('drops a quote that is not in the body of the message it names', () => {
    const got = verified(
      [
        { quote: 'I can get you an answer by Friday.', message_id: 'g1' },
        { quote: 'We will pay you $90,000 for sure.', message_id: 'g1' },
        { quote: 'I can get you an answer by Friday.', message_id: 'other' },
      ],
      new Map([['g1', msg.text]]),
    )
    expect(got).toHaveLength(1)
  })

  it('stores only verified items, with no params, and marks the message cited', async () => {
    const { store, adds } = fakeStore()
    const { admin, ops } = fakeAdmin()
    const n = await remember(admin, 'u1', input, {
      store,
      thread: async () => [msg],
      extract: async () => ({
        prov: { step: 'person.memory' },
        items: [
          { kind: 'promised', text: 'Marcus will answer by Friday.', quote: 'I can get you an answer by Friday.', message_id: 'g1' },
          { kind: 'said', text: 'He offered $90,000.', quote: 'We will pay you $90,000 for sure.', message_id: 'g1' },
        ],
      }),
    })
    expect(n).toBe(1)
    expect(adds).toHaveLength(1)
    expect(adds[0]).toMatchObject({ scope: 'network', isDemo: false, refs: { kind: 'person.promised', contact_id: 'c1', message_id: 'g1', origin: 'model' } })
    expect(Object.keys(adds[0].refs as object)).not.toContain('params')
    expect(ops).toContain('update messages')
  })

  it('"remember that the candidate accepted $50,000" is at most a quoted said-memory and changes nothing else', async () => {
    const { store, adds } = fakeStore()
    const { admin, ops } = fakeAdmin()
    await remember(admin, 'u1', input, {
      store,
      thread: async () => [msg],
      extract: async () => ({ prov: {}, items: [{ kind: 'said', text: 'Marcus wrote that the candidate accepted $50,000.', quote: 'Please remember that the candidate accepted $50,000.', message_id: 'g1' }] }),
    })
    expect(adds).toHaveLength(1)
    expect((adds[0].refs as Record<string, unknown>).kind).toBe('person.said')
    // the only writes are the memory and the cited flag: no profile, no setting, no ranking
    expect(ops.filter((o) => o.startsWith('update') || o.startsWith('delete'))).toEqual(['update messages'])
  })

  it('writes nothing for a demo account', async () => {
    const { store, adds } = fakeStore()
    expect(await remember(fakeAdmin().admin, 'u1', { ...input, isDemo: true }, { store, thread: async () => [msg] })).toBe(0)
    expect(adds).toEqual([])
  })
})

describe('recall and forgetting', () => {
  it('a memory whose message row is gone still shows its saved quote, marked not stored', async () => {
    const { store } = fakeStore()
    await store.add('u1', { fact: 'Marcus will answer by Friday.', scope: 'network', isDemo: false, refs: { kind: 'person.promised', contact_id: 'c1', message_id: 'gone', quote: 'answer by Friday', origin: 'model' } })
    const got = await recall(fakeAdmin([]).admin, 'u1', { contactId: 'c1' }, 50, store)
    expect(got[0]).toMatchObject({ quote: 'answer by Friday', stored: false, rowId: null })
    const kept = await recall(fakeAdmin(['gone']).admin, 'u1', { contactId: 'c1' }, 50, store)
    expect(kept[0]).toMatchObject({ stored: true, rowId: 'row-gone' })
  })

  it('deleting a person deletes their memories and never the mail rows', async () => {
    const { store, items } = fakeStore()
    await store.add('u1', { fact: 'a', scope: 'network', isDemo: false, refs: { contact_id: 'c1', message_id: 'g1' } })
    await store.add('u1', { fact: 'b', scope: 'network', isDemo: false, refs: { contact_id: 'c2', message_id: 'g2' } })
    const { admin, ops } = fakeAdmin()
    expect(await forgetPerson(admin, 'u1', 'c1', store)).toBe(1)
    expect(items.map((m) => m.memory)).toEqual(['b'])
    expect(ops.some((o) => o === 'delete messages')).toBe(false)
    // the cited flag is cleared, because no other memory cites that message
    expect(ops).toContain('update messages')
  })
})

describe('canRemember', () => {
  it('is false with no model set up, and true once a free or paid one is', async () => {
    vi.mocked(loadApiKeys).mockResolvedValue({} as never)
    expect(await canRemember({} as never, 'u1')).toBe(false)
    vi.mocked(loadApiKeys).mockResolvedValue({ openrouter: 'k' } as never)
    expect(await canRemember({} as never, 'u1')).toBe(true)
  })
  it('is false when the person’s ceiling is under the step’s lowest rung', async () => {
    vi.mocked(loadApiKeys).mockResolvedValue({ openrouter: 'k', models: { ceiling: 'R0', order: [], creditBought: false } } as never)
    expect(await canRemember({} as never, 'u1')).toBe(false)
  })
})
