// The meter: function time this month against the free server's allowance.
//
// ponytail: 80 percent (8 / 10) of Vercel Hobby's 360 GB-hours at 2 GB (/ 2). An estimate until the measured slice
// day (SP6) replaces it. The same number is in migration 20261008040000 (clock_allowance_ms), and a
// test keeps the two equal.

import type { SupabaseClient } from '@supabase/supabase-js'

type Db = SupabaseClient<any, any, any>

export const ALLOWANCE_MS = (8 * 360 * 3_600_000) / 20

export interface MeterState {
  usedMs: number
  allowanceMs: number
  /** 0 to 1 and over. */
  share: number
  paused: boolean
}

export function monthStart(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`
}

export async function meterState(db: Db, now: Date = new Date()): Promise<MeterState> {
  const { data } = await db.from('clock_meter').select('duration_ms').eq('month', monthStart(now)).maybeSingle()
  const usedMs = Number((data as { duration_ms?: number | string } | null)?.duration_ms ?? 0)
  return { usedMs, allowanceMs: ALLOWANCE_MS, share: usedMs / ALLOWANCE_MS, paused: usedMs >= ALLOWANCE_MS }
}

/** "Nov 1", the day the month's allowance starts again. */
export function allowanceResets(now: Date): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return `${next.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} 1`
}
