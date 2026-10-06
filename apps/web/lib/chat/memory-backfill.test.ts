import { describe, expect, it, vi } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import { backfillPerson } from './memory-backfill'
import { inMemoryStore } from './ports/memory.stub'

const rows = () =>
  makeFakeAdmin({
    chat_turns: [
      { id: 't1', user_id: 'u1', chat_id: 'c1', kind: 'person', typed: 'Compare these roles', superseded_at: null, created_at: '2026-10-01T10:00:00Z' },
      { id: 't2', user_id: 'u1', chat_id: 'c1', kind: 'person', typed: 'Draft a note', superseded_at: null, created_at: '2026-10-01T11:00:00Z' },
      { id: 't3', user_id: 'u1', chat_id: 'c1', kind: 'person', typed: 'An edited-away turn', superseded_at: '2026-10-02T00:00:00Z', created_at: '2026-10-01T12:00:00Z' },
      { id: 't4', user_id: 'u1', chat_id: 'c1', kind: 'cello', typed: null, superseded_at: null, created_at: '2026-10-01T10:01:00Z' },
      { id: 'x1', user_id: 'u2', chat_id: 'c9', kind: 'person', typed: 'Someone else', superseded_at: null, created_at: '2026-10-01T10:00:00Z' },
    ],
    artifacts: [{ id: 'a1', user_id: 'u1', type: 'dossier', title: 'Comparison of 3 roles', created_at: '2026-10-01T10:02:00Z', chat_turn_id: 't1' }],
  })

describe('backfillPerson', () => {
  it('writes a said memory per person turn and a made memory per made thing, and the counts agree', async () => {
    const store = inMemoryStore()
    expect(await backfillPerson(rows(), store, 'u1')).toEqual({ expected: 3, held: 3, written: 3, failed: 0 })
    expect(store.items.map((m) => m.memory).sort()).toEqual(['Compare these roles', 'Draft a note', 'Made dossier: Comparison of 3 roles. Oct 1.'])
    expect(store.items.every((m) => m.userId === 'u1')).toBe(true)
  })

  it('writes nothing the second time', async () => {
    const store = inMemoryStore()
    await backfillPerson(rows(), store, 'u1')
    expect(await backfillPerson(rows(), store, 'u1')).toEqual({ expected: 3, held: 3, written: 0, failed: 0 })
    expect(store.items).toHaveLength(3)
  })

  it('adds only what is missing: a made thing whose turn already has its said memory', async () => {
    const store = inMemoryStore()
    await store.add('u1', { fact: 'Compare these roles', scope: 'chat.said', refs: { chat_id: 'c1', turn_id: 't1' }, isDemo: false })
    const out = await backfillPerson(rows(), store, 'u1')
    expect(out).toMatchObject({ expected: 3, held: 3, written: 2 })
  })

  it('reports a shortfall when a write fails, so the run can exit 1', async () => {
    const store = inMemoryStore()
    vi.spyOn(store, 'add').mockRejectedValueOnce(new Error('store down'))
    const out = await backfillPerson(rows(), store, 'u1')
    expect(out.failed).toBe(1)
    expect(out.held).toBeLessThan(out.expected)
  })
})
