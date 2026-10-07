// clock.prune: the daily cleanup. The SQL (prune_stale_rows, old cron run records, old measure runs,
// command slots) lives in clock_prune(); this only runs it.

import type { RoutineContext, RoutineOutcome } from '../routines'

export async function clockPrune(ctx: RoutineContext): Promise<RoutineOutcome> {
  const { data, error } = await ctx.admin.rpc('clock_prune')
  if (error) return { ok: false, failure: 'clock_prune' }
  return { ok: true, found: (data ?? {}) as Record<string, unknown> }
}
