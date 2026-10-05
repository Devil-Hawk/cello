// Scheduled tasks: a saved instruction, a schedule and an autonomy level.
//
// The model never writes cron. It passes structured fields (every day, weekday or
// week, a time, a time zone) and code turns them into a cron string and the next
// time it is due, with croner, which handles time zones and daylight saving time.
// The same rules serve the schedule_task tool and the scheduled-tasks API.

import { Cron } from 'croner'
import type { AdminClient } from '@/lib/harness/types'
import type { Autonomy, AutonomyRules } from './context'

export const EVERY = ['day', 'weekday', 'week', 'hours'] as const
export type Every = (typeof EVERY)[number]
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
export type Weekday = (typeof WEEKDAYS)[number]

export interface ScheduleSpec {
  every: Every
  /** 24 hour time, "HH:MM". Default 08:00. Ignored for "hours". */
  at?: string
  weekday?: Weekday
  /** For every: "hours", run every this many hours (1 to 12). */
  hours?: number
  /** An IANA time zone such as America/Los_Angeles. */
  timezone: string
}

export class ScheduleError extends Error {
  constructor(
    message: string,
    readonly fix: string
  ) {
    super(message)
    this.name = 'ScheduleError'
  }
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function parseTime(at: string | undefined): { h: number; m: number } {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec((at ?? '08:00').trim())
  if (!match) throw new ScheduleError(`"${at}" is not a time.`, 'Use 24 hour time like "08:00" or "17:30".')
  return { h: Number(match[1]), m: Number(match[2]) }
}

/** The cron string for a schedule. Throws a ScheduleError the model can act on. */
export function toCron(spec: ScheduleSpec): string {
  if (!isValidTimezone(spec.timezone)) {
    throw new ScheduleError(`"${spec.timezone}" is not a time zone.`, 'Use an IANA name such as "America/Los_Angeles" or "Europe/London".')
  }
  if (spec.every === 'hours') {
    const n = spec.hours ?? 0
    if (!Number.isInteger(n) || n < 1 || n > 12) throw new ScheduleError('Hours must be a whole number from 1 to 12.', 'Pass hours between 1 and 12, or use every: "day".')
    return `0 */${n} * * *`
  }
  const { h, m } = parseTime(spec.at)
  if (spec.every === 'day') return `${m} ${h} * * *`
  if (spec.every === 'weekday') return `${m} ${h} * * 1-5`
  const day = WEEKDAYS.indexOf(spec.weekday ?? 'mon')
  if (day < 0) throw new ScheduleError(`"${spec.weekday}" is not a weekday.`, 'Use mon, tue, wed, thu, fri, sat or sun.')
  return `${m} ${h} * * ${day}`
}

/** The next time after `after` this cron is due in `timezone`, as an ISO string. Null when there is none. */
export function nextRunAt(cron: string, timezone: string, after: Date = new Date()): string | null {
  const next = new Cron(cron, { timezone, paused: true }).nextRun(after)
  return next ? next.toISOString() : null
}

const DAY_NAMES: Record<Weekday, string> = { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' }

function clock(at: string | undefined): string {
  const { h, m } = parseTime(at)
  return `${h}:${String(m).padStart(2, '0')}`
}

/** "Every weekday at 8:00", the way the task card says it. */
export function describeSchedule(spec: ScheduleSpec): string {
  if (spec.every === 'hours') return `Every ${spec.hours === 1 ? 'hour' : `${spec.hours} hours`}`
  if (spec.every === 'day') return `Every day at ${clock(spec.at)}`
  if (spec.every === 'weekday') return `Every weekday at ${clock(spec.at)}`
  return `Every ${DAY_NAMES[spec.weekday ?? 'mon']} at ${clock(spec.at)}`
}

/** The schedule a stored cron string came from, for editing and display. */
export function specFromCron(cron: string, timezone: string): ScheduleSpec {
  const [min, hour, , , dow] = cron.split(' ')
  if (hour.startsWith('*/')) return { every: 'hours', hours: Number(hour.slice(2)), timezone }
  const at = `${String(Number(hour)).padStart(2, '0')}:${String(Number(min)).padStart(2, '0')}`
  if (dow === '*') return { every: 'day', at, timezone }
  if (dow === '1-5') return { every: 'weekday', at, timezone }
  return { every: 'week', at, weekday: WEEKDAYS[Number(dow)] ?? 'mon', timezone }
}

// --- rows ---------------------------------------------------------------------------

export interface ScheduledTaskRow {
  id: string
  user_id: string
  name: string
  instruction: string
  cron: string
  timezone: string
  autonomy: Autonomy
  rules: AutonomyRules
  status: 'active' | 'paused'
  template: 'find_roles' | 'follow_up' | 'autopilot' | null
  conversation_id: string | null
  next_run_at: string | null
  last_run_at: string | null
  last_status: 'ok' | 'partial' | 'failed' | 'missed' | null
  last_result: string | null
  poked_at: string | null
  created_at: string
}

const COLUMNS = 'id, user_id, name, instruction, cron, timezone, autonomy, rules, status, template, conversation_id, next_run_at, last_run_at, last_status, last_result, poked_at, created_at'

/** More than this many active tasks is almost certainly a mistake, and each one spends the person's budget. */
export const MAX_ACTIVE_TASKS = 10

export interface TaskInput {
  name: string
  instruction: string
  schedule: ScheduleSpec
  autonomy: Autonomy
  rules?: AutonomyRules
  template?: ScheduledTaskRow['template']
}

export async function listScheduledTasks(admin: AdminClient, userId: string): Promise<ScheduledTaskRow[]> {
  const { data } = await admin.from('scheduled_tasks').select(COLUMNS).eq('user_id', userId).order('created_at', { ascending: true })
  return (data as ScheduledTaskRow[] | null) ?? []
}

export async function getScheduledTask(admin: AdminClient, userId: string, id: string): Promise<ScheduledTaskRow | null> {
  const { data } = await admin.from('scheduled_tasks').select(COLUMNS).eq('id', id).eq('user_id', userId).maybeSingle()
  return (data as ScheduledTaskRow | null) ?? null
}

export async function createScheduledTask(admin: AdminClient, userId: string, input: TaskInput): Promise<ScheduledTaskRow> {
  const cron = toCron(input.schedule)
  const active = (await listScheduledTasks(admin, userId)).filter((t) => t.status === 'active').length
  if (active >= MAX_ACTIVE_TASKS) {
    throw new ScheduleError(`There are already ${MAX_ACTIVE_TASKS} active scheduled tasks.`, 'Pause or delete one before adding another.')
  }
  // Each task has its own conversation, where every occurrence leaves its result.
  const { data: convo, error: convoError } = await admin
    .from('copilot_conversations')
    .insert({ user_id: userId, title: input.name.slice(0, 120) })
    .select('id')
    .single()
  if (convoError || !convo) throw new Error(`Could not create the task: ${convoError?.message ?? 'no conversation'}`)
  const { data, error } = await admin
    .from('scheduled_tasks')
    .insert({
      user_id: userId,
      name: input.name.trim().slice(0, 80),
      instruction: input.instruction.trim().slice(0, 2000),
      cron,
      timezone: input.schedule.timezone,
      autonomy: input.autonomy,
      rules: input.rules ?? {},
      template: input.template ?? null,
      conversation_id: (convo as { id: string }).id,
      next_run_at: nextRunAt(cron, input.schedule.timezone),
    })
    .select(COLUMNS)
    .single()
  if (error || !data) {
    await admin.from('copilot_conversations').delete().eq('id', (convo as { id: string }).id)
    throw new Error(`Could not create the task: ${error?.message ?? 'no row'}`)
  }
  await admin.from('copilot_conversations').update({ scheduled_task_id: (data as ScheduledTaskRow).id }).eq('id', (convo as { id: string }).id)
  return data as ScheduledTaskRow
}

export interface TaskPatch {
  name?: string
  instruction?: string
  schedule?: ScheduleSpec
  autonomy?: Autonomy
  rules?: AutonomyRules
  status?: 'active' | 'paused'
}

export async function updateScheduledTask(admin: AdminClient, userId: string, id: string, patch: TaskPatch): Promise<ScheduledTaskRow | null> {
  const existing = await getScheduledTask(admin, userId, id)
  if (!existing) return null
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.name !== undefined) update.name = patch.name.trim().slice(0, 80)
  if (patch.instruction !== undefined) update.instruction = patch.instruction.trim().slice(0, 2000)
  if (patch.autonomy !== undefined) update.autonomy = patch.autonomy
  if (patch.rules !== undefined) update.rules = patch.rules
  if (patch.status !== undefined) update.status = patch.status
  let cron = existing.cron
  let timezone = existing.timezone
  if (patch.schedule) {
    cron = toCron(patch.schedule)
    timezone = patch.schedule.timezone
    update.cron = cron
    update.timezone = timezone
  }
  // A new schedule, or a resume, recomputes when it is next due.
  if (patch.schedule || (patch.status === 'active' && existing.status === 'paused')) {
    update.next_run_at = nextRunAt(cron, timezone)
    update.poked_at = null
  }
  if (patch.status === 'paused') update.next_run_at = null
  const { data } = await admin.from('scheduled_tasks').update(update).eq('id', id).eq('user_id', userId).select(COLUMNS).maybeSingle()
  return (data as ScheduledTaskRow | null) ?? null
}

export async function deleteScheduledTask(admin: AdminClient, userId: string, id: string): Promise<boolean> {
  const existing = await getScheduledTask(admin, userId, id)
  if (!existing) return false
  await admin.from('scheduled_tasks').delete().eq('id', id).eq('user_id', userId)
  return true
}

/** How a task reads on its card: schedule, last result, next time. */
export function cardLines(task: ScheduledTaskRow, now: Date = new Date()): { schedule: string; last: string | null; next: string | null } {
  const spec = specFromCron(task.cron, task.timezone)
  const lastAt = task.last_run_at ? new Date(task.last_run_at) : null
  const last =
    task.last_status === 'missed' && lastAt
      ? `Missed at ${clockIn(lastAt, task.timezone)} (Cello was unavailable).`
      : task.last_result
        ? `Last: ${task.last_result}`
        : null
  const next = task.status === 'active' && task.next_run_at ? `Next ${relativeDay(new Date(task.next_run_at), task.timezone, now)}` : null
  return { schedule: describeSchedule(spec), last, next }
}

function clockIn(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hourCycle: 'h23', timeZone: timezone }).format(date).replace(/^0/, '')
}

function relativeDay(date: Date, timezone: string, now: Date): string {
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(d)
  const tomorrow = new Date(now.getTime() + 86_400_000)
  const when = day(date) === day(now) ? 'today' : day(date) === day(tomorrow) ? 'tomorrow' : new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: timezone }).format(date)
  return `at ${clockIn(date, timezone)} ${when}`
}
