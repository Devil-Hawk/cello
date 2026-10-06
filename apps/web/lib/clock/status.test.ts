import { describe, expect, it } from 'vitest'
import { ALLOWANCE_MS } from './meter'
import { BACKGROUND_OFF_TEXT, checksStatus } from './status'

type Rows = Record<string, unknown[]>

/** A PostgREST-shaped fake: select, in, eq and maybeSingle over fixed rows, and rpc by name. */
function fakeDb(tables: Rows, rpc: Record<string, unknown> = {}) {
  return {
    from(table: string) {
      const rows = tables[table] ?? []
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        in: () => Promise.resolve({ data: rows, error: null }),
        maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      }
      return b
    },
    rpc: async (name: string) => ({ data: rpc[name] ?? null, error: null }),
  } as never
}

const NOW = new Date('2026-10-08T13:30:00Z')
const roles = (next: string) => ({ command: 'roles.check', next_due_at: next, enabled: true })
const beat = (over: Record<string, unknown> = {}) => ({
  job: 'roles.check',
  succeeded_at: '2026-10-08T06:02:00Z',
  next_due_at: '2026-10-08T12:00:00Z',
  found: { employers: 4, new: 2 },
  failure: null,
  ...over,
})

describe('checksStatus', () => {
  it('gives the last and the next check from the record', async () => {
    const s = await checksStatus(fakeDb({ routines: [roles('2026-10-08T18:00:00Z')], job_heartbeats: [beat({ succeeded_at: '2026-10-08T12:03:00Z', next_due_at: '2026-10-08T18:00:00Z' })] }, { background_ready: true }), fakeDb({}, { background_ready: true }), NOW)
    expect(s.backgroundReady).toBe(true)
    expect(s.rolesCheck).toMatchObject({ lastSucceededAt: '2026-10-08T12:03:00Z', nextDueAt: '2026-10-08T18:00:00Z', missed: false, missedText: null })
    expect(s.rolesCheck?.found).toEqual({ employers: 4, new: 2 })
  })

  it('reads a routine with no success one hour after it was due as missed, and says it is retrying', async () => {
    // due 12:00, not succeeded since 06:02, and it is 13:30: more than an hour late
    const s = await checksStatus(fakeDb({ routines: [roles('2026-10-08T13:40:00Z')], job_heartbeats: [beat({ failure: 'every_employer_failed' })] }), fakeDb({}, { background_ready: true }), NOW)
    expect(s.rolesCheck?.missed).toBe(true)
    expect(s.rolesCheck?.missedText).toBe('Missed at 12:00. Cello is retrying.')
    expect(s.rolesCheck?.failure).toBe('every_employer_failed')
    // the next time is the retry, not the missed slot
    expect(s.rolesCheck?.nextDueAt).toBe('2026-10-08T13:40:00Z')
  })

  it('is not missed inside the hour', async () => {
    const s = await checksStatus(fakeDb({ routines: [roles('2026-10-08T13:00:00Z')], job_heartbeats: [beat({ next_due_at: '2026-10-08T13:00:00Z' })] }), fakeDb({}, { background_ready: true }), NOW)
    expect(s.rolesCheck?.missed).toBe(false)
  })

  it('reads a routine that never ran from its own due time', async () => {
    const s = await checksStatus(fakeDb({ routines: [roles('2026-10-08T10:00:00Z')], job_heartbeats: [] }), fakeDb({}, { background_ready: true }), NOW)
    expect(s.rolesCheck).toMatchObject({ lastSucceededAt: null, missed: true, missedText: 'Missed at 10:00. Cello is retrying.' })
  })

  it('says background work is off when the server has no Vault rows, or no admin client', async () => {
    const db = fakeDb({ routines: [roles('2026-10-08T18:00:00Z')], job_heartbeats: [] })
    const off = await checksStatus(db, fakeDb({}, { background_ready: false }), NOW)
    expect(off.backgroundReady).toBe(false)
    expect(off.backgroundText).toBe(BACKGROUND_OFF_TEXT)
    expect((await checksStatus(db, null, NOW)).backgroundReady).toBe(false)
  })

  it('says finding is paused when the month is used up, until the first of next month', async () => {
    const db = fakeDb({ routines: [roles('2026-10-08T18:00:00Z')], job_heartbeats: [] })
    const admin = fakeDb({ clock_meter: [{ duration_ms: ALLOWANCE_MS + 1 }] }, { background_ready: true })
    const s = await checksStatus(db, admin, NOW)
    expect(s.paused).toBe('meter')
    expect(s.pausedText).toBe("Finding is paused: Cello's free server used this month's allowance until Nov 1.")
    const under = await checksStatus(db, fakeDb({ clock_meter: [{ duration_ms: 1000 }] }, { background_ready: true }), NOW)
    expect(under.paused).toBeNull()
  })

  it('lists only the routines a person is told about, and only the enabled ones', async () => {
    const s = await checksStatus(
      fakeDb({ routines: [roles('2026-10-08T18:00:00Z'), { command: 'harness.digest', next_due_at: null, enabled: true }, { command: 'inbox.sync', next_due_at: null, enabled: false }], job_heartbeats: [] }),
      fakeDb({}, { background_ready: true }),
      NOW
    )
    expect(s.routines.map((r) => r.command)).toEqual(['roles.check'])
  })
})
