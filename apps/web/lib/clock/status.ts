// checks.status: the last and the next check, read from the clock's own record.
//
// Pages show only what the heartbeats say. A routine with no success one hour after it was due is
// missed ("Missed at 12:00. Cello is retrying."); background work is off until the server has its
// Vault rows and the minute sweeper is scheduled; and when the free server's allowance for the month
// is used, finding is paused until it starts again.

import type { SupabaseClient } from '@supabase/supabase-js'
import { allowanceResets, meterState } from './meter'
import { ROUTINE_LABELS } from './routines'

type Db = SupabaseClient<any, any, any>

/** The routines a person is told about. The rest are the server's business. */
export const PERSON_ROUTINES = ['roles.check', 'inbox.sync'] as const

/** How long after its due time a routine may take before it reads as missed. */
export const MISSED_AFTER_MS = 60 * 60_000

export const BACKGROUND_OFF_TEXT = 'Background work is off on this server.'

export interface RoutineStatus {
  command: string
  label: string
  lastSucceededAt: string | null
  nextDueAt: string | null
  missed: boolean
  missedAt: string | null
  /** "Missed at 12:00. Cello is retrying." when missed. */
  missedText: string | null
  /** What the last run counted. */
  found: Record<string, unknown> | null
  /** Why the last run failed, a class and never a message. */
  failure: string | null
}

export interface ChecksStatus {
  backgroundReady: boolean
  backgroundText: string | null
  paused: 'meter' | null
  pausedText: string | null
  routines: RoutineStatus[]
  /** The person's own role check, the one the Companies and Roles pages talk about. */
  rolesCheck: RoutineStatus | null
}

interface RoutineRow {
  command: string
  next_due_at: string | null
  enabled: boolean
}

interface HeartbeatRow {
  job: string
  succeeded_at: string | null
  next_due_at: string | null
  found: Record<string, unknown> | null
  failure: string | null
}

const hhmm = (iso: string) => new Date(iso).toISOString().slice(11, 16)

export function routineStatus(command: string, routine: RoutineRow | undefined, heartbeat: HeartbeatRow | undefined, now: Date): RoutineStatus {
  const lastSucceededAt = heartbeat?.succeeded_at ?? null
  // The time the person was promised: what the last success set, else the routine's own.
  const expected = heartbeat?.next_due_at ?? routine?.next_due_at ?? null
  const missed =
    expected !== null &&
    now.getTime() > Date.parse(expected) + MISSED_AFTER_MS &&
    (lastSucceededAt === null || Date.parse(lastSucceededAt) < Date.parse(expected))
  return {
    command,
    label: ROUTINE_LABELS[command] ?? command,
    lastSucceededAt,
    nextDueAt: routine?.next_due_at ?? expected,
    missed,
    missedAt: missed ? expected : null,
    missedText: missed && expected ? `Missed at ${hhmm(expected)}. Cello is retrying.` : null,
    found: heartbeat?.found && Object.keys(heartbeat.found).length > 0 ? heartbeat.found : null,
    failure: heartbeat?.failure ?? null,
  }
}

/**
 * `client` reads the person's own rows under row level security (their routines and the
 * instance's); `admin` is the server's service-role client, which alone may ask whether background
 * work is possible and read the meter. Without `admin` the answer is "off".
 */
export async function checksStatus(client: Db, admin: Db | null, now: Date = new Date()): Promise<ChecksStatus> {
  const [routines, heartbeats, ready, meter] = await Promise.all([
    client.from('routines').select('command, next_due_at, enabled').in('command', [...PERSON_ROUTINES]),
    client.from('job_heartbeats').select('job, succeeded_at, next_due_at, found, failure').in('job', [...PERSON_ROUTINES]),
    admin ? admin.rpc('background_ready') : Promise.resolve({ data: false, error: null }),
    admin ? meterState(admin, now).catch(() => null) : Promise.resolve(null),
  ])
  const routineRows = (routines.data ?? []) as RoutineRow[]
  const heartbeatRows = (heartbeats.data ?? []) as HeartbeatRow[]
  const backgroundReady = ready.data === true

  const list = PERSON_ROUTINES.filter((c) => routineRows.some((r) => r.command === c && r.enabled)).map((command) =>
    routineStatus(
      command,
      routineRows.find((r) => r.command === command),
      heartbeatRows.find((h) => h.job === command),
      now
    )
  )
  const paused = meter?.paused ? ('meter' as const) : null
  return {
    backgroundReady,
    backgroundText: backgroundReady ? null : BACKGROUND_OFF_TEXT,
    paused,
    pausedText: paused ? `Finding is paused: Cello's free server used this month's allowance until ${allowanceResets(now)}.` : null,
    routines: list,
    rolesCheck: list.find((r) => r.command === 'roles.check') ?? null,
  }
}
