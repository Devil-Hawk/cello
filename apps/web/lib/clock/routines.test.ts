import { describe, expect, it, vi } from 'vitest'
import { LEASE_MS, RETRY_MS, SLICE_MS, runRoutine, type RoutineHandler, type RoutineRow } from './routines'

const NOW = Date.parse('2026-10-08T12:00:30Z')

/** An in-memory routines table and the three clock functions, shaped like the Supabase client. */
function fakeAdmin(initial: Partial<RoutineRow> & { lease_until?: string | null }) {
  const row: Record<string, unknown> = {
    id: 'r1',
    user_id: 'u1',
    command: 'roles.check',
    args: {},
    local_time: null,
    every: '06:00:00',
    timezone: 'UTC',
    next_due_at: '2026-10-08T12:00:00Z',
    enabled: true,
    slice: null,
    lease_until: null,
    poked_at: '2026-10-08T12:00:01Z',
    ...initial,
  }
  const rpcs: { name: string; args: Record<string, unknown> }[] = []
  const updates: Record<string, unknown>[] = []

  const admin = {
    from(table: string) {
      if (table !== 'routines') throw new Error(table)
      let patch: Record<string, unknown> | null = null
      let orCondition: string | null = null
      const matches = () => {
        if (!orCondition) return true
        const m = /lease_until\.is\.null,lease_until\.lt\.(.+)$/.exec(orCondition)
        const lease = row.lease_until as string | null
        return lease === null || (m !== null && Date.parse(lease) < Date.parse(m[1]))
      }
      const apply = () => {
        if (!patch || !matches()) return { data: [], error: null }
        Object.assign(row, patch)
        updates.push(patch)
        return { data: [{ id: row.id }], error: null }
      }
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({ data: { ...row }, error: null }),
        update: (p: Record<string, unknown>) => {
          patch = p
          return b
        },
        or: (c: string) => {
          orCondition = c
          return b
        },
        then: (resolve: (v: unknown) => unknown) => resolve(apply()),
      }
      return b
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args })
      return { data: null, error: null }
    },
  }
  return { admin: admin as never, row, rpcs, updates }
}

const ok: RoutineHandler = async () => ({ ok: true, found: { employers: 3 } })

