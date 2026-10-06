// Daily health check, run inside the harness cron.
//
// The free database is 500 MB and filled once already, a schedule can stop
// without anyone noticing, and a source can fail for days while the rest of the
// product looks fine. Each day this records what it sees (database size, when
// each schedule last succeeded, how each source did in recent role checks) and
// keeps one alert row open per problem:
//
//   db_size          the database passed 350 MB
//   schedule_missed  a schedule has not succeeded inside its window
//   source_failing   a source failed its last three role checks in a row
//
// An alert is resolved by the next check that no longer sees the problem. The
// owner reads them in Needs you (/api/ops/alerts). A table or job that is not
// there yet (a database without pg_cron, ingestion not shipped) is reported as
// "not reporting" and never raises an alert.

import type { AdminClient } from '../harness/types'

const HOUR_MS = 60 * 60 * 1000
const MB = 1024 * 1024

/** Raise the database alert here. The free plan stops at 500 MB. */
export const DB_ALERT_BYTES = 350 * MB
export const DB_LIMIT_BYTES = 500 * MB

/** Heartbeat jobs and how long each may go without a success. The windows are
 *  a little over twice the schedule, because GitHub starts scheduled workflows late. */
export const WINDOWS: Record<string, { windowMs: number; label: string; every: string; where: string }> = {
  'daily-check': { windowMs: 26 * HOUR_MS, label: 'Daily check', every: 'once a day', where: 'the daily check in Vercel cron logs' },
  'mail-check': { windowMs: 3 * HOUR_MS, label: 'Mail check', every: 'every hour', where: 'GitHub Actions and the mail check workflow' },
  autopilot: { windowMs: 9 * HOUR_MS, label: 'Autopilot', every: 'every 4 hours', where: 'GitHub Actions and the autopilot workflow' },
}

/** Scheduled jobs inside Postgres (pg_cron), by job name. */
export const PG_CRON_JOBS: Record<string, { windowMs: number; label: string; every: string; where: string }> = {
  'prune-stale-rows': { windowMs: 26 * HOUR_MS, label: 'Cleanup', every: 'once a day', where: 'the scheduled jobs in Supabase' },
  'cello-agent-sweep': { windowMs: 15 * 60 * 1000, label: 'Scheduled tasks check', every: 'every minute', where: 'the scheduled jobs in Supabase' },
}

/** Role checks run every 6 hours. */
export const ROLE_CHECK = { windowMs: 15 * HOUR_MS, label: 'Role check', every: 'every 6 hours', where: 'GitHub Actions and the role check workflow' }

export const SOURCE_STREAK = 3
const RUN_HISTORY = 30
const KEEP_CHECKS_DAYS = 90

const PROVIDER_NAMES: Record<string, string> = {
  greenhouse: 'Greenhouse boards',
  lever: 'Lever boards',
  ashby: 'Ashby boards',
  workable: 'Workable boards',
  smartrecruiters: 'SmartRecruiters boards',
  page_reader: 'Company career pages',
  aggregators: 'Job aggregators',
}

export function providerName(id: string): string {
  return PROVIDER_NAMES[id] ?? `${id.charAt(0).toUpperCase()}${id.slice(1).replace(/[_-]/g, ' ')} sources`
}

// --- heartbeats ----------------------------------------------------------------

