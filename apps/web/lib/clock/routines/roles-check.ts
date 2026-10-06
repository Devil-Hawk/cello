// roles.check: one person's check of the employers they follow, every 6 hours.
//
// It reads each due employer with plain requests (the job board, the site's own search, its
// sitemaps, its server-rendered lists) in slices that stop starting new work before 240 seconds and
// hand the rest on. A site that only a browser can read is marked "reading"; the sweeper dispatches
// those, as one run of the scrape workflow, when roles.render is on (lib/clock, migration 040000).
// The person's check never waits for a browser.

import { randomUUID } from 'node:crypto'
import { makeSupabaseAtsStore, type AtsStoreOptions } from '../../ats/store'
import { readSourceCheck } from '../../companies/roles-status'
import { trackedOnly } from '../../companies/watchlist'
import { staticFetchPage } from '../../ingest/fetch-page'
import { newModelBudget } from '../../ingest/model'
import { loadTargets, type ReaderTargets } from '../../ingest/reader/targets'
import { hasPersonTargets, judgeForPerson, prepareTargets } from '../../jobs/target-relevance'
import { hasSource, ingestUser, isDue, makeSupabaseRunsStore, type DueCompany, type UserDeps, type UserSummary } from '../../ingest/run'
import type { RoutineContext, RoutineOutcome } from '../routines'

const PAGE_SIZE = 1000
/** The state a slice hands the next: the employers already read in this check. */
const MAX_DONE = 1500

export interface RolesCheckDeps {
  /** Replaces the store, the runs table and the reader's ports in tests. */
  ingest?: (userId: string, companies: DueCompany[], deps: UserDeps, opts: { batchId: string; trigger?: 'schedule' | 'manual' }) => Promise<UserSummary>
  storeOptions?: AtsStoreOptions
}

async function renderIsOn(admin: RoutineContext['admin']): Promise<boolean> {
  const { data } = await admin.from('routines').select('enabled').eq('command', 'roles.render').is('user_id', null).maybeSingle()
  return (data as { enabled?: boolean } | null)?.enabled === true
}

export interface DirectoryMatch {
  /** Stored roles at verified employers the person did not hold yet. */
  offered: number
  /** Of those, the ones given to the person (inside their targets). */
  kept: number
  /** Of the kept, the ones hidden because a dimension could not be read. */
  hidden: number
}

const NO_MATCH: DirectoryMatch = { offered: 0, kept: 0, hidden: 0 }
const MATCH_LIMIT = 2000

/**
 * The directory match: roles other people's checks already stored at verified employers, judged
 * against this person's targets in code. After a change of targets every stored role is looked at;
 * otherwise only the roles stored since the last successful check. A person who follows nothing
 * still gets it. The targets filter runs over every role it is offered, so a posting that is already
 * known is never held back from someone it fits.
 */
export async function matchDirectoryRoles(admin: RoutineContext['admin'], userId: string, targets: ReaderTargets): Promise<DirectoryMatch> {
  const personTargets = { targeting: targets.targeting, titles: targets.titles }
  if (!hasPersonTargets(personTargets)) return NO_MATCH
  const version = targets.version ?? 0

  // A check under newer targets than the person's roles were kept under looks at everything stored.
  const [held, last] = await Promise.all([
    admin.from('person_roles').select('targets_version').eq('user_id', userId).order('targets_version', { ascending: false }).limit(1).maybeSingle(),
    admin.from('job_heartbeats').select('succeeded_at').eq('job', 'roles.check').eq('user_id', userId).maybeSingle(),
  ])
  const heldVersion = (held.data as { targets_version?: number } | null)?.targets_version
  const lastOk = (last.data as { succeeded_at?: string | null } | null)?.succeeded_at
  const since = heldVersion === undefined || heldVersion < version || !lastOk ? null : new Date(Date.parse(lastOk) - 3_600_000).toISOString()

  const { data, error } = await admin.rpc('directory_roles_for', { p_user: userId, p_since: since, p_limit: MATCH_LIMIT })
  if (error) throw new Error('directory_roles_for')
  const rows = (data ?? []) as {
    id: string
    title: string
    job_function: string | null
    seniority: string | null
    country: string | null
    language: string | null
    is_remote: boolean | null
    posted_at: string | null
    employer_name: string | null
  }[]
  const prepared = prepareTargets(personTargets.titles)
  const keep: string[] = []
  const hidden: string[] = []
  for (const r of rows) {
    const verdict = judgeForPerson(
      { title: r.title, job_function: r.job_function, seniority: r.seniority, country: r.country, language: r.language, is_remote: r.is_remote, postedAt: r.posted_at },
      personTargets,
      r.employer_name,
      prepared
    )
    if (!verdict.keep) continue
    keep.push(r.id)
    if (verdict.hidden) hidden.push(r.id)
  }
  if (keep.length > 0) {
    const { error: addError } = await admin.rpc('add_person_roles', { p_user: userId, p_job_ids: keep, p_hidden: hidden, p_targets_version: version })
    if (addError) throw new Error('add_person_roles')
  }
  return { offered: rows.length, kept: keep.length, hidden: hidden.length }
}

