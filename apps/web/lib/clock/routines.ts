// The runner of the clock. The sweeper posts a due routine to /api/agent/continue; the route calls
// runRoutine, which takes a lease, runs the routine's handler for at most one slice (240 seconds),
// and either posts the next slice or writes the heartbeat and the next due time.
//
// A routine that fails is tried again in ten minutes, and its heartbeat keeps the last success, so
// the pages can say "Missed at 12:00. Cello is retrying." from the record alone.

import type { SupabaseClient } from '@supabase/supabase-js'
import { waitUntil } from '@vercel/functions'
import { finishHeartbeat, recordMeter, startHeartbeat } from './heartbeat'
import { nextDue } from './next'
import { continueBody, continueUrl, signContinue, type ContinuePayload } from './sign'

type Db = SupabaseClient<any, any, any>

/** A slice stops starting new work after this long, so it ends before Vercel Hobby's 300 s. */
export const SLICE_MS = 200_000
/** A lease outlives a slice by a margin; a slice that died is picked up when it runs out. */
export const LEASE_MS = 330_000
/** A failed routine is tried again after this long. */
export const RETRY_MS = 10 * 60_000

export interface RoutineRow {
  id: string
  user_id: string | null
  command: string
  args: Record<string, unknown> | null
  local_time: string | null
  every: string | null
  timezone: string | null
  next_due_at: string | null
  enabled: boolean
  slice: { elapsed_ms?: number; state?: Record<string, unknown> } | null
}

export interface RoutineContext {
  admin: Db
  routine: RoutineRow
  userId: string | null
  /** What the last slice handed on, null on the first. */
  state: Record<string, unknown> | null
  now: () => number
  /** Epoch ms: start no new work after this. */
  deadlineAt: number
}

export interface RoutineOutcome {
  ok: boolean
  /** What the run counted, shown on the pages and kept on the heartbeat. */
  found?: Record<string, unknown>
  /** A class of failure, never a URL or a secret. */
  failure?: string
  /** More to do: the state the next slice starts from. Absent when the routine is done. */
  next?: Record<string, unknown>
}

export type RoutineHandler = (ctx: RoutineContext) => Promise<RoutineOutcome>

/** What the pages call each routine. */
export const ROUTINE_LABELS: Record<string, string> = {
  'roles.check': 'Find new roles',
  'roles.retype': 'Sort roles by kind',
  'inbox.sync': 'Mail check',
  'owner.health': 'Health check',
  'clock.meter': 'Server allowance',
  'clock.prune': 'Cleanup',
  'harness.resume': 'Resume paused work',
  'demo.expire': 'Demo cleanup',
  'harness.digest': 'Daily digest',
  'harness.distill': 'Weekly learning',
  'roles.render': 'Pages that need a browser',
}

export type PostContinue = (payload: Omit<ContinuePayload, 'exp'>) => Promise<void>

/** Ask the continue endpoint to carry on, after the response is sent. Never throws: the sweeper finds a slice that did not start. */
export const postContinue: PostContinue = async (payload) => {
  try {
    const body = continueBody(payload)
    const request = fetch(continueUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cello-signature': signContinue(body) },
      body,
    }).catch((e) => console.error('[clock] continue request failed; the sweeper will pick it up', e instanceof Error ? e.name : 'error'))
    if (process.env.VERCEL) waitUntil(request)
    else await Promise.race([request, new Promise((resolve) => setTimeout(resolve, 3000))])
  } catch (e) {
    console.error('[clock] could not sign a continue request', e instanceof Error ? e.name : 'error')
  }
}

export interface RunDeps {
  handlers: Record<string, RoutineHandler>
  now?: () => number
  post?: PostContinue
}

export type RunReport = { ran: false; reason: 'missing' | 'disabled' | 'not_due' | 'busy' | 'no_handler' } | { ran: true; done: boolean; ok: boolean }

const errorClass = (e: unknown): string => (e instanceof Error && /^[A-Za-z]+$/.test(e.name) ? e.name : 'Error')

export async function runRoutine(admin: Db, routineId: string, slice: Record<string, unknown> | null, deps: RunDeps): Promise<RunReport> {
  const now = deps.now ?? Date.now
  const post = deps.post ?? postContinue

  const { data, error } = await admin.from('routines').select('*').eq('id', routineId).maybeSingle()
  if (error || !data) return { ran: false, reason: 'missing' }
  const row = data as RoutineRow
  if (!row.enabled) return { ran: false, reason: 'disabled' }
  const handler = deps.handlers[row.command]
  if (!handler) return { ran: false, reason: 'no_handler' }
  const continuing = slice !== null
  if (!continuing && row.next_due_at && Date.parse(row.next_due_at) > now()) return { ran: false, reason: 'not_due' }

  // One slice at a time: the lease is a conditional update.
  const nowIso = new Date(now()).toISOString()
  const { data: claimed } = await admin
    .from('routines')
    .update({ lease_until: new Date(now() + LEASE_MS).toISOString(), poked_at: null })
    .eq('id', routineId)
    .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
    .select('id')
  if (!claimed || claimed.length === 0) return { ran: false, reason: 'busy' }

  const startedAt = now()
  const carried = row.slice && typeof row.slice === 'object' ? row.slice : null
  const elapsedBefore = continuing ? Number((slice as { elapsed_ms?: unknown }).elapsed_ms ?? carried?.elapsed_ms ?? 0) || 0 : 0
  const state = continuing ? (((slice as { state?: unknown }).state as Record<string, unknown> | undefined) ?? carried?.state ?? null) : null

  if (!continuing) {
    try {
      await startHeartbeat(admin, row.command, row.user_id)
    } catch {
      /* the heartbeat is written again when the run finishes */
    }
  }

  let outcome: RoutineOutcome
  try {
    outcome = await handler({ admin, routine: row, userId: row.user_id, state, now, deadlineAt: startedAt + SLICE_MS })
  } catch (e) {
    outcome = { ok: false, failure: errorClass(e) }
  }
  const endedAt = now()
  const elapsed = elapsedBefore + (endedAt - startedAt)

  if (outcome.ok && outcome.next) {
    // More to do: hand on, and count this slice against the meter.
    const handOn = { elapsed_ms: elapsed, state: outcome.next }
    await admin.from('routines').update({ slice: handOn, lease_until: null, poked_at: null }).eq('id', routineId)
    await recordMeter(admin, endedAt - startedAt).catch(() => undefined)
    await post({ reason: 'routine', routine_id: routineId, slice: handOn })
    return { ran: true, done: false, ok: true }
  }

  const dueAt = row.next_due_at ? new Date(row.next_due_at) : null
  const next = outcome.ok ? nextDue({ every: row.every, local_time: row.local_time, timezone: row.timezone }, new Date(endedAt), dueAt) : new Date(endedAt + RETRY_MS)
  try {
    await finishHeartbeat(admin, row.command, row.user_id, { ok: outcome.ok, found: outcome.found, failure: outcome.failure, durationMs: elapsed, nextDue: next })
  } catch {
    /* the routine's own row below still moves on */
  }
  await admin
    .from('routines')
    .update({ slice: null, lease_until: null, poked_at: null, next_due_at: next ? next.toISOString() : null })
    .eq('id', routineId)
  return { ran: true, done: true, ok: outcome.ok }
}
