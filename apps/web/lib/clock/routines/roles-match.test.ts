import { describe, expect, it, vi } from 'vitest'
import { fakeDb } from '@/lib/companies/fake-db'
import type { RoutineContext } from '../routines'
import { matchWith, type MatchDeps } from './roles-match'

const NOW = Date.parse('2026-10-22T10:00:00Z')

/** Each person's waiting roles; judging removes them from the queue and marks the rows judged. */
function setup(queues: Record<string, string[]>, opts: { front?: string[]; used?: Record<string, number>; judge?: (user: string, ids: string[]) => { judged?: string[]; stopped?: string | null } | undefined; deadline?: number; state?: Record<string, unknown> | null } = {}) {
  const queue = new Map(Object.entries(queues).map(([u, ids]) => [u, [...ids]]))
  const { client, tables } = fakeDb({
    person_roles: Object.entries(queues).flatMap(([user_id, ids]) => ids.map((job_id) => ({ user_id, job_id, judged_at: null, hidden_reason: null }))),
    routines: [{ id: 'r1', args: { front: opts.front ?? [] } }],
    judge_budget: [{ day: '2026-10-22', calls: 0, by_user: opts.used ?? {} }],
  })
  const calls: [string, string[]][] = []
  const judge = vi.fn(async (_db: unknown, user: string, ids: readonly string[]) => {
    calls.push([user, [...ids]])
    const custom = opts.judge?.(user, [...ids])
    if (custom?.stopped) return { judged: custom.judged ?? [], failed: [], stopped: custom.stopped }
    const got = custom?.judged ?? [...ids]
    queue.set(user, (queue.get(user) ?? []).filter((id) => !got.includes(id)))
    for (const r of tables.person_roles) if (r.user_id === user && got.includes(r.job_id as string)) r.judged_at = 'now'
    return { judged: got, failed: [], stopped: null }
  })
  const sleeps: number[] = []
  const deps = {
    judge: judge as never,
    waiting: (async (_db: unknown, user: string, limit: number) => (queue.get(user) ?? []).slice(0, limit)) as never,
    sleep: async (ms: number) => void sleeps.push(ms),
  } satisfies MatchDeps
  let t = NOW
  const ctx = (): RoutineContext => ({ admin: client, routine: { id: 'r1', args: { front: opts.front ?? [] } } as never, userId: null, state: opts.state ?? null, now: () => t, deadlineAt: opts.deadline ?? NOW + 200_000 })
  return { run: () => matchWith(ctx(), deps), calls, sleeps, tables, tick: (ms: number) => void (t += ms) }
}

describe('roles.match', () => {
  it('takes people who asked first, then those who used the least of today, and three roles to a call', async () => {
    const t = setup({ a: ['a1'], b: ['b1', 'b2', 'b3', 'b4'], c: ['c1'] }, { front: ['c'], used: { a: 30, b: 2 } })
    const out = await t.run()
    expect(t.calls).toEqual([['c', ['c1']], ['b', ['b1', 'b2', 'b3']], ['b', ['b4']], ['a', ['a1']]])
    expect(out).toEqual({ ok: true, found: { judged: 6, waiting: 0, people: 3 } })
    // the ask is used up: the next run does not start with the same person
    expect((t.tables.routines[0].args as { front: string[] }).front).toEqual([])
  })

  it('moves on to the next person when a person day share is used, and leaves their roles waiting', async () => {
    const t = setup({ a: ['a1', 'a2'], b: ['b1'] }, { judge: (u) => (u === 'a' ? { stopped: 'day' } : undefined) })
    const out = await t.run()
    expect(t.calls.map((c) => c[0])).toEqual(['a', 'b'])
    expect(out).toEqual({ ok: true, found: { judged: 1, waiting: 2, people: 2 } })
  })

  it('stops the whole run when no model exists and says so', async () => {
    const t = setup({ a: ['a1'], b: ['b1'] }, { judge: () => ({ stopped: 'no_model' }) })
    const out = await t.run()
    expect(t.calls).toHaveLength(1)
    expect(out).toEqual({ ok: true, found: { judged: 0, waiting: 2, people: 2, stopped: 'no_model' } })
  })

  it('waits for the minute bucket and tries the same roles again, then gives up after a few waits', async () => {
    let n = 0
    const once = setup({ a: ['a1'] }, { judge: () => (n++ === 0 ? { stopped: 'minute' } : undefined) })
    expect((await once.run()).found).toMatchObject({ judged: 1, waiting: 0 })
    expect(once.sleeps).toEqual([3000])
    const always = setup({ a: ['a1'], b: ['b1'] }, { judge: () => ({ stopped: 'minute' }) })
    const out = await always.run()
    expect(always.sleeps).toHaveLength(5)
    expect(out).toEqual({ ok: true, found: { judged: 0, waiting: 2, people: 2 } })
  })

  it('hands on to the next slice when time runs out, and the next slice skips the people already done', async () => {
    let first = true
    const slow = setup({ a: ['a1'], b: ['b1'] }, { deadline: NOW + 1000, judge: () => (first ? (void (first = false), void slow.tick(5000), undefined) : undefined) })
    expect(await slow.run()).toEqual({ ok: true, next: { done: [], judged: 1, front: [] } })
    expect(slow.calls.map((c) => c[0])).toEqual(['a'])
    // a was stopped by the day share in the first slice: the second slice goes straight to b
    const next = setup({ a: ['a1'], b: ['b1'] }, { state: { done: ['a'], judged: 1, front: [] } })
    expect(await next.run()).toEqual({ ok: true, found: { judged: 2, waiting: 1, people: 2 } })
    expect(next.calls.map((c) => c[0])).toEqual(['b'])
  })

  it('does not ask again in the same slice for a role whose check came back unusable', async () => {
    // b2 and b3 stay waiting after the first call; the slice moves on to b4 instead of asking for them again
    const t = setup({ a: [], b: ['b1', 'b2', 'b3', 'b4'] }, { judge: (_u, ids) => (ids.includes('b2') ? { judged: ['b1'] } : undefined) })
    const out = await t.run()
    expect(t.calls).toEqual([['b', ['b1', 'b2', 'b3']], ['b', ['b4']]])
    expect(out).toEqual({ ok: true, found: { judged: 2, waiting: 2, people: 1 } })
  })

  it('does nothing when no role waits', async () => {
    const t = setup({})
    expect(await t.run()).toEqual({ ok: true, found: { judged: 0, waiting: 0, people: 0 } })
    expect(t.calls).toEqual([])
  })
})
