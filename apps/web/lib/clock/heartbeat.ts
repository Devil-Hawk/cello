// A routine's heartbeat: the one record the pages read for "last check" and "next check".
// The functions live in the database (start_heartbeat, finish_heartbeat); callers use the service role.

import type { SupabaseClient } from '@supabase/supabase-js'

type Db = SupabaseClient<any, any, any>

export interface HeartbeatResult {
  ok: boolean
  /** What the run counted: boards read, roles kept, counted out, cannot read. */
  found?: Record<string, unknown>
  /** Why it failed. A class of failure, never a URL or a secret. */
  failure?: string | null
  durationMs: number
  /** When it is next due (a success only). */
  nextDue?: Date | null
}

export async function startHeartbeat(db: Db, job: string, userId: string | null): Promise<void> {
  const { error } = await db.rpc('start_heartbeat', { p_job: job, p_user: userId })
  if (error) throw new Error(`start_heartbeat: ${error.code ?? 'failed'}`)
}

export async function finishHeartbeat(db: Db, job: string, userId: string | null, r: HeartbeatResult): Promise<void> {
  const { error } = await db.rpc('finish_heartbeat', {
    p_job: job,
    p_user: userId,
    p_ok: r.ok,
    p_found: r.found ?? {},
    p_failure: r.ok ? null : (r.failure ?? 'failed'),
    p_duration_ms: Math.max(0, Math.round(r.durationMs)),
    p_next_due: r.nextDue ? r.nextDue.toISOString() : null,
  })
  if (error) throw new Error(`finish_heartbeat: ${error.code ?? 'failed'}`)
}

/** Time a slice that does not finish its routine against the meter without touching its heartbeat. */
export async function recordMeter(db: Db, ms: number): Promise<void> {
  await db.rpc('record_meter', { p_ms: Math.max(0, Math.round(ms)) })
}
