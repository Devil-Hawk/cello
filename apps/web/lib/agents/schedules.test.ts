import { describe, expect, it } from 'vitest'
import {
  MAX_ACTIVE_TASKS,
  ScheduleError,
  cardLines,
  createScheduledTask,
  deleteScheduledTask,
  describeSchedule,
  listScheduledTasks,
  nextRunAt,
  specFromCron,
  toCron,
  updateScheduledTask,
  type ScheduledTaskRow,
} from './schedules'
import { makeFakeAdmin } from './testing/fake-admin'

const LA = 'America/Los_Angeles'

describe('toCron', () => {
  it('builds each kind of schedule from structured fields', () => {
    expect(toCron({ every: 'day', at: '08:00', timezone: LA })).toBe('0 8 * * *')
    expect(toCron({ every: 'weekday', at: '17:30', timezone: LA })).toBe('30 17 * * 1-5')
    expect(toCron({ every: 'week', weekday: 'fri', at: '09:15', timezone: 'UTC' })).toBe('15 9 * * 5')
    expect(toCron({ every: 'hours', hours: 4, timezone: 'UTC' })).toBe('0 */4 * * *')
    expect(toCron({ every: 'day', timezone: 'UTC' })).toBe('0 8 * * *')
  })

  it('refuses what it cannot schedule and says how to fix it', () => {
    expect(() => toCron({ every: 'day', at: '25:00', timezone: 'UTC' })).toThrow(ScheduleError)
    expect(() => toCron({ every: 'day', at: '8am', timezone: 'UTC' })).toThrow(/not a time/)
    expect(() => toCron({ every: 'day', timezone: 'Mars/Olympus' })).toThrow(/not a time zone/)
    expect(() => toCron({ every: 'hours', hours: 0, timezone: 'UTC' })).toThrow(/1 to 12/)
    expect(() => toCron({ every: 'hours', hours: 24, timezone: 'UTC' })).toThrow(ScheduleError)
    try {
      toCron({ every: 'day', at: 'noon', timezone: 'UTC' })
    } catch (e) {
      expect((e as ScheduleError).fix).toMatch(/08:00/)
    }
  })

  it('round trips through the stored cron', () => {
    for (const spec of [
      { every: 'day', at: '08:00', timezone: LA },
      { every: 'weekday', at: '17:30', timezone: LA },
      { every: 'week', weekday: 'wed', at: '06:05', timezone: 'UTC' },
      { every: 'hours', hours: 6, timezone: 'UTC' },
    ] as const) {
      expect(specFromCron(toCron(spec), spec.timezone)).toEqual(spec)
    }
  })

  it('describes a schedule the way the card does', () => {
    expect(describeSchedule({ every: 'weekday', at: '08:00', timezone: LA })).toBe('Every weekday at 8:00')
    expect(describeSchedule({ every: 'week', weekday: 'mon', at: '17:30', timezone: LA })).toBe('Every Monday at 17:30')
    expect(describeSchedule({ every: 'hours', hours: 1, timezone: LA })).toBe('Every hour')
    expect(describeSchedule({ every: 'hours', hours: 4, timezone: LA })).toBe('Every 4 hours')
  })
})

describe('nextRunAt across a daylight saving change', () => {
  // US daylight saving time ends Sunday 1 November 2026 at 2:00 local.
  it('stays at 8:00 local, so the UTC time moves an hour', () => {
    const cron = toCron({ every: 'day', at: '08:00', timezone: LA })
    expect(nextRunAt(cron, LA, new Date('2026-10-30T20:00:00Z'))).toBe('2026-10-31T15:00:00.000Z')
    expect(nextRunAt(cron, LA, new Date('2026-10-31T16:00:00Z'))).toBe('2026-11-01T16:00:00.000Z')
    expect(nextRunAt(cron, LA, new Date('2026-11-01T17:00:00Z'))).toBe('2026-11-02T16:00:00.000Z')
  })

  it('a weekday schedule skips the weekend', () => {
    const cron = toCron({ every: 'weekday', at: '08:00', timezone: 'UTC' })
    // Friday 2 October 2026 after 8:00 goes to Monday 5 October.
    expect(nextRunAt(cron, 'UTC', new Date('2026-10-02T09:00:00Z'))).toBe('2026-10-05T08:00:00.000Z')
  })

  it('spring forward: 2:30 local does not exist on 8 March 2026 and still runs once that day', () => {
    const cron = toCron({ every: 'day', at: '02:30', timezone: LA })
    const next = nextRunAt(cron, LA, new Date('2026-03-08T00:00:00Z'))
    expect(next && next.startsWith('2026-03-08')).toBe(true)
  })
})