export async function rolesCheck(ctx: RoutineContext, injected: RolesCheckDeps = {}): Promise<RoutineOutcome> {
  const { admin, userId } = ctx
  if (!userId) return { ok: false, failure: 'no_user' }
  const done = new Set(Array.isArray(ctx.state?.done) ? (ctx.state?.done as unknown[]).filter((x): x is string => typeof x === 'string') : [])
  const totals = (ctx.state?.totals as Record<string, number> | undefined) ?? {}

  const all: DueCompany[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await trackedOnly(admin.from('companies').select('*').eq('user_id', userId))
      .order('created_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) return { ok: false, failure: 'list_companies' }
    all.push(...((data ?? []) as unknown as DueCompany[]))
    if (!data || data.length < PAGE_SIZE) break
  }

  // A site only a browser can read belongs to the dispatched run, once that is on.
  const browserRunOn = await renderIsOn(admin)
  const now = ctx.now()
  const finish = async (found: Record<string, unknown>): Promise<Record<string, unknown>> => {
    try {
      const m = await matchDirectoryRoles(admin, userId, await loadTargets(admin, userId))
      return { ...found, matched: m.kept, offered: m.offered }
    } catch {
      return { ...found, match_failed: true }
    }
  }
  const due = all.filter((c) => {
    if (done.has(c.id) || !hasSource(c) || !isDue(c, now)) return false
    return !(browserRunOn && readSourceCheck(c.metadata)?.reason === 'reading')
  })
  if (due.length === 0) {
    return { ok: true, found: await finish({ employers: all.length, read: Number(totals.read ?? 0), roles: Number(totals.roles ?? 0), new: Number(totals.new ?? 0), cannot_read: Number(totals.cannot_read ?? 0) }) }
  }

  const targets = await loadTargets(admin, userId)
  const batchId = randomUUID()
  const ingest = injected.ingest ?? ingestUser
  const summary = await ingest(
    userId,
    due,
    {
      store: makeSupabaseAtsStore(admin, { lockClient: admin, holder: `clock-${batchId}`, ...injected.storeOptions }),
      runs: makeSupabaseRunsStore(admin),
      requirements: null,
      budget: newModelBudget(0),
      deadlineAt: ctx.deadlineAt,
      fetchPage: staticFetchPage,
      model: null,
      mode: 'inline',
      targets,
      now: ctx.now,
    },
    { batchId, trigger: 'schedule' }
  )

  const reached = summary.outcomes.filter((o) => o.failure !== 'time')
  for (const o of reached) done.add(o.result.companyId)
  const notReached = summary.outcomes.length - reached.length
  const p = summary.patch
  const cannotRead = summary.outcomes.filter((o) => o.failure && o.failure !== 'time').length
  const sum = {
    read: Number(totals.read ?? 0) + reached.length,
    roles: Number(totals.roles ?? 0) + p.jobs_found,
    new: Number(totals.new ?? 0) + p.jobs_new,
    cannot_read: Number(totals.cannot_read ?? 0) + cannotRead,
  }

  if (notReached > 0) {
    return { ok: true, next: { done: [...done].slice(-MAX_DONE), totals: sum } }
  }
  // Every employer failed: the check itself did not work, which is not the same as nothing new.
  const failed = p.status === 'failed'
  return { ok: !failed, failure: failed ? 'every_employer_failed' : undefined, found: await finish({ employers: all.length, ...sum }) }
}
