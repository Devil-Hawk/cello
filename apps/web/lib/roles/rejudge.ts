// The re-judge after a target change. Every role a person holds under older targets is judged again by
// the one judge (keep.ts), in pages of 100. A role now outside is removed and counted by its reason,
// unless the person saved it, applied to it or set it aside; any other role moves to the new version.
// Roles already under the current version are not touched, so a check with nothing changed costs one query.
//
// Run by roles.check, which the profiles_targets_changed trigger pokes when targeting or constraints change.

import type { SupabaseClient } from '@supabase/supabase-js'
import { viewerRoles } from '../jobs/person-jobs'
import { hasPersonTargets } from '../jobs/target-relevance'
import { loadTargets, type ReaderTargets } from '../ingest/reader/targets'
import { keepsRole, type RoleToKeep } from './keep'

type Db = SupabaseClient<any, any, any>

/** Small enough that the id lists below stay inside a request URL (100 uuids is under 4 KB). */
const PAGE = 100

export interface HeldRole {
  job_id: string
  saved_at: string | null
  hidden_reason: string | null
  jobs: HeldJob | HeldJob[] | null
}
export interface HeldJob {
  title: string
  description: string | null
  location: string | null
  salary_range: string | null
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

/** The embed a person_roles query reads to judge the stored role: the columns the judge looks at. */
export const HELD_JOB = 'jobs(title, description, location, salary_range, job_function, seniority, country, language, is_remote, posted_at, employer_id, company_id, title_norm, role_type, employer:company_directory(name))'

/** A stored role as the judge reads it. `company` is the person's own name for the employer, else the directory's. */
export function heldRole(r: HeldRole, viewerCompany?: string | null): { job: HeldJob; role: RoleToKeep } | null {
  const job = Array.isArray(r.jobs) ? r.jobs[0] : r.jobs
  if (!job) return null
  const employer = Array.isArray(job.employer) ? job.employer[0] : job.employer
  return {
    job,
    role: {
      title: job.title,
      description: job.description,
      location: job.location,
      salary_range: job.salary_range,
      job_function: job.job_function,
      seniority: job.seniority,
      country: job.country,
      language: job.language,
      is_remote: job.is_remote,
      postedAt: job.posted_at,
      title_norm: job.title_norm,
      role_type: job.role_type,
      company: viewerCompany ?? employer?.name ?? null,
    },
  }
}

export interface RejudgeOptions {
  /** The person's targets, when the caller has read them already; else they are loaded. */
  targets?: ReaderTargets
  now?: () => number
  /** Epoch ms: start no new page after this. The next check picks up the rest. */
  deadlineAt?: number
}

export async function rejudgePerson(db: Db, userId: string, opts: RejudgeOptions = {}): Promise<{ checked: number; removed: number }> {
  const targets = opts.targets ?? (await loadTargets(db, userId))
  const now = opts.now ?? Date.now
  const deadlineAt = opts.deadlineAt ?? Infinity
  const version = targets.version ?? 0
  const done = { checked: 0, removed: 0 }
  if (version <= 0) return done
  const stated = hasPersonTargets(targets)
  const counts = new Map<string, { employer_id: string | null; company_id: string | null; kind: 'outside_targets'; reason: string; n: number }>()
  const mine = () => db.from('person_roles')

  while (now() < deadlineAt) {
    const { data, error } = await mine()
      .select('job_id, saved_at, hidden_reason, ' + HELD_JOB)
      .eq('user_id', userId)
      .lt('targets_version', version)
      .order('job_id')
      .limit(PAGE)
    if (error) throw new Error('list_held_roles')
    const rows = (data ?? []) as unknown as HeldRole[]
    if (rows.length === 0) break
    const ids = rows.map((r) => r.job_id)
    const { data: apps } = await db.from('applications').select('job_id').eq('user_id', userId).in('job_id', ids)
    const applied = new Set(((apps ?? []) as { job_id: string }[]).map((a) => a.job_id))
    // the person's own company names a role, never the one that stored it first (an excluded-company keyword reads this name)
    const viewer = await viewerRoles(db, userId, ids)

    const drop: string[] = []
    const hide: string[] = []
    const show: string[] = []
    for (const r of rows) {
      const held = heldRole(r, viewer.get(r.job_id)?.viewer_company_name)
      if (!held || !stated) continue
      const { job, role } = held
      const verdict = keepsRole(role, targets)
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
    const { error } = await db.rpc('set_person_counts', { p_user: userId, p_rows: [...counts.values()] })
    if (error) throw new Error('set_person_counts')
  }
  return done
}
