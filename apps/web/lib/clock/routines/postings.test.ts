import { describe, expect, it } from 'vitest'
import type { RoutineContext, RoutineRow } from '../routines'
import { postingsBackfill } from './postings-backfill'
import { ALERT_MB, storageAlert } from './storage-alert'

const START = Date.parse('2026-10-08T12:00:00Z')

function context(rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>, over: Partial<RoutineContext> = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const admin = { rpc: async (name: string, args: Record<string, unknown>) => (calls.push({ name, args }), rpc(name, args)) }
  const ctx: RoutineContext = { admin: admin as never, routine: { id: 'r', user_id: null, command: 'x' } as RoutineRow, userId: null, state: null, now: () => START, deadlineAt: START + 200_000, ...over }
  return { ctx, calls }
}

describe('postings.backfill', () => {
  it('calls the backfill until it finds nothing to fill, and says what it did', async () => {
    const answers = [{ filled: 500, people_due: 3 }, { filled: 120, people_due: 0 }, { filled: 0, people_due: 0 }]
    const { ctx, calls } = context(async () => ({ data: answers.shift(), error: null }))
    expect(await postingsBackfill(ctx)).toEqual({ ok: true, found: { filled: 620, people_due: 3 } })
    expect(calls).toHaveLength(3)
    expect(calls[0]).toEqual({ name: 'backfill_posting_bodies', args: { p_limit: 500 } })
  })

  it('stops before the deadline and hands on its count', async () => {
    let now = START
    const { ctx } = context(async () => ({ data: { filled: 500, people_due: 1 }, error: null }), { now: () => (now += 80_000), deadlineAt: START + 200_000 })
    const out = await postingsBackfill(ctx)
    expect(out.next).toMatchObject({ filled: 1000, people_due: 2 })
    expect(out.found).toBeUndefined()
  })

  it('fails with a class, not the database\'s words', async () => {
    const { ctx } = context(async () => ({ data: null, error: { message: 'secret detail' } }))
    expect(await postingsBackfill(ctx)).toEqual({ ok: false, failure: 'backfill_failed' })
  })
})

describe('storage.alert', () => {
  it('only reports the size below the line, and clears nothing', async () => {
    const { ctx, calls } = context(async (name) => ({ data: name === 'measure_t8' ? [{ value: 120.5 }] : 0, error: null }))
    expect(await storageAlert(ctx)).toEqual({ ok: true, found: { mb: 120.5, over: false, cleared: 0 } })
    expect(calls.map((c) => c.name)).toEqual(['measure_t8'])
  })

  it('clears bodies in batches above 350 MB until none are left to clear', async () => {
    const batches = [500, 500, 40, 0]
    const { ctx, calls } = context(async (name) => ({ data: name === 'measure_t8' ? [{ value: String(ALERT_MB + 1) }] : batches.shift(), error: null }))
    expect(await storageAlert(ctx)).toEqual({ ok: true, found: { mb: ALERT_MB + 1, over: true, cleared: 1040 } })
    expect(calls.filter((c) => c.name === 'clear_untouched_posting_bodies')).toHaveLength(4)
  })

  it('stops before the deadline and carries on at the next slice', async () => {
    let now = START
    const { ctx } = context(async (name) => ({ data: name === 'measure_t8' ? [{ value: 400 }] : 500, error: null }), { now: () => (now += 90_000), deadlineAt: START + 200_000 })
    const out = await storageAlert(ctx)
    expect(out.next).toMatchObject({ cleared: 1000 })
  })

  it('says it cannot read the size, and never clears blind', async () => {
    const unreadable = context(async () => ({ data: null, error: { message: 'x' } }))
    expect(await storageAlert(unreadable.ctx)).toEqual({ ok: false, failure: 'size_unreadable' })
    const odd = context(async () => ({ data: [{ value: 'a lot' }], error: null }))
    expect(await storageAlert(odd.ctx)).toEqual({ ok: false, failure: 'size_unreadable' })
    expect(odd.calls.map((c) => c.name)).toEqual(['measure_t8'])
  })
})
