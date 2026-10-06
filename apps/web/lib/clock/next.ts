// When a routine is next due. The runner writes the answer to routines.next_due_at after each run,
// and the sweeper only compares that column to now(), so SQL never handles local time.
//
// A routine runs at a local time every day (cron in its time zone, so daylight saving moves the
// UTC hour and never the local one) or every so often (a fixed length, never moved by the zone).

import { Cron } from 'croner'

export interface Schedule {
  /** Postgres interval text: '06:00:00', '1 day', '00:05:00', '1 day 02:00:00'. */
  every?: string | null
  /** '06:00' or '06:00:00', in `timezone`. */
  local_time?: string | null
  timezone?: string | null
}

const MIN_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** A Postgres interval (default style), or an ISO 8601 duration, in milliseconds. Null when it is not one. */
export function parseInterval(text: string | null | undefined): number | null {
  if (!text) return null
  const t = text.trim()
  const iso = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(t)
  if (iso && t !== 'P' && t !== 'PT') {
    return Number(iso[1] ?? 0) * DAY_MS + Number(iso[2] ?? 0) * HOUR_MS + Number(iso[3] ?? 0) * MIN_MS + Number(iso[4] ?? 0) * 1000
  }
  let ms = 0
  let seen = false
  const days = /(\d+)\s*days?/.exec(t)
  if (days) (ms += Number(days[1]) * DAY_MS), (seen = true)
  const hours = /(\d+)\s*(?:hours?|hrs?)\b/.exec(t)
  if (hours) (ms += Number(hours[1]) * HOUR_MS), (seen = true)
  const mins = /(\d+)\s*(?:minutes?|mins?)\b/.exec(t)
  if (mins) (ms += Number(mins[1]) * MIN_MS), (seen = true)
  const clock = /(\d+):(\d{2}):(\d{2})/.exec(t)
  if (clock) (ms += Number(clock[1]) * HOUR_MS + Number(clock[2]) * MIN_MS + Number(clock[3]) * 1000), (seen = true)
  return seen && ms > 0 ? ms : null
}

/**
 * The next time after `after`. For an interval the run grid is kept: the next slot after the one
 * that was due (`dueAt`), so a late run does not push every later run late. A routine with neither
 * a local time nor an interval is a switch and has no next time.
 */
export function nextDue(schedule: Schedule, after: Date, dueAt?: Date | null): Date | null {
  if (schedule.local_time) {
    const m = /^(\d{1,2}):(\d{2})/.exec(schedule.local_time)
    if (!m) return null
    const job = new Cron(`${Number(m[2])} ${Number(m[1])} * * *`, { timezone: schedule.timezone || 'UTC', paused: true })
    return job.nextRun(after)
  }
  const every = parseInterval(schedule.every)
  if (every === null) return null
  const base = dueAt && dueAt.getTime() <= after.getTime() ? dueAt.getTime() : after.getTime()
  // The first slot strictly after `after`, on the grid that starts at the due time.
  const steps = Math.floor((after.getTime() - base) / every) + 1
  return new Date(base + steps * every)
}
