// What the app says about the "Find new roles" check: when it last ran, what it
// found, which companies it could not read and why. Read from ingestion_runs
// under the signed-in user's own session (row level security), never the service
// role.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { FailureReason } from './run'

type Db = SupabaseClient<any, any, any>

export type FindNewRolesState = 'never' | 'checking' | 'done' | 'partial' | 'failed'

export interface FailedCompany {
  companyId: string
  companyName: string
  reason: FailureReason
  /** The sentence the app shows after the company name. */
  text: string
}

export interface FindNewRolesStatus {
  state: FindNewRolesState
  startedAt: string | null
  finishedAt: string | null
  companiesChecked: number
  companiesTotal: number
  jobsNew: number
  jobsUpdated: number
  jobsClosed: number
  failed: FailedCompany[]
  /** The next scheduled check (the cron in .github/workflows/scrape.yml), ISO. */
  nextCheckAt: string
  /** The user has at least one company, so a first check is coming. */
  hasCompanies: boolean
}

/** The words for a company that could not be read. */
export const FAILURE_TEXT: Record<FailureReason, string> = {
  board_error: 'Its job board did not respond',
  fetch_failed: 'Its careers page did not load',
  page_unconfirmed: 'No roles on its careers page could be confirmed',
  model_unavailable: 'Its careers page needs reading and no model was free',
  model_limit: "Today's reading limit was reached",
  bot_check: 'Its site asks visitors to pass a bot check, which Cello does not do',
  login_required: 'Its careers site needs a login',
  robots: 'Its robots.txt asks automated readers to stay away from its careers pages',
  no_roles: 'No open roles were found on its careers site',
  unreachable: 'Its careers site did not answer',
  role_pages: 'Its role pages cannot be read without a browser',
  render_failed: "Cello's browser could not read its careers page",
  budget: 'Its site is large, and one check reads only part of it. The next check reads more',
  time: 'Not reached this time',
}

/** A check that says it is running for longer than this has died. */
export const STALE_RUNNING_MS = 2 * 60 * 60 * 1000

/** The schedule is 41 minutes past 00, 06, 12 and 18 UTC. */
const CRON_HOURS = [0, 6, 12, 18]
const CRON_MINUTE = 41

export function nextCheckAfter(now: Date): Date {
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    for (const hour of CRON_HOURS) {
      const t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset, hour, CRON_MINUTE)
      if (t > now.getTime()) return new Date(t)
    }
  }
  return new Date(now.getTime() + 6 * 60 * 60 * 1000)
}

interface RunRow {
  status: string
  started_at: string
  finished_at: string | null
  companies_checked: number | null
  companies_total: number | null
  jobs_new: number | null
  jobs_updated: number | null
  jobs_closed: number | null
  failed_companies: { company_id?: string; reason?: string }[] | null
}

const KNOWN: ReadonlySet<string> = new Set(Object.keys(FAILURE_TEXT))

export async function readFindNewRoles(client: Db, now: Date = new Date()): Promise<FindNewRolesStatus> {
  const [runResult, countResult] = await Promise.all([
    client
      .from('ingestion_runs')
      .select('status, started_at, finished_at, companies_checked, companies_total, jobs_new, jobs_updated, jobs_closed, failed_companies')
      .eq('task', 'find_new_roles')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    client.from('companies').select('id', { count: 'exact', head: true }),
  ])
  if (runResult.error) throw new Error('ingestion_runs')
  const row = runResult.data as RunRow | null
  const hasCompanies = (countResult.count ?? 0) > 0
  const nextCheckAt = nextCheckAfter(now).toISOString()

  if (!row) {
    return {
      state: 'never',
      startedAt: null,
      finishedAt: null,
      companiesChecked: 0,
      companiesTotal: 0,
      jobsNew: 0,
      jobsUpdated: 0,
      jobsClosed: 0,
      failed: [],
      nextCheckAt,
      hasCompanies,
    }
  }

  let state: FindNewRolesState
  if (row.status === 'running') {
    state = now.getTime() - Date.parse(row.started_at) > STALE_RUNNING_MS ? 'failed' : 'checking'
  } else if (row.status === 'succeeded') state = 'done'
  else if (row.status === 'partial') state = 'partial'
  else state = 'failed'

  const entries = (row.failed_companies ?? []).filter((f) => f.company_id && f.reason && KNOWN.has(f.reason))
  const names = new Map<string, string>()
  if (entries.length > 0) {
    // At most 50 entries are ever stored on a run row, so this is bounded.
    const ids = entries.map((f) => f.company_id as string)
    const { data } = await client.from('companies').select('id, name').in('id', ids.slice(0, 50))
    for (const c of (data ?? []) as { id: string; name: string }[]) names.set(c.id, c.name)
  }
  const failed: FailedCompany[] = entries
    // A company the user has since removed has nothing to tell them about.
    .filter((f) => names.has(f.company_id as string))
    .map((f) => ({
      companyId: f.company_id as string,
      companyName: names.get(f.company_id as string) as string,
      reason: f.reason as FailureReason,
      text: FAILURE_TEXT[f.reason as FailureReason],
    }))

  return {
    state,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    companiesChecked: row.companies_checked ?? 0,
    companiesTotal: row.companies_total ?? 0,
    jobsNew: row.jobs_new ?? 0,
    jobsUpdated: row.jobs_updated ?? 0,
    jobsClosed: row.jobs_closed ?? 0,
    failed,
    nextCheckAt,
    hasCompanies,
  }
}
