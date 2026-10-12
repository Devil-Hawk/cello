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
import { viewerRoles } from '../../jobs/person-jobs'
import { hasPersonTargets, judgeForPerson, prepareTargets } from '../../jobs/target-relevance'
import { hasSource, ingestUser, isDue, makeSupabaseRunsStore, type DueCompany, type UserDeps, type UserSummary } from '../../ingest/run'
import type { RoutineContext, RoutineOutcome } from '../routines'

const PAGE_SIZE = 1000
/** Small enough that the id lists below stay inside a request URL (100 uuids is under 4 KB). */
const REJUDGE_PAGE = 100
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
  const personTargets = { targeting: targets.targeting, titles: targets.titles, typeStep: targets.typeStep }
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
    title_norm: string | null
    role_type: string | null
  }[]
  const prepared = prepareTargets(personTargets.titles)
  const keep: string[] = []
  const hidden: string[] = []
  for (const r of rows) {
    const verdict = judgeForPerson(
      { title: r.title, job_function: r.job_function, seniority: r.seniority, country: r.country, language: r.language, is_remote: r.is_remote, postedAt: r.posted_at, title_norm: r.title_norm, role_type: r.role_type },
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

interface HeldRole {
  job_id: string
  saved_at: string | null
  hidden_reason: string | null
  jobs: HeldJob | HeldJob[] | null
}
interface HeldJob {
  title: string
  job_function: string | null
  seniority: string | null
  country: string | null
  language: string | null
  is_remote: boolean | null
  posted_at: string | null
  employer_id: string | null
  company_id: string | null
  title_norm: string | null
  role_type: string | null
  /** The employer's directory name: a role the sweep stored has no company_id, so no companies row to name it. */
  employer: { name: string | null } | { name: string | null }[] | null
}

/**
 * After the person changes their targets, every role they hold under older targets is judged again, by
 * the same code that stored it. An outside role with no save, no application and no "not for me" is
 * removed and counted by its reason; any other keeps its row under the new version. Roles already under
 * the current version are not touched, so a check with nothing changed costs one query.
 */
export async function rejudgeHeldRoles(
  admin: RoutineContext['admin'],
  userId: string,
  targets: ReaderTargets,
  now: () => number,
  deadlineAt: number
): Promise<{ checked: number; removed: number }> {
  const version = targets.version ?? 0
  const done = { checked: 0, removed: 0 }
  if (version <= 0) return done
  const person = { targeting: targets.targeting, titles: targets.titles, typeStep: targets.typeStep }
  const stated = hasPersonTargets(person)
  const prepared = prepareTargets(person.titles)
  const counts = new Map<string, { employer_id: string | null; company_id: string | null; kind: 'outside_targets'; reason: string; n: number }>()
  const mine = () => admin.from('person_roles')

  while (now() < deadlineAt) {
    const { data, error } = await mine()
      .select('job_id, saved_at, hidden_reason, jobs(title, job_function, seniority, country, language, is_remote, posted_at, employer_id, company_id, title_norm, role_type, employer:company_directory(name))')
      .eq('user_id', userId)
      .lt('targets_version', version)
      .order('job_id')
      .limit(REJUDGE_PAGE)
    if (error) throw new Error('list_held_roles')
    const rows = (data ?? []) as unknown as HeldRole[]
    if (rows.length === 0) break
    const ids = rows.map((r) => r.job_id)
    const { data: apps } = await admin.from('applications').select('job_id').eq('user_id', userId).in('job_id', ids)
    const applied = new Set(((apps ?? []) as { job_id: string }[]).map((a) => a.job_id))
    // the person's own company names a role, never the one that stored it first (an excluded-company keyword reads this name)
    const viewer = await viewerRoles(admin, userId, ids)

    const drop: string[] = []
    const hide: string[] = []
    const show: string[] = []
    for (const r of rows) {
      const job = Array.isArray(r.jobs) ? r.jobs[0] : r.jobs
      if (!job || !stated) continue
      const employer = Array.isArray(job.employer) ? job.employer[0] : job.employer
      const verdict = judgeForPerson(
        { title: job.title, job_function: job.job_function, seniority: job.seniority, country: job.country, language: job.language, is_remote: job.is_remote, postedAt: job.posted_at, title_norm: job.title_norm, role_type: job.role_type },
        person,
        viewer.get(r.job_id)?.viewer_company_name ?? employer?.name ?? null,
        prepared
      )
      if (verdict.keep) {
        if (verdict.hidden && r.hidden_reason === null) hide.push(r.job_id)
        if (!verdict.hidden && r.hidden_reason === 'unclassified') show.push(r.job_id)
      } else if (!r.saved_at && r.hidden_reason !== 'not_for_me' && !applied.has(r.job_id)) {
        drop.push(r.job_id)
        const key = `${job.employer_id ?? job.company_id}|${verdict.reason}`
        const c = counts.get(key) ?? { employer_id: job.employer_id, company_id: job.employer_id ? null : job.company_id, kind: 'outside_targets' as const, reason: verdict.reason, n: 0 }
        c.n += 1
        counts.set(key, c)
      }
    }

    const step = async (q: PromiseLike<{ error: { message: string } | null }>) => {
      const { error: e } = await q
      if (e) throw new Error('rejudge_write')
    }
    if (drop.length > 0) await step(mine().delete().eq('user_id', userId).in('job_id', drop))
    if (hide.length > 0) await step(mine().update({ hidden_reason: 'unclassified' }).eq('user_id', userId).in('job_id', hide))
    if (show.length > 0) await step(mine().update({ hidden_reason: null }).eq('user_id', userId).in('job_id', show))
    const left = ids.filter((id) => !drop.includes(id))
    if (left.length > 0) await step(mine().update({ targets_version: version }).eq('user_id', userId).in('job_id', left))
    done.checked += rows.length
    done.removed += drop.length
  }
  if (counts.size > 0) {
    const { error } = await admin.rpc('set_person_counts', { p_user: userId, p_rows: [...counts.values()] })
    if (error) throw new Error('set_person_counts')
  }
  return done
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
  const targets = await loadTargets(admin, userId)
  // Roles held under older targets first, so the reads below start from what the person holds now.
  let rejudged: Record<string, unknown> = {}
  try {
    const r = await rejudgeHeldRoles(admin, userId, targets, ctx.now, ctx.deadlineAt)
    if (r.checked > 0) rejudged = { rejudged: r.checked, removed: r.removed }
  } catch {
    rejudged = { rejudge_failed: true }
  }
  const finish = async (found: Record<string, unknown>): Promise<Record<string, unknown>> => {
    try {
      const m = await matchDirectoryRoles(admin, userId, targets)
      return { ...found, ...rejudged, matched: m.kept, offered: m.offered }
    } catch {
      return { ...found, ...rejudged, match_failed: true }
    }
  }
  const due = all.filter((c) => {
    if (done.has(c.id) || !hasSource(c) || !isDue(c, now)) return false
    return !(browserRunOn && readSourceCheck(c.metadata)?.reason === 'reading')
  })
  if (due.length === 0) {
    return { ok: true, found: await finish({ employers: all.length, read: Number(totals.read ?? 0), roles: Number(totals.roles ?? 0), new: Number(totals.new ?? 0), cannot_read: Number(totals.cannot_read ?? 0) }) }
  }

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
