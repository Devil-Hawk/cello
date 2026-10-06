import { describe, expect, it } from 'vitest'
import type { RoutineContext, RoutineRow } from '../routines'
import { MAX_ROUNDS, suggestionsRefreshWith } from './suggestions-refresh'

const row: RoutineRow = { id: 'r1', user_id: null, command: 'suggestions.refresh', args: {}, local_time: '14:30', every: null, timezone: 'UTC', next_due_at: null, enabled: true, slice: null }
const ctx = (state: Record<string, unknown> | null = null): RoutineContext => ({ admin: {} as never, routine: row, userId: null, state, now: () => 0, deadlineAt: 1_000 })

describe('suggestions.refresh', () => {
  it('hands on to the next slice while people are still due, and stops when they are done', async () => {
    const more = await suggestionsRefreshWith(ctx(), async () => ({ refreshed: 6, failed: 0, skipped: 20 }))
    expect(more).toMatchObject({ ok: true, found: { refreshed: 6, skipped: 20 }, next: { rounds: 1 } })
    const done = await suggestionsRefreshWith(ctx({ rounds: 3 }), async () => ({ refreshed: 4, failed: 1, skipped: 0 }))
    expect(done.next).toBeUndefined()
  })

  it('does not hand on when a slice did nothing, or after the last round', async () => {
    expect((await suggestionsRefreshWith(ctx(), async () => ({ refreshed: 0, failed: 0, skipped: 5 }))).next).toBeUndefined()
    expect((await suggestionsRefreshWith(ctx({ rounds: MAX_ROUNDS - 1 }), async () => ({ refreshed: 6, failed: 0, skipped: 5 }))).next).toBeUndefined()
  })

  it('passes the slice deadline on, so no person starts after it', async () => {
    let seen: number | null = null
    await suggestionsRefreshWith(ctx(), async (_admin, opts) => ((seen = opts.deadlineAt), { refreshed: 0, failed: 0, skipped: 0 }))
    expect(seen).toBe(1_000)
  })
})
