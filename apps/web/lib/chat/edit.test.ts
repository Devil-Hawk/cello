import { describe, expect, it } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import { forkFromTurn } from './edit'

const turn = (id: string, kind: string, at: number, over: Record<string, unknown> = {}) => ({
  id,
  user_id: 'u1',
  chat_id: 'c1',
  kind,
  typed: kind === 'person' ? `words ${id}` : null,
  created_at: new Date(Date.UTC(2026, 9, 5, 10, at)).toISOString(),
  superseded_at: null,
  ran: null,
  ...over,
})
const seed = () =>
  makeFakeAdmin({
    chat_turns: [turn('t1', 'person', 0, { ran: { checkpoint_id: 'cp-1' } }), turn('t2', 'cello', 1), turn('t3', 'person', 2), turn('t4', 'cello', 3), turn('x1', 'person', 2, { user_id: 'u2', chat_id: 'c9' })],
  })

describe('forkFromTurn', () => {
  it('keeps the old branch, marks it superseded from that turn on, and starts the new turn from the same checkpoint', async () => {
    const db = seed()
    const out = await forkFromTurn(db, 'u1', 'c1', 't3', 'Better words')
    expect(out).toMatchObject({ ok: true, checkpointId: null })
    const rows = db.tables.chat_turns
    expect(rows).toHaveLength(6)
    expect(rows.filter((r) => r.superseded_at).map((r) => r.id).sort()).toEqual(['t3', 't4'])
    expect(rows.find((r) => r.id === 't1')?.superseded_at).toBeNull()
    const fresh = rows[rows.length - 1]
    expect(fresh).toMatchObject({ kind: 'person', typed: 'Better words', origin: 'person', branch_of: 't3', chat_id: 'c1', user_id: 'u1' })
  })

  it('hands the engine the checkpoint the old turn ran from', async () => {
    const out = await forkFromTurn(seed(), 'u1', 'c1', 't1', 'Another way to ask')
    expect(out).toMatchObject({ ok: true, checkpointId: 'cp-1' })
  })

  it('refuses another person\'s turn, one of Cello\'s turns, one already replaced, and empty words', async () => {
    const db = seed()
    expect(await forkFromTurn(db, 'u1', 'c1', 'x1', 'x')).toMatchObject({ ok: false })
    expect(await forkFromTurn(db, 'u1', 'c1', 't2', 'x')).toMatchObject({ ok: false })
    expect(await forkFromTurn(db, 'u2', 'c1', 't1', 'x')).toMatchObject({ ok: false })
    expect(await forkFromTurn(db, 'u1', 'c1', 't1', '   ')).toMatchObject({ ok: false })
    await forkFromTurn(db, 'u1', 'c1', 't3', 'Replaced')
    expect(await forkFromTurn(db, 'u1', 'c1', 't3', 'Again')).toMatchObject({ ok: false })
    expect(db.tables.chat_turns.filter((r) => r.branch_of)).toHaveLength(1)
  })
})