/** Mark a job as started. Best effort: a heartbeat must never fail the job. */
export async function beatStart(admin: AdminClient, job: string, now: Date = new Date()): Promise<void> {
  try {
    await admin.from('cron_heartbeats').upsert({ job, last_started_at: now.toISOString(), updated_at: now.toISOString() }, { onConflict: 'job' })
  } catch (err) {
    console.warn(`[health] heartbeat start for ${job} failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Mark a job as finished, with the error when it failed. */
export async function recordHeartbeat(admin: AdminClient, job: string, ok: boolean, error?: string, now: Date = new Date()): Promise<void> {
  const at = now.toISOString()
  try {
    await admin.from('cron_heartbeats').upsert(
      ok
        ? { job, last_started_at: at, last_ok_at: at, last_error: null, updated_at: at }
        : { job, last_started_at: at, last_error: (error ?? 'failed').slice(0, 300), updated_at: at },
      { onConflict: 'job' }
    )
  } catch (err) {
    console.warn(`[health] heartbeat for ${job} failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// --- sources ---------------------------------------------------------------------

interface ProviderCounts {
  companies?: number
  failed?: number
}
export interface RunRow {
  batch_id: string
  status?: string
  started_at: string
  by_provider: Record<string, ProviderCounts> | null
}

/** One role check: every user's row for the same batch added together. */
interface Check {
  startedAt: string
  /** provider -> {attempted, failed} */
  providers: Record<string, { companies: number; failed: number }>
}

/** Rows (one per user per check) grouped into checks, newest first. */
export function groupChecks(rows: RunRow[]): Check[] {
  const byBatch = new Map<string, Check>()
  for (const row of rows) {
    const check = byBatch.get(row.batch_id) ?? { startedAt: row.started_at, providers: {} }
    if (row.started_at > check.startedAt) check.startedAt = row.started_at
    for (const [provider, c] of Object.entries(row.by_provider ?? {})) {
      const cur = check.providers[provider] ?? { companies: 0, failed: 0 }
      cur.companies += Number(c?.companies ?? 0)
      cur.failed += Number(c?.failed ?? 0)
      check.providers[provider] = cur
    }
    byBatch.set(row.batch_id, check)
  }
  return [...byBatch.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
}

export interface ProviderStreak {
  provider: string
  /** Attempted checks in a row, newest first, in which every company failed. */
  failedInARow: number
  /** Companies in the most recent attempted check. */
  companies: number
}

/**
 * For each provider: how many of its latest attempted checks, counting back
 * from the newest, failed. A check failed for a provider when every company it
 * tried failed (failed >= companies > 0). A check that did not try the provider
 * is skipped, so a quiet provider keeps its streak and a recovery ends it.
 */
export function providerStreaks(checks: Check[]): ProviderStreak[] {
  const providers = new Set(checks.flatMap((c) => Object.keys(c.providers)))
  const out: ProviderStreak[] = []
  for (const provider of providers) {
    let failedInARow = 0
    let companies = 0
    let first = true
    for (const check of checks) {
      const p = check.providers[provider]
      if (!p || p.companies <= 0) continue
      if (first) {
        companies = p.companies
        first = false
      }
      if (p.failed >= p.companies) failedInARow += 1
      else break
    }
    out.push({ provider, failedInARow, companies })
  }
  return out
}

// --- alerts ------------------------------------------------------------------------

export type AlertKind = 'db_size' | 'schedule_missed' | 'source_failing'
export interface DesiredAlert {
  kind: AlertKind
  subject: string
  message: string
  detail: Record<string, unknown>
}

function hoursText(ms: number): string {
  const hours = Math.floor(ms / HOUR_MS)
  if (hours < 1) return `${Math.max(1, Math.floor(ms / 60_000))} minutes`
  return hours === 1 ? '1 hour' : `${hours} hours`
}

function mbText(bytes: number): string {
  return `${Math.round(bytes / MB)} MB`
}

export interface HealthReport {
  checkedAt: string
  dbBytes: number | null
  schedules: { job: string; label: string; lastOkAt: string | null; late: boolean }[]
  sources: ProviderStreak[]
  /** Things that could not be read, so nothing could be said about them. */
  notReporting: string[]
  alerts: DesiredAlert[]
  resolved: number
}

interface DbStats {
  db_bytes?: number | string
  tables?: { name: string; bytes: number }[]
  schedules?: { job: string; last_ok_at: string | null }[]
}

/**
 * Read the signals, upsert one open alert per problem, resolve the ones that
 * cleared, and store the day's report. Never throws for a missing table or job.
 */
export async function runHealthCheck(admin: AdminClient, now: Date = new Date()): Promise<HealthReport> {
  const notReporting: string[] = []
  const desired: DesiredAlert[] = []
  const schedules: HealthReport['schedules'] = []

  // 1) Database size and pg_cron history.
  let stats: DbStats | null = null
  try {
    const { data, error } = await admin.rpc('ops_db_stats')
    if (error) throw new Error(error.message)
    stats = data as DbStats
  } catch {
    notReporting.push('database size')
  }
  const dbBytes = stats?.db_bytes !== undefined ? Number(stats.db_bytes) : null
  if (dbBytes !== null && dbBytes > DB_ALERT_BYTES) {
    desired.push({
      kind: 'db_size',
      subject: 'database',
      message: `Database is at ${mbText(dbBytes)} of ${mbText(DB_LIMIT_BYTES)}`,
      detail: {
        body: 'Saving new roles stops near the limit. Remove old jobs in Settings or move to a larger plan.',
        db_bytes: dbBytes,
        biggest: (stats?.tables ?? []).slice(0, 3),
      },
    })
  }

  const lateAlert = (job: string, spec: { windowMs: number; label: string; every: string; where: string }, lastOk: string | null, lastStarted: string | null, extra: Record<string, unknown> = {}) => {
    const reference = lastOk ?? lastStarted
    const age = reference ? now.getTime() - new Date(reference).getTime() : null
    const late = age !== null && age > spec.windowMs
    schedules.push({ job, label: spec.label, lastOkAt: lastOk, late })
    if (late && age !== null) {
      desired.push({
        kind: 'schedule_missed',
        subject: job,
        message: `${spec.label} has not run for ${hoursText(age)}`,
        detail: { body: `It should run ${spec.every}. Open ${spec.where}.`, last_ok_at: lastOk, ...extra },
      })
    }
  }

  // 2) Heartbeats from the harness cron, the mail check and autopilot.
  try {
    const { data, error } = await admin.from('cron_heartbeats').select('job, last_ok_at, last_started_at, last_error')
    if (error) throw new Error(error.message)
    const beats = new Map(((data ?? []) as { job: string; last_ok_at: string | null; last_started_at: string | null; last_error: string | null }[]).map((r) => [r.job, r]))
    for (const [job, spec] of Object.entries(WINDOWS)) {
      const beat = beats.get(job)
      if (!beat) {
        notReporting.push(spec.label.toLowerCase())
        continue
      }
      lateAlert(job, spec, beat.last_ok_at, beat.last_started_at, beat.last_error ? { last_error: beat.last_error } : {})
    }
  } catch {
    notReporting.push('schedule heartbeats')
  }

  // 3) Scheduled jobs inside Postgres.
  for (const [job, spec] of Object.entries(PG_CRON_JOBS)) {
    const found = stats?.schedules?.find((s) => s.job === job)
    if (!found) continue // not scheduled here (no pg_cron, or the work is not shipped yet)
    lateAlert(job, spec, found.last_ok_at, null)
  }

  // 4) Role checks: freshness and per-source failures.
  let checks: Check[] = []
  try {
    const { data, error } = await admin
      .from('ingestion_runs')
      .select('batch_id, status, started_at, by_provider')
      .in('status', ['succeeded', 'partial', 'failed'])
      .order('started_at', { ascending: false })
      .limit(RUN_HISTORY * 10)
    if (error) throw new Error(error.message)
    checks = groupChecks((data ?? []) as RunRow[]).slice(0, RUN_HISTORY)
  } catch {
    notReporting.push('role checks')
  }
  if (checks.length > 0) lateAlert('role-check', ROLE_CHECK, checks[0].startedAt, null)
  const sources = providerStreaks(checks)
  for (const s of sources) {
    if (s.failedInARow >= SOURCE_STREAK) {
      desired.push({
        kind: 'source_failing',
        subject: s.provider,
        message: `${providerName(s.provider)} failed in the last ${SOURCE_STREAK} role checks`,
        detail: {
          body: `New roles from ${s.companies} ${s.companies === 1 ? 'company are' : 'companies are'} not coming in. Cello keeps trying every 6 hours.`,
          companies: s.companies,
          failed_in_a_row: s.failedInARow,
        },
      })
    }
  }

  // 5) Alerts: one open row per kind and subject.
  let resolved = 0
  try {
    const { data, error } = await admin.from('ops_alerts').select('id, kind, subject').is('resolved_at', null)
    if (error) throw new Error(error.message)
    const open = (data ?? []) as { id: string; kind: string; subject: string }[]
    const key = (kind: string, subject: string) => `${kind}\u0000${subject}`
    const openByKey = new Map(open.map((o) => [key(o.kind, o.subject), o.id]))
    const wanted = new Set(desired.map((d) => key(d.kind, d.subject)))
    const at = now.toISOString()
    for (const d of desired) {
      const id = openByKey.get(key(d.kind, d.subject))
      if (id) await admin.from('ops_alerts').update({ message: d.message.slice(0, 300), detail: d.detail, last_seen_at: at }).eq('id', id)
      else await admin.from('ops_alerts').insert({ kind: d.kind, subject: d.subject, message: d.message.slice(0, 300), detail: d.detail, first_seen_at: at, last_seen_at: at })
    }
    const cleared = open.filter((o) => !wanted.has(key(o.kind, o.subject))).map((o) => o.id)
    if (cleared.length > 0) {
      await admin.from('ops_alerts').update({ resolved_at: at }).in('id', cleared)
      resolved = cleared.length
    }
  } catch (err) {
    console.warn(`[health] could not update alerts: ${err instanceof Error ? err.message : String(err)}`)
  }

  const report: HealthReport = { checkedAt: now.toISOString(), dbBytes, schedules, sources, notReporting, alerts: desired, resolved }

  // 6) Keep the day's report, and 90 days of them.
  try {
    if (dbBytes !== null) await admin.from('ops_health_checks').insert({ checked_at: now.toISOString(), db_bytes: dbBytes, report })
    await admin.from('ops_health_checks').delete().lt('checked_at', new Date(now.getTime() - KEEP_CHECKS_DAYS * 24 * HOUR_MS).toISOString())
  } catch (err) {
    console.warn(`[health] could not store the report: ${err instanceof Error ? err.message : String(err)}`)
  }

  return report
}
