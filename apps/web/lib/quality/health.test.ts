// runHealthCheck against an in-memory stand-in for the tables. No network, no database.

import { describe, expect, it } from 'vitest'
import type { AdminClient } from '../harness/types'
import { DB_ALERT_BYTES, groupChecks, providerStreaks, recordHeartbeat, beatStart, runHealthCheck } from './health'

type Row = Record<string, unknown>
const MB = 1024 * 1024
const NOW = new Date('2026-10-06T13:07:00Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()

interface World {
  stats?: Row | null | 'error'
  tables: Record<string, Row[] | 'missing'>
}

function fakeAdmin(world: World) {
  let idSeq = 0
  const admin = {
    rpc: async (name: string) => {
      if (name !== 'ops_db_stats' || world.stats === 'error' || world.stats === undefined) return { data: null, error: { message: 'no such function' } }
      return { data: world.stats, error: null }
    },
    from(name: string) {
      const table = world.tables[name]
      let op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select'
      let patch: Row = {}
      const filters: ((r: Row) => boolean)[] = []
      let limit = Infinity
      let sort: { col: string; asc: boolean } | null = null
      const run = () => {
        if (table === 'missing' || table === undefined) return { data: null, error: { message: `relation "${name}" does not exist`, code: '42P01' } }
        const rows = table
        const hit = rows.filter((r) => filters.every((f) => f(r)))
        if (op === 'delete') {
          for (const r of hit) rows.splice(rows.indexOf(r), 1)
          return { data: null, error: null }
        }
        if (op === 'update') {
          for (const r of hit) Object.assign(r, patch)
          return { data: null, error: null }
        }
        const sorted = sort ? [...hit].sort((a, b) => (String(a[sort!.col]) < String(b[sort!.col]) ? -1 : 1) * (sort!.asc ? 1 : -1)) : hit
        return { data: sorted.slice(0, limit), error: null }
      }
      const b: Record<string, unknown> = {
        select: () => b,
        insert: (row: Row) => {
          if (table === 'missing' || table === undefined) return Promise.resolve({ error: { message: 'missing' } })
          // ops_alerts has one open row per kind and subject.
          if (name === 'ops_alerts' && table.some((r) => r.kind === row.kind && r.subject === row.subject && r.resolved_at == null)) {
            return Promise.resolve({ error: { message: 'duplicate key' } })
          }
          table.push({ id: `id-${(idSeq += 1)}`, resolved_at: null, ...row })
          return Promise.resolve({ error: null })
        },
        upsert: (row: Row, o?: { onConflict?: string }) => {
          if (table === 'missing' || table === undefined) return Promise.resolve({ error: { message: 'missing' } })
          const keyCol = o?.onConflict ?? 'id'
          const found = table.find((r) => r[keyCol] === row[keyCol])
          if (found) Object.assign(found, row)
          else table.push({ ...row })
          return Promise.resolve({ error: null })
        },
        update: (p: Row) => ((op = 'update'), (patch = p), b),
        delete: () => ((op = 'delete'), b),
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
        is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b),
        in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), b),
        lt: (c: string, v: string) => (filters.push((r) => String(r[c]) < v), b),
        order: (c: string, o?: { ascending?: boolean }) => ((sort = { col: c, asc: o?.ascending !== false }), b),
        limit: (n: number) => ((limit = n), b),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
      }
      return b
    },
  }
  return admin as unknown as AdminClient
}

const stats = (bytes: number, schedules: Row[] = []): Row => ({ db_bytes: bytes, tables: [{ name: 'jobs', bytes: bytes - MB }], schedules })
const beats = (over: Record<string, Partial<Row>> = {}): Row[] =>
  ['daily-check', 'mail-check', 'autopilot'].map((job) => ({ job, last_ok_at: hoursAgo(0.5), last_started_at: hoursAgo(0.5), last_error: null, ...over[job] }))

function runRow(batch: string, hours: number, provider: Record<string, { companies: number; failed: number }>): Row {
  return { batch_id: batch, status: 'partial', started_at: hoursAgo(hours), by_provider: provider }
}