describe('runRoutine', () => {
  it('runs a due routine once, writes its heartbeat and moves its next due time on the grid', async () => {
    const { admin, row, rpcs } = fakeAdmin({})
    const handler = vi.fn(ok)
    const report = await runRoutine(admin, 'r1', null, { handlers: { 'roles.check': handler }, now: () => NOW, post: vi.fn() })
    expect(report).toEqual({ ran: true, done: true, ok: true })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(rpcs.map((r) => r.name)).toEqual(['start_heartbeat', 'finish_heartbeat'])
    const finish = rpcs[1].args
    expect(finish).toMatchObject({ p_job: 'roles.check', p_user: 'u1', p_ok: true, p_found: { employers: 3 }, p_failure: null })
    // due 12:00, six hours: 18:00 whatever time it ran
    expect(row.next_due_at).toBe('2026-10-08T18:00:00.000Z')
    expect(finish.p_next_due).toBe('2026-10-08T18:00:00.000Z')
    expect(row.lease_until).toBeNull()
    expect(row.slice).toBeNull()
  })

  it('gives the handler a deadline inside one slice, which is inside 240 seconds', async () => {
    const { admin } = fakeAdmin({})
    let seen = 0
    await runRoutine(admin, 'r1', null, { handlers: { 'roles.check': async (ctx) => ((seen = ctx.deadlineAt - NOW), { ok: true }) }, now: () => NOW, post: vi.fn() })
    expect(seen).toBe(SLICE_MS)
    expect(SLICE_MS).toBeLessThan(240_000)
  })

  it('does not run a routine that is not due, is disabled, has no handler, or is already running a slice', async () => {
    const handler = vi.fn(ok)
    const deps = { handlers: { 'roles.check': handler }, now: () => NOW, post: vi.fn() }
    expect(await runRoutine(fakeAdmin({ next_due_at: '2026-10-08T13:00:00Z' }).admin, 'r1', null, deps)).toEqual({ ran: false, reason: 'not_due' })
    expect(await runRoutine(fakeAdmin({ enabled: false }).admin, 'r1', null, deps)).toEqual({ ran: false, reason: 'disabled' })
    expect(await runRoutine(fakeAdmin({ command: 'roles.render' }).admin, 'r1', null, deps)).toEqual({ ran: false, reason: 'no_handler' })
    expect(await runRoutine(fakeAdmin({ lease_until: new Date(NOW + 60_000).toISOString() }).admin, 'r1', null, deps)).toEqual({ ran: false, reason: 'busy' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('takes over a slice whose lease ran out', async () => {
    const handler = vi.fn(ok)
    const { admin, row } = fakeAdmin({ lease_until: new Date(NOW - 1000).toISOString() })
    const report = await runRoutine(admin, 'r1', null, { handlers: { 'roles.check': handler }, now: () => NOW, post: vi.fn() })
    expect(report.ran).toBe(true)
    expect(row.lease_until).toBeNull()
  })

  it('holds a lease while it runs, longer than a slice', async () => {
    const { admin, updates } = fakeAdmin({})
    await runRoutine(admin, 'r1', null, { handlers: { 'roles.check': ok }, now: () => NOW, post: vi.fn() })
    const lease = updates.find((u) => typeof u.lease_until === 'string')
    expect(Date.parse(lease?.lease_until as string) - NOW).toBe(LEASE_MS)
    expect(LEASE_MS).toBeGreaterThan(SLICE_MS)
  })

  it('hands the rest on as a signed slice when a handler says there is more, and does not finish the heartbeat', async () => {
    const { admin, row, rpcs } = fakeAdmin({})
    const post = vi.fn()
    let t = NOW
    const handler: RoutineHandler = async () => {
      t += 200_000
      return { ok: true, next: { done: ['c1', 'c2'] } }
    }
    const report = await runRoutine(admin, 'r1', null, { handlers: { 'roles.check': handler }, now: () => t, post })
    expect(report).toEqual({ ran: true, done: false, ok: true })
    expect(post).toHaveBeenCalledWith({ reason: 'routine', routine_id: 'r1', slice: { elapsed_ms: 200_000, state: { done: ['c1', 'c2'] } } })
    expect(rpcs.map((r) => r.name)).toEqual(['start_heartbeat', 'record_meter'])
    expect(rpcs[1].args).toEqual({ p_ms: 200_000 })
    expect(row.lease_until).toBeNull()
    expect(row.next_due_at).toBe('2026-10-08T12:00:00Z') // still due: a killed slice is found again
  })

  it('carries the slice state in, adds up the time, and does not start a second heartbeat', async () => {
    const { admin, rpcs } = fakeAdmin({})
    let state: unknown = null
    const handler: RoutineHandler = async (ctx) => ((state = ctx.state), { ok: true })
    await runRoutine(admin, 'r1', { elapsed_ms: 200_000, state: { done: ['c1'] } }, { handlers: { 'roles.check': handler }, now: () => NOW, post: vi.fn() })
    expect(state).toEqual({ done: ['c1'] })
    expect(rpcs.map((r) => r.name)).toEqual(['finish_heartbeat'])
    expect(rpcs[0].args.p_duration_ms).toBe(200_000)
  })

  it('records a failure by its class, tries again in ten minutes, and never stores a message', async () => {
    const { admin, row, rpcs } = fakeAdmin({})
    class BoardError extends Error {
      constructor() {
        super('https://secret.example/path said no')
        this.name = 'BoardError'
      }
    }
    const handler: RoutineHandler = async () => {
      throw new BoardError()
    }
    const report = await runRoutine(admin, 'r1', null, { handlers: { 'roles.check': handler }, now: () => NOW, post: vi.fn() })
    expect(report).toEqual({ ran: true, done: true, ok: false })
    expect(rpcs[1].args).toMatchObject({ p_ok: false, p_failure: 'BoardError', p_next_due: new Date(NOW + RETRY_MS).toISOString() })
    expect(JSON.stringify(rpcs)).not.toContain('secret.example')
    expect(row.next_due_at).toBe(new Date(NOW + RETRY_MS).toISOString())
  })

  it('has no next time for a switch', async () => {
    const { admin, row } = fakeAdmin({ command: 'x', every: null, local_time: null, next_due_at: null })
    await runRoutine(admin, 'r1', null, { handlers: { x: ok }, now: () => NOW, post: vi.fn() })
    expect(row.next_due_at).toBeNull()
  })
})
