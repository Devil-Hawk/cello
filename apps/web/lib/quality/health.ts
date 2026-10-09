// The daily health report the owner reads on the dashboard.
//
// The free database is 500 MB and filled once already, a background routine can
// stop without anyone noticing, and a source can fail for days while the rest of
// the product looks fine. Each run stores one row with what it saw: the database
// size and its biggest tables, how fresh each routine is (job_heartbeats, the only
// heartbeat) and which sources failed their last three role checks. The things
// worth acting on are listed in `issues`, computed here and never by a model.
//
// Something that cannot be read (a database without the heartbeat table yet, a
// size the function could not give) is reported as not reporting. It is never
// shown as zero and never raises an issue.

import type { AdminClient } from '../harness/types'
import { DB_LIMIT_BYTES, DB_WARN_BYTES } from './db-limits'
import { exportFeedback } from './feedback'

const HOUR_MS = 60 * 60 * 1000
const MB = 1024 * 1024

export { DB_LIMIT_BYTES, DB_WARN_BYTES }

/** The routines whose heartbeat is checked, and what the owner calls each. */
export const SCHEDULES: Record<string, string> = {
  'roles.check': 'Role check',
  'inbox.sync': 'Mail check',
  'owner.health': 'Health check',
}

/** A routine is late this long after it was due with no success since, the same grace the pages use. */
export const LATE_AFTER_MS = HOUR_MS

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

// --- the report --------------------------------------------------------------------

/** Something the owner can act on, with the next step. */
export interface HealthIssue {
  kind: 'db_size' | 'schedule_late' | 'source_failing'
  subject: string
  text: string
  next: string
}

export interface ScheduleState {
  job: string
  label: string
  state: 'ok' | 'late' | 'not_reporting'
  last_ok_at: string | null
}

/** What is stored in ops_health_checks.report. */
export interface HealthReport {
  checked_at: string
  /** Null when the size could not be read. */
  db_bytes: number | null
  tables: { name: string; bytes: number }[]
  schedules: ScheduleState[]
  sources: ProviderStreak[]
  issues: HealthIssue[]
}

interface HeartbeatRow {
  job: string
  succeeded_at: string | null
  next_due_at: string | null
}

/** The newest of some ISO timestamps, or null. */
function newest(values: (string | null)[]): string | null {
  let best: string | null = null
  for (const v of values) if (v && (best === null || Date.parse(v) > Date.parse(best))) best = v
  return best
}

const mbText = (bytes: number) => `${Math.round(bytes / MB)} MB`

/**
 * Read the signals, store the day's report and drop reports older than 90 days,
 * then send the queued outcome scores to Langfuse (the one place that queue is sent).
 * Never throws for a missing table or function; throws only when the report
 * itself cannot be stored, so the routine that runs it reports the failure.
 */
export async function runHealthCheck(admin: AdminClient, now: Date = new Date()): Promise<HealthReport> {
  const issues: HealthIssue[] = []

  // 1) Database size.
  const stats = await admin.rpc('ops_db_stats')
  const data = stats.error ? null : (stats.data as { db_bytes?: number | string; tables?: { name: string; bytes: number }[] } | null)
  const dbBytes = data?.db_bytes !== undefined ? Number(data.db_bytes) : null
  if (dbBytes !== null && dbBytes > DB_WARN_BYTES) {
    issues.push({
      kind: 'db_size',
      subject: 'database',
      text: `The database is at ${mbText(dbBytes)}, past the ${mbText(DB_WARN_BYTES)} line`,
      next: `Saving new roles stops near ${mbText(DB_LIMIT_BYTES)}. Remove old jobs in Settings or move to a larger plan.`,
    })
  }

  // 2) Routines, from the clock's heartbeat. Any error reading it (a missing table is
  // 42P01 or PGRST205) leaves every routine as not reporting.
  const beats = await admin.from('job_heartbeats').select('job, succeeded_at, next_due_at')
  const rows = beats.error ? [] : ((beats.data ?? []) as HeartbeatRow[])
  const schedules = Object.entries(SCHEDULES).map(([job, label]): ScheduleState => {
    const mine = rows.filter((r) => r.job === job)
    if (mine.length === 0) return { job, label, state: 'not_reporting', last_ok_at: null }
    // ponytail: the newest success and the newest due time across people, so one
    // person's stale row never marks the routine late. Per-person lateness if a person ever needs it.
    const lastOk = newest(mine.map((r) => r.succeeded_at))
    const due = newest(mine.map((r) => r.next_due_at))
    const late = due !== null && now.getTime() > Date.parse(due) + LATE_AFTER_MS && (lastOk === null || Date.parse(lastOk) < Date.parse(due))
    if (late) {
      issues.push({
        kind: 'schedule_late',
        subject: job,
        text: lastOk ? `${label} has not succeeded since ${lastOk.slice(0, 16).replace('T', ' ')} UTC` : `${label} has never succeeded`,
        next: 'Check that the minute sweeper is scheduled in Supabase and that the server has its Vault secrets.',
      })
    }
    return { job, label, state: late ? 'late' : 'ok', last_ok_at: lastOk }
  })

  // 3) Sources that failed their last three role checks in a row.
  const runs = await admin
    .from('ingestion_runs')
    .select('batch_id, status, started_at, by_provider')
    .in('status', ['succeeded', 'partial', 'failed'])
    .order('started_at', { ascending: false })
    .limit(RUN_HISTORY * 10)
  const sources = runs.error ? [] : providerStreaks(groupChecks((runs.data ?? []) as RunRow[]).slice(0, RUN_HISTORY))
  for (const s of sources) {
    if (s.failedInARow >= SOURCE_STREAK) {
      issues.push({
        kind: 'source_failing',
        subject: s.provider,
        text: `${providerName(s.provider)} failed in the last ${SOURCE_STREAK} role checks`,
        next: `New roles from ${s.companies} ${s.companies === 1 ? 'company are' : 'companies are'} not coming in. Cello keeps trying.`,
      })
    }
  }

  const report: HealthReport = {
    checked_at: now.toISOString(),
    db_bytes: dbBytes,
    tables: (data?.tables ?? []).slice(0, 5),
    schedules,
    sources,
    issues,
  }

  // 4) Keep the day's report, and 90 days of them.
  const stored = await admin.from('ops_health_checks').insert({ checked_at: report.checked_at, db_bytes: dbBytes, report })
  if (stored.error) throw new Error(`could not store the health report: ${stored.error.message}`)
  await admin.from('ops_health_checks').delete().lt('checked_at', new Date(now.getTime() - KEEP_CHECKS_DAYS * 24 * HOUR_MS).toISOString())
  // 5) Send the queued outcome scores. Best effort: a Langfuse failure never loses the report.
  try {
    const sent = await exportFeedback(admin, { now })
    console.info(`[health] feedback scores: ${sent.sent} sent, ${sent.skipped} expired, ${sent.failed} failed, ${sent.deleted} old rows removed`)
  } catch (err) {
    console.warn(`[health] feedback scores not sent: ${err instanceof Error ? err.message : String(err)}`)
  }
  return report
}
