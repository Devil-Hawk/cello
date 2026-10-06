// storage.alert: the database's alert at 350 MB of the free plan's 500 (blueprint 3.5), on the clock, daily.
//
// Below the line it only reports the size. Above it, it clears posting bodies in batches (clear_untouched_posting_bodies:
// only a role nobody saved or applied to; the hash, the requirement items and their quotes stay), and says that it
// did, in the heartbeat the owner's health row and the scorecard read. Opening a cleared role reads it live again.
// It removes no capability and deletes no person's own records.

import type { RoutineContext, RoutineOutcome } from '../routines'

/** The alert line, in MB. T8 holds the database to it. */
export const ALERT_MB = 350
const BATCH = 500

export async function storageAlert(ctx: RoutineContext): Promise<RoutineOutcome> {
  const { data, error } = await ctx.admin.rpc('measure_t8')
  if (error) return { ok: false, failure: 'size_unreadable' }
  const row = (Array.isArray(data) ? data[0] : data) as { value?: number | string } | null
  const mb = Number(row?.value)
  if (!Number.isFinite(mb)) return { ok: false, failure: 'size_unreadable' }
  if (mb <= ALERT_MB) return { ok: true, found: { mb, over: false, cleared: 0 } }

  let cleared = Number(ctx.state?.cleared ?? 0)
  while (ctx.now() < ctx.deadlineAt) {
    const { data: n, error: clearError } = await ctx.admin.rpc('clear_untouched_posting_bodies', { p_limit: BATCH })
    if (clearError) return { ok: false, failure: 'clear_failed' }
    const done = Number(n ?? 0)
    cleared += done
    if (done === 0) return { ok: true, found: { mb, over: true, cleared } }
  }
  return { ok: true, next: { cleared } }
}