function admin() {
  return makeFakeAdmin({ copilot_conversations: [] }, { scheduled_tasks: { defaults: () => ({ status: 'active', rules: {}, poked_at: null }) } })
}

describe('the rows', () => {
  const input = { name: 'Find new roles', instruction: 'Find new roles that fit me.', schedule: { every: 'weekday' as const, at: '08:00', timezone: LA }, autonomy: 'ask' as const }

  it('creates a task with its own conversation and the next time it is due', async () => {
    const a = admin()
    const t = await createScheduledTask(a, 'u1', input)
    expect(t).toMatchObject({ cron: '0 8 * * 1-5', timezone: LA, autonomy: 'ask', status: 'active' })
    expect(t.next_run_at).toBeTruthy()
    expect(a.tables.copilot_conversations).toHaveLength(1)
    expect(a.tables.copilot_conversations[0].scheduled_task_id).toBe(t.id)
    expect(t.conversation_id).toBe(a.tables.copilot_conversations[0].id)
  })

  it('does not create more than ten active tasks', async () => {
    const a = admin()
    for (let i = 0; i < MAX_ACTIVE_TASKS; i++) await createScheduledTask(a, 'u1', { ...input, name: `T${i}` })
    await expect(createScheduledTask(a, 'u1', input)).rejects.toThrow(/already 10/)
    // Another person is not affected.
    await expect(createScheduledTask(a, 'u2', input)).resolves.toBeTruthy()
  })

  it('a bad schedule creates nothing', async () => {
    const a = admin()
    await expect(createScheduledTask(a, 'u1', { ...input, schedule: { every: 'day', at: 'noon', timezone: 'UTC' } })).rejects.toThrow(ScheduleError)
    expect(a.tables.copilot_conversations).toHaveLength(0)
  })

  it('pausing clears the next time and resuming recomputes it', async () => {
    const a = admin()
    const t = await createScheduledTask(a, 'u1', input)
    const paused = await updateScheduledTask(a, 'u1', t.id, { status: 'paused' })
    expect(paused?.next_run_at).toBeNull()
    const resumed = await updateScheduledTask(a, 'u1', t.id, { status: 'active' })
    expect(resumed?.next_run_at).toBeTruthy()
    expect(resumed?.poked_at ?? null).toBeNull()
  })

  it('changing the schedule recomputes cron and next time; changing the name does not', async () => {
    const a = admin()
    const t = await createScheduledTask(a, 'u1', input)
    const renamed = await updateScheduledTask(a, 'u1', t.id, { name: 'Morning roles' })
    expect(renamed?.next_run_at).toBe(t.next_run_at)
    const moved = await updateScheduledTask(a, 'u1', t.id, { schedule: { every: 'day', at: '06:00', timezone: 'UTC' } })
    expect(moved).toMatchObject({ cron: '0 6 * * *', timezone: 'UTC' })
  })

  it("never touches or lists another person's task", async () => {
    const a = admin()
    const t = await createScheduledTask(a, 'u1', input)
    expect(await updateScheduledTask(a, 'u2', t.id, { name: 'mine now' })).toBeNull()
    expect(await deleteScheduledTask(a, 'u2', t.id)).toBe(false)
    expect(await listScheduledTasks(a, 'u2')).toEqual([])
    expect(await deleteScheduledTask(a, 'u1', t.id)).toBe(true)
  })
})

describe('card lines', () => {
  const base = { cron: '0 8 * * 1-5', timezone: LA, status: 'active', created_at: '', last_status: null, last_result: null, last_run_at: null } as unknown as ScheduledTaskRow

  it('says what the task does, how it last went and when it is next', () => {
    const now = new Date('2026-10-05T20:00:00Z')
    const lines = cardLines({ ...base, last_status: 'ok', last_result: 'found 5 roles, 2 strong', next_run_at: '2026-10-06T15:00:00Z' }, now)
    expect(lines).toEqual({ schedule: 'Every weekday at 8:00', last: 'Last: found 5 roles, 2 strong', next: 'Next at 8:00 tomorrow' })
  })

  it('shows a missed run and still says when the next one is', () => {
    const now = new Date('2026-10-06T20:00:00Z')
    const lines = cardLines({ ...base, last_status: 'missed', last_run_at: '2026-10-06T15:00:00Z', next_run_at: '2026-10-07T15:00:00Z' }, now)
    expect(lines.last).toBe('Missed at 8:00 (Cello was unavailable).')
    expect(lines.next).toBe('Next at 8:00 tomorrow')
  })

  it('a paused task has no next time', () => {
    expect(cardLines({ ...base, status: 'paused', next_run_at: null }).next).toBeNull()
  })
})
