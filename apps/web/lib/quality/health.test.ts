// runHealthCheck against an in-memory stand-in for the tables. No network, no database.

import { describe, expect, it } from 'vitest'
import type { AdminClient } from '../harness/types'
import { DB_WARN_BYTES, groupChecks, providerStreaks, runHealthCheck } from './health'

type Row = Record<string, unknown>
const MB = 1024 * 1024
const NOW = new Date('2026-10-06T13:07:00Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()

interface World {
  stats?: Row | 'error'
  tables: Record<string, Row[] | 'missing'>
}

/** Every table the check touches, and a record of which ones it did. */
function fakeAdmin(world: World) {
  const touched = new Set<string>()
  const admin = {
    rpc: async () => (world.stats === undefined || world.stats === 'error' ? { data: null, error: { message: 'no such function' } } : { data: world.stats, error: null }),
    from(name: string) {
      touched.add(name)
      const table = world.tables[name]
      let op: 'select' | 'delete' = 'select'
      const filters: ((r: Row) => boolean)[] = []
      const run = () => {
        if (table === 'missing' || table === undefined) return { data: null, error: { message: `relation "${name}" does not exist`, code: '42P01' } }
        const hit = table.filter((r) => filters.every((f) => f(r)))
        if (op === 'delete') for (const r of hit) table.splice(table.indexOf(r), 1)
        return { data: op === 'delete' ? null : hit, error: null }
      }
      const b: Record<string, unknown> = {
        select: () => b,
        insert: (row: Row) => {
          if (table === 'missing' || table === undefined) return Promise.resolve({ error: { message: 'missing' } })
          table.push({ ...row })
          return Promise.resolve({ error: null })
        },
        delete: () => ((op = 'delete'), b),
        in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), b),
        lt: (c: string, v: string) => (filters.push((r) => String(r[c]) < v), b),
        order: () => b,
        limit: () => b,
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
      }
      return b
    },
  }
  return { admin: admin as unknown as AdminClient, touched }
}

const stats = (bytes: number): Row => ({ db_bytes: bytes, tables: [{ name: 'jobs', bytes: bytes - MB }] })
const beat = (job: string, succeededHoursAgo: number | null, dueHoursAgo: number): Row => ({
  job,
  succeeded_at: succeededHoursAgo === null ? null : hoursAgo(succeededHoursAgo),
  next_due_at: hoursAgo(dueHoursAgo),
})
const onTime = (): Row[] => ['roles.check', 'inbox.sync', 'owner.health'].map((job) => beat(job, 1, -5))

function runRow(batch: string, hours: number, provider: Record<string, { companies: number; failed: number }>): Row {
  return { batch_id: batch, status: 'partial', started_at: hoursAgo(hours), by_provider: provider }
}

const world = (over: World['tables'] = {}, s: World['stats'] = stats(10 * MB)): World => ({
  stats: s,
  tables: { job_heartbeats: onTime(), ops_health_checks: [], ingestion_runs: [], ...over },
})

describe('the report', () => {
  it('stores one row whose report holds the size, the biggest tables, schedules and issues', async () => {
    const w = world()
    const { admin, touched } = fakeAdmin(w)
    const report = await runHealthCheck(admin, NOW)
    expect(report).toMatchObject({ db_bytes: 10 * MB, tables: [{ name: 'jobs', bytes: 9 * MB }], issues: [] })
    expect(report.schedules.map((s) => s.state)).toEqual(['ok', 'ok', 'ok'])
    expect(w.tables.ops_health_checks).toHaveLength(1)
    expect((w.tables.ops_health_checks as Row[])[0]).toMatchObject({ db_bytes: 10 * MB, report })
    expect([...touched].sort()).toEqual(['ingestion_runs', 'job_heartbeats', 'ops_health_checks'])
  })

  it('keeps 90 days of reports', async () => {
    const w = world({ ops_health_checks: [{ checked_at: hoursAgo(24 * 91), db_bytes: 1, report: {} }] })
    await runHealthCheck(fakeAdmin(w).admin, NOW)
    expect(w.tables.ops_health_checks).toHaveLength(1)
    expect((w.tables.ops_health_checks as Row[])[0].db_bytes).toBe(10 * MB)
  })

  it('a size the function cannot give is null and raises nothing', async () => {
    const report = await runHealthCheck(fakeAdmin(world({}, 'error')).admin, NOW)
    expect(report.db_bytes).toBeNull()
    expect(report.issues).toEqual([])
  })
})

