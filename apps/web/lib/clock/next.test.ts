import { describe, expect, it } from 'vitest'
import { nextDue, parseInterval, type Schedule } from './next'

const iso = (d: Date | null) => (d ? d.toISOString() : null)

describe('parseInterval', () => {
  it('reads Postgres interval text and ISO durations', () => {
    expect(parseInterval('06:00:00')).toBe(6 * 3_600_000)
    expect(parseInterval('00:05:00')).toBe(300_000)
    expect(parseInterval('1 day')).toBe(86_400_000)
    expect(parseInterval('1 day 02:00:00')).toBe(86_400_000 + 7_200_000)
    expect(parseInterval('6 hours')).toBe(6 * 3_600_000)
    expect(parseInterval('PT6H')).toBe(6 * 3_600_000)
    expect(parseInterval('P1D')).toBe(86_400_000)
  })
  it('is null for nothing or nonsense', () => {
    expect(parseInterval(null)).toBeNull()
    expect(parseInterval('')).toBeNull()
    expect(parseInterval('soon')).toBeNull()
    expect(parseInterval('00:00:00')).toBeNull()
  })
})

describe('nextDue', () => {
  it('keeps an interval on its grid when a run is late', () => {
    const s: Schedule = { every: '06:00:00' }
    const due = new Date('2026-10-08T12:00:00Z')
    // run at 12:40, finished: next is 18:00, not 18:40
    expect(iso(nextDue(s, new Date('2026-10-08T12:40:00Z'), due))).toBe('2026-10-08T18:00:00.000Z')
    // a run that was 20 hours late skips the slots it missed
    expect(iso(nextDue(s, new Date('2026-10-09T08:00:00Z'), due))).toBe('2026-10-09T12:00:00.000Z')
  })

  it('counts from now when there is no due time', () => {
    expect(iso(nextDue({ every: '1 hour' }, new Date('2026-10-08T12:30:00Z')))).toBe('2026-10-08T13:30:00.000Z')
  })

  it('has no next time for a switch', () => {
    expect(nextDue({}, new Date('2026-10-08T12:00:00Z'))).toBeNull()
  })

  it('runs a local time at that time in its zone, through daylight saving', () => {
    const s: Schedule = { local_time: '06:00', timezone: 'Europe/London' }
    // BST until 2026-10-25: 06:00 is 05:00Z. GMT after: 06:00Z.
    expect(iso(nextDue(s, new Date('2026-10-24T00:00:00Z')))).toBe('2026-10-24T05:00:00.000Z')
    expect(iso(nextDue(s, new Date('2026-10-24T05:00:00Z')))).toBe('2026-10-25T06:00:00.000Z')
    expect(iso(nextDue(s, new Date('2026-10-25T06:00:00Z')))).toBe('2026-10-26T06:00:00.000Z')
  })
})

/** Run a fixture clock minute by minute, as the sweeper does, and list the moments the routine ran. */
function simulate(s: Schedule, first: Date, from: Date, to: Date): Date[] {
  const runs: Date[] = []
  let due = first
  for (let t = from.getTime(); t <= to.getTime(); t += 60_000) {
    if (due.getTime() <= t) {
      const now = new Date(t)
      runs.push(now)
      const next = nextDue(s, now, due)
      if (!next) break
      due = next
    }
  }
  return runs
}

describe('a fixture clock across the 2026-11-01 daylight saving change', () => {
  it('runs roles.check once every 6 hours, never twice and never skipping', () => {
    const runs = simulate({ every: '06:00:00' }, new Date('2026-10-31T00:00:00Z'), new Date('2026-10-31T00:00:00Z'), new Date('2026-11-02T23:59:00Z'))
    expect(runs.map((d) => d.toISOString())).toEqual([
      '2026-10-31T00:00:00.000Z', '2026-10-31T06:00:00.000Z', '2026-10-31T12:00:00.000Z', '2026-10-31T18:00:00.000Z',
      '2026-11-01T00:00:00.000Z', '2026-11-01T06:00:00.000Z', '2026-11-01T12:00:00.000Z', '2026-11-01T18:00:00.000Z',
      '2026-11-02T00:00:00.000Z', '2026-11-02T06:00:00.000Z', '2026-11-02T12:00:00.000Z', '2026-11-02T18:00:00.000Z',
    ])
  })

  it('runs owner.health at 06:00 Europe/London once a day, across both changes', () => {
    const s: Schedule = { local_time: '06:00', timezone: 'Europe/London' }
    const runs = simulate(s, new Date('2026-10-24T05:00:00Z'), new Date('2026-10-24T00:00:00Z'), new Date('2026-11-02T23:59:00Z'))
    expect(runs).toHaveLength(10)
    expect(runs[0].toISOString()).toBe('2026-10-24T05:00:00.000Z')
    expect(runs[1].toISOString()).toBe('2026-10-25T06:00:00.000Z')
    // one run on each of the ten days
    expect(new Set(runs.map((d) => d.toISOString().slice(0, 10))).size).toBe(10)
  })
})