describe('database size', () => {
  it('351 MB raises one db_size alert; 349 MB resolves it', async () => {
    const tables = { cron_heartbeats: beats(), ops_alerts: [] as Row[], ops_health_checks: [] as Row[], ingestion_runs: 'missing' as const }
    const admin = fakeAdmin({ stats: stats(351 * MB), tables })
    const high = await runHealthCheck(admin, NOW)
    expect(high.alerts.map((a) => a.kind)).toEqual(['db_size'])
    expect(high.alerts[0].message).toBe('Database is at 351 MB of 500 MB')
    expect((tables.ops_alerts as Row[]).filter((a) => a.resolved_at === null)).toHaveLength(1)

    const low = await runHealthCheck(fakeAdmin({ stats: stats(349 * MB), tables }), NOW)
    expect(low.alerts).toEqual([])
    expect(low.resolved).toBe(1)
    expect((tables.ops_alerts as Row[])[0].resolved_at).toBe(NOW.toISOString())
  })

  it('the same alert on the next day is updated, not duplicated', async () => {
    const tables = { cron_heartbeats: beats(), ops_alerts: [] as Row[], ops_health_checks: [] as Row[], ingestion_runs: 'missing' as const }
    await runHealthCheck(fakeAdmin({ stats: stats(360 * MB), tables }), NOW)
    await runHealthCheck(fakeAdmin({ stats: stats(362 * MB), tables }), new Date(NOW.getTime() + 60_000))
    expect(tables.ops_alerts).toHaveLength(1)
    expect(tables.ops_alerts[0].message).toBe('Database is at 362 MB of 500 MB')
  })

  it('the threshold is 350 MB, exclusive', async () => {
    const tables = { cron_heartbeats: beats(), ops_alerts: [] as Row[], ops_health_checks: [] as Row[], ingestion_runs: 'missing' as const }
    const report = await runHealthCheck(fakeAdmin({ stats: stats(DB_ALERT_BYTES), tables }), NOW)
    expect(report.alerts).toEqual([])
  })

  it('stores one report and drops reports older than 90 days', async () => {
    const tables = { cron_heartbeats: beats(), ops_alerts: [] as Row[], ops_health_checks: [{ checked_at: hoursAgo(24 * 91), db_bytes: 1, report: {} }] as Row[], ingestion_runs: 'missing' as const }
    await runHealthCheck(fakeAdmin({ stats: stats(100 * MB), tables }), NOW)
    expect(tables.ops_health_checks).toHaveLength(1)
    expect(tables.ops_health_checks[0].db_bytes).toBe(100 * MB)
  })
})

describe('schedules', () => {
  it('a mail check last seen 4 hours ago raises schedule_missed; 2 hours does not', async () => {
    const late = await runHealthCheck(
      fakeAdmin({ stats: stats(10 * MB), tables: { cron_heartbeats: beats({ 'mail-check': { last_ok_at: hoursAgo(4), last_started_at: hoursAgo(4) } }), ops_alerts: [], ops_health_checks: [], ingestion_runs: 'missing' } }),
      NOW
    )
    expect(late.alerts).toHaveLength(1)
    expect(late.alerts[0]).toMatchObject({ kind: 'schedule_missed', subject: 'mail-check', message: 'Mail check has not run for 4 hours' })
    expect(late.alerts[0].detail.body).toBe('It should run every hour. Open GitHub Actions and the mail check workflow.')

    const fine = await runHealthCheck(
      fakeAdmin({ stats: stats(10 * MB), tables: { cron_heartbeats: beats({ 'mail-check': { last_ok_at: hoursAgo(2) } }), ops_alerts: [], ops_health_checks: [], ingestion_runs: 'missing' } }),
      NOW
    )
    expect(fine.alerts).toEqual([])
  })

  it('a job that keeps starting but never succeeds is late once its last success is old', async () => {
    const report = await runHealthCheck(
      fakeAdmin({ stats: stats(10 * MB), tables: { cron_heartbeats: beats({ autopilot: { last_ok_at: hoursAgo(30), last_started_at: hoursAgo(1), last_error: 'boom' } }), ops_alerts: [], ops_health_checks: [], ingestion_runs: 'missing' } }),
      NOW
    )
    expect(report.alerts[0]).toMatchObject({ kind: 'schedule_missed', subject: 'autopilot' })
    expect(report.alerts[0].detail.last_error).toBe('boom')
  })

  it('a job with no heartbeat yet is not reporting, not late', async () => {
    const report = await runHealthCheck(fakeAdmin({ stats: stats(10 * MB), tables: { cron_heartbeats: [], ops_alerts: [], ops_health_checks: [], ingestion_runs: 'missing' } }), NOW)
    expect(report.alerts).toEqual([])
    expect(report.notReporting).toEqual(expect.arrayContaining(['mail check', 'autopilot', 'daily check']))
  })

  it('the pg_cron cleanup job is late after 26 hours, and absent jobs are ignored', async () => {
    const tables = { cron_heartbeats: beats(), ops_alerts: [] as Row[], ops_health_checks: [] as Row[], ingestion_runs: 'missing' as const }
    const report = await runHealthCheck(fakeAdmin({ stats: stats(10 * MB, [{ job: 'prune-stale-rows', last_ok_at: hoursAgo(27) }]), tables }), NOW)
    expect(report.alerts.map((a) => a.subject)).toEqual(['prune-stale-rows'])
    expect(report.alerts[0].message).toBe('Cleanup has not run for 27 hours')
  })

  it('a database without the stats function reports "database size" as not reporting and raises nothing', async () => {
    const report = await runHealthCheck(fakeAdmin({ stats: 'error', tables: { cron_heartbeats: beats(), ops_alerts: [], ops_health_checks: [], ingestion_runs: 'missing' } }), NOW)
    expect(report.notReporting).toContain('database size')
    expect(report.alerts).toEqual([])
  })
})