describe('database size', () => {
  it('past 350 MB is an issue with a next step; at 350 MB it is not', async () => {
    const high = await runHealthCheck(fakeAdmin(world({}, stats(351 * MB))).admin, NOW)
    expect(high.issues).toHaveLength(1)
    expect(high.issues[0]).toMatchObject({ kind: 'db_size', text: 'The database is at 351 MB, past the 350 MB line' })
    expect(high.issues[0].next).toContain('Remove old jobs')
    const edge = await runHealthCheck(fakeAdmin(world({}, stats(DB_WARN_BYTES))).admin, NOW)
    expect(edge.issues).toEqual([])
  })
})

describe('schedules', () => {
  it('a routine due two hours ago with no success since is late; due 30 minutes ago is not', async () => {
    const late = await runHealthCheck(fakeAdmin(world({ job_heartbeats: [beat('inbox.sync', 5, 2), beat('roles.check', 1, -5), beat('owner.health', 1, -5)] })).admin, NOW)
    expect(late.issues).toHaveLength(1)
    expect(late.issues[0]).toMatchObject({ kind: 'schedule_late', subject: 'inbox.sync' })
    expect(late.issues[0].text).toBe('Mail check has not succeeded since 2026-10-06 08:07 UTC')
    expect(late.schedules.find((s) => s.job === 'inbox.sync')?.state).toBe('late')

    const fine = await runHealthCheck(fakeAdmin(world({ job_heartbeats: [beat('inbox.sync', 5, 0.5), beat('roles.check', 1, -5), beat('owner.health', 1, -5)] })).admin, NOW)
    expect(fine.issues).toEqual([])
  })

  it('a routine that succeeded after it was due is not late', async () => {
    const report = await runHealthCheck(fakeAdmin(world({ job_heartbeats: [beat('roles.check', 1, 3), beat('inbox.sync', 1, -5), beat('owner.health', 1, -5)] })).admin, NOW)
    expect(report.issues).toEqual([])
  })

  it('a routine with no heartbeat row is not reporting, not late', async () => {
    const report = await runHealthCheck(fakeAdmin(world({ job_heartbeats: [beat('roles.check', 1, -5)] })).admin, NOW)
    expect(report.schedules.map((s) => [s.job, s.state])).toEqual([['roles.check', 'ok'], ['inbox.sync', 'not_reporting'], ['owner.health', 'not_reporting']])
    expect(report.issues).toEqual([])
  })

  it('a database without job_heartbeats reads every routine as not reporting', async () => {
    const report = await runHealthCheck(fakeAdmin(world({ job_heartbeats: 'missing' })).admin, NOW)
    expect(report.schedules.every((s) => s.state === 'not_reporting')).toBe(true)
    expect(report.issues).toEqual([])
  })
})

describe('source failures', () => {
  const allFail = { greenhouse: { companies: 12, failed: 12 } }
  const fine = { greenhouse: { companies: 12, failed: 1 } }

  it('three failed checks in a row are an issue; two are not', async () => {
    const three = await runHealthCheck(fakeAdmin(world({ ingestion_runs: [runRow('c', 1, allFail), runRow('b', 7, allFail), runRow('a', 13, allFail)] })).admin, NOW)
    expect(three.issues).toHaveLength(1)
    expect(three.issues[0]).toMatchObject({ kind: 'source_failing', subject: 'greenhouse', text: 'Greenhouse boards failed in the last 3 role checks' })
    expect(three.issues[0].next).toBe('New roles from 12 companies are not coming in. Cello keeps trying.')

    const two = await runHealthCheck(fakeAdmin(world({ ingestion_runs: [runRow('c', 1, allFail), runRow('b', 7, allFail), runRow('a', 13, fine)] })).admin, NOW)
    expect(two.issues).toEqual([])
  })

  it('a recovery in the newest check ends the streak', async () => {
    const report = await runHealthCheck(fakeAdmin(world({ ingestion_runs: [runRow('c', 1, fine), runRow('b', 7, allFail), runRow('a', 13, allFail), runRow('z', 19, allFail)] })).admin, NOW)
    expect(report.issues).toEqual([])
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

  it('a missing ingestion_runs table raises nothing', async () => {
    const report = await runHealthCheck(fakeAdmin(world({ ingestion_runs: 'missing' })).admin, NOW)
    expect(report.sources).toEqual([])
    expect(report.issues).toEqual([])
  })
})
