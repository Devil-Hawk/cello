// clock.meter: hourly, writes this month's use of the free server's allowance onto its heartbeat,
// so the owner's health check and the scorecard read one number.

import { meterState } from '../meter'
import type { RoutineContext, RoutineOutcome } from '../routines'

export async function clockMeter(ctx: RoutineContext): Promise<RoutineOutcome> {
  const m = await meterState(ctx.admin, new Date(ctx.now()))
  return { ok: true, found: { used_ms: m.usedMs, allowance_ms: m.allowanceMs, share: Math.round(m.share * 1000) / 1000, paused: m.paused } }
}