describe('source failures', () => {
  const allFail = { greenhouse: { companies: 12, failed: 12 } }
  const fine = { greenhouse: { companies: 12, failed: 1 } }
  const world = (runs: Row[]) => ({ stats: stats(10 * MB), tables: { cron_heartbeats: beats(), ops_alerts: [] as Row[], ops_health_checks: [] as Row[], ingestion_runs: runs } })

  it('three failed checks in a row raise source_failing; two do not', async () => {
    const three = await runHealthCheck(fakeAdmin(world([runRow('c', 1, allFail), runRow('b', 7, allFail), runRow('a', 13, allFail)])), NOW)
    expect(three.alerts).toHaveLength(1)
    expect(three.alerts[0]).toMatchObject({ kind: 'source_failing', subject: 'greenhouse', message: 'Greenhouse boards failed in the last 3 role checks' })
    expect(three.alerts[0].detail.body).toBe('New roles from 12 companies are not coming in. Cello keeps trying every 6 hours.')

    const two = await runHealthCheck(fakeAdmin(world([runRow('c', 1, allFail), runRow('b', 7, allFail), runRow('a', 13, fine)])), NOW)
    expect(two.alerts).toEqual([])
  })

  it('a recovery in the newest check ends the streak', async () => {
    const report = await runHealthCheck(fakeAdmin(world([runRow('c', 1, fine), runRow('b', 7, allFail), runRow('a', 13, allFail), runRow('z', 19, allFail)])), NOW)
    expect(report.alerts).toEqual([])
  })

  it('a check that did not try the provider is skipped, and rows of one batch count as one check', () => {
    const rows = [
      { batch_id: 'c', started_at: hoursAgo(1), by_provider: { greenhouse: { companies: 2, failed: 2 } } },
      { batch_id: 'c', started_at: hoursAgo(1), by_provider: { greenhouse: { companies: 1, failed: 1 } } },
      { batch_id: 'b', started_at: hoursAgo(7), by_provider: { lever: { companies: 4, failed: 0 } } },
      { batch_id: 'a', started_at: hoursAgo(13), by_provider: { greenhouse: { companies: 3, failed: 3 } } },
    ] as never
    const checks = groupChecks(rows)
    expect(checks).toHaveLength(3)
    expect(checks[0].providers.greenhouse).toEqual({ companies: 3, failed: 3 })
    const streaks = Object.fromEntries(providerStreaks(checks).map((s) => [s.provider, s.failedInARow]))
    expect(streaks).toEqual({ greenhouse: 2, lever: 0 })
  })

  it('a missing ingestion_runs table is "not reporting" and raises no alert', async () => {
    const report = await runHealthCheck(fakeAdmin({ stats: stats(10 * MB), tables: { cron_heartbeats: beats(), ops_alerts: [], ops_health_checks: [], ingestion_runs: 'missing' } }), NOW)
    expect(report.notReporting).toContain('role checks')
    expect(report.alerts).toEqual([])
  })

  it('a role check that has not run for 16 hours is a missed schedule', async () => {
    const report = await runHealthCheck(fakeAdmin(world([runRow('a', 16, fine)])), NOW)
    expect(report.alerts.map((a) => [a.kind, a.subject])).toEqual([['schedule_missed', 'role-check']])
    expect(report.alerts[0].message).toBe('Role check has not run for 16 hours')
  })
})

describe('heartbeats', () => {
  it('recordHeartbeat stamps the last success, a failure keeps the old success, and neither throws', async () => {
    const tables = { cron_heartbeats: [] as Row[] }
    const admin = fakeAdmin({ tables })
    await beatStart(admin, 'mail-check', NOW)
    expect(tables.cron_heartbeats[0]).toMatchObject({ job: 'mail-check', last_started_at: NOW.toISOString() })
    await recordHeartbeat(admin, 'mail-check', true, undefined, NOW)
    const later = new Date(NOW.getTime() + 3_600_000)
    await recordHeartbeat(admin, 'mail-check', false, 'x'.repeat(500), later)
    expect(tables.cron_heartbeats).toHaveLength(1)
    expect(tables.cron_heartbeats[0].last_ok_at).toBe(NOW.toISOString())
    expect((tables.cron_heartbeats[0].last_error as string).length).toBe(300)

    const broken = { from: () => ({ upsert: () => Promise.reject(new Error('db down')) }) } as unknown as AdminClient
    await expect(recordHeartbeat(broken, 'mail-check', true)).resolves.toBeUndefined()
    await expect(beatStart(broken, 'mail-check')).resolves.toBeUndefined()
  })
})
