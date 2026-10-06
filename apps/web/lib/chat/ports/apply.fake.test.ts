import { describe, expect, it } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import { readStatusLines } from '../status'
import { applyFake } from './apply.fake'

const seed = () =>
  makeFakeAdmin({
    applications: [
      { id: 'a1', user_id: 'u1', state: 'ready' },
      { id: 'a9', user_id: 'u2', state: 'ready' },
    ],
    pipeline_events: [],
  })

describe('applyFake', () => {
  it('moves an application with one event, which a status turn reads its words from, and a replay moves nothing', async () => {
    const db = seed()
    const port = applyFake(db)
    const move = { userId: 'u1', applicationId: 'a1', to: 'applying' as const, sentence: 'Cello is filling the form.', idempotencyKey: 'k1' }
    const first = await port.advance(move)
    expect(first).toMatchObject({ from_state: 'ready', to_state: 'applying' })
    expect(db.tables.applications[0].state).toBe('applying')
    const again = await port.advance(move)
    expect(again.id).toBe(first.id)
    expect(db.tables.pipeline_events).toHaveLength(1)
    expect((await readStatusLines(db, 'u1', [first.id]))[first.id]).toMatchObject({ sentence: 'Cello is filling the form.', applicationId: 'a1', state: 'applying' })
    expect(await readStatusLines(db, 'u2', [first.id])).toEqual({})
  })

  it('refuses another person\'s application, and a kind only the person may write', async () => {
    const port = applyFake(seed())
    await expect(port.advance({ userId: 'u1', applicationId: 'a9', to: 'sent', sentence: 'x', idempotencyKey: 'k2' })).rejects.toThrow('not this person')
    await expect(port.recordEvent({ userId: 'u1', applicationId: 'a1', kind: 'approval.decided', actor: 'cello', sentence: 'x', idempotencyKey: 'k3' })).rejects.toThrow('alone')
  })
})
