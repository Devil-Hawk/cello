import { describe, expect, it, vi } from 'vitest'
import type { RoutineContext } from '../routines'
import { clockPrune } from './prune'

// A fake service client: the SQL prune answers, and route_timings deletes with the given error.
function ctx(timingsError: unknown = null) {
  const lt = vi.fn(async () => ({ error: timingsError }))
  const admin = {
    rpc: vi.fn(async () => ({ data: { cron_runs: 0 }, error: null })),
    from: vi.fn(() => ({ delete: () => ({ lt }) })),
  }
  return { ctx: { admin } as unknown as RoutineContext, admin, lt }
}

describe('clock.prune', () => {
  it('deletes route timings older than 30 days, after the SQL prune', async () => {
    const { ctx: c, admin, lt } = ctx()
    const before = Date.now()
    expect(await clockPrune(c)).toEqual({ ok: true, found: { cron_runs: 0 } })
    expect(admin.rpc).toHaveBeenCalledWith('clock_prune')
    expect(admin.from).toHaveBeenCalledWith('route_timings')
    const [column, cutoff] = lt.mock.calls[0] as unknown as [string, string]
    expect(column).toBe('at')
    expect(Date.parse(cutoff)).toBeGreaterThanOrEqual(before - 30 * 86_400_000 - 1000)
    expect(Date.parse(cutoff)).toBeLessThanOrEqual(Date.now() - 30 * 86_400_000 + 1000)
  })

  it('reports a failed timing delete by name, not as a pass', async () => {
    const { ctx: c } = ctx({ message: 'boom' })
    expect(await clockPrune(c)).toEqual({ ok: false, failure: 'route_timings' })
  })
})
