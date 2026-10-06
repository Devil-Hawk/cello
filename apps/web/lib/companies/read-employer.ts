// One read of a verified employer's board by the directory sweep (part 6, "Verified directory and sweep").
//
// The plain board tier only, no model. A read does three things with what the board lists:
//   counts   every listing, by role type and level, goes to employer_stats whether or not anyone wants it, and the
//            employer's "of N open" is that total
//   keeps    a role is stored only when it is inside the targets of at least one person (directive 26), through the
//            same capture a person's own read uses (Markdown body, requirements, type); roles nobody wants are counted
//   closes   the roles the board no longer lists count a miss and close at the second
// Roles are judged by the same code as everywhere: the employer's own, open, real (legit.ts), then each person's
// targets (target-relevance.ts). An employer nobody follows keeps only roles from the last 30 days; one somebody
// follows keeps up to 180 (freshness.ts).
//
// Every 90 days, and at once when a read's jobs name another employer, the board is checked again by the verifier before
// anything is stored; a board that no longer checks out leaves the rotation with its reason. The row itself is only ever written by verify-directory.ts.
//
// Employers read through their own site (no board) are not swept: their followers' checks read them
// (lib/clock/routines/roles-check.ts).

import type { SupabaseClient } from '@supabase/supabase-js'
import { isDemoProfile } from '../access/guardrails'
import { jobRow, providers, sanitizeJobs, sourcesFor, type ExistingJob } from '../ats/index'
import { HttpError } from '../ats/http'
import { sameEmployerName } from '../ats/verify'
import { makeSupabaseAtsStore } from '../ats/store'
import type { AtsJob, AtsProviderId } from '../ats/types'
import { loadTargets } from '../ingest/reader/targets'
import { judgeRole, MAX_ROLES_PER_COMPANY } from '../ingest/reader/legit'
import { classifyJob, isLowQuality } from '../jobs/classify'
import { DIRECTORY_MAX_AGE_DAYS, ROLE_MAX_AGE_DAYS, isStalePosting } from '../jobs/freshness'
import { typeTitle } from '../jobs/role-types'
import { hasPersonTargets, judgeForPerson, prepareTargets, type PersonTargets } from '../jobs/target-relevance'
import type { DirectoryRow } from './directory'
import { checkBoard, realDeps, recordRead, writeEmployer, type DirectorySource, type FailReason, type VerifyDeps } from './verify-directory'

type Db = SupabaseClient<any, any, any>

const DAY_MS = 86_400_000
/** Every verified board is checked again this often (part 6, re-verification). */
export const REVERIFY_DAYS = 90
/** Rows per request to the database: a body can be 200,000 characters. */
const WRITE_CHUNK = 25

export interface Person {
  userId: string
  targets: PersonTargets
  prepared: ReturnType<typeof prepareTargets>
}

/**
 * The people whose targets decide what the sweep keeps: everyone with something stated, demos left out.
 * ponytail: one targets read per person per slice; cache them across slices when the people outnumber the minutes.
 */
export async function loadPeople(db: Db): Promise<Person[]> {
  const { data } = await db.from('profiles').select('id, is_demo, demo_expires_at').limit(5000)
  const people: Person[] = []
  for (const p of (data ?? []) as { id: string; is_demo: boolean | null; demo_expires_at: string | null }[]) {
    if (isDemoProfile(p)) continue
    const t = await loadTargets(db, p.id)
    const targets: PersonTargets = { targeting: t.targeting, titles: t.titles, typeStep: t.typeStep }
    if (hasPersonTargets(targets)) people.push({ userId: p.id, targets, prepared: prepareTargets(targets.titles) })
  }
  return people
}

export interface ReadDeps {
  verify: VerifyDeps
  /** The employer's stored roles, for what is new and what changed. */
  listStored: (employerId: string) => Promise<ExistingJob[]>
}

export const realReadDeps = (db: Db): ReadDeps => ({ verify: realDeps, listStored: (id) => makeSupabaseAtsStore(db).listJobs('', id) })

export interface EmployerRead {
  /** Roles the board listed: the employer's "of N open". */
  listed: number
  /** Of those, the roles inside someone's targets. */
  kept: number
  /** Rows written: new roles and roles whose posting changed. */
  stored: number
  failure?: FailReason
  /** Writes that failed after the board was read (the read still counts). */
  errors: string[]
}

interface Stat {
  role_type: string | null
  seniority: string
  open: number
  opened_30d: number
  opened_90d: number
  stated_pay: { stated: number } | null
}

async function followed(db: Db, employerId: string): Promise<boolean> {
  const { count } = await db.from('companies').select('id', { count: 'exact', head: true }).eq('employer_id', employerId).eq('watching', true)
  return (count ?? 0) > 0
}

export async function readEmployer(db: Db, employer: DirectoryRow, people: Person[], deps: ReadDeps = realReadDeps(db)): Promise<EmployerRead> {
  const out: EmployerRead = { listed: 0, kept: 0, stored: 0, errors: [] }
  const provider = employer.ats_provider as AtsProviderId | null
  const token = employer.ats_token
  if (!provider || !token || !providers[provider]) return out
  const now = deps.verify.now()
  const stored = new Map((await deps.listStored(employer.id)).map((s) => [s.externalId, s]))

  // The look at the board itself: still this employer's, still alive. Before anything is stored, counted or recorded.
  const recheck = async (): Promise<AtsJob[] | FailReason> => {
    const check = await checkBoard({ name: employer.name, domain: employer.domain, careerUrl: employer.careers_url, provider, token }, deps.verify)
    if (!check.ok) {
      await recordRead(db, employer, { ok: false, reason: check.reason, permanent: check.reason !== 'cannot_read' }, deps.verify.now)
      return check.reason
    }
    await writeEmployer(
      db,
      { name: check.name, domain: employer.domain, careersUrl: employer.careers_url, provider, token, verifiedBy: check.verifiedBy, source: employer.source as DirectorySource, openCount: employer.open_count, readTier: employer.read_tier },
      deps.verify.now
    )
    return check.jobs
  }

  let jobs: AtsJob[]
  if (!employer.verified_at || now - Date.parse(employer.verified_at) > REVERIFY_DAYS * DAY_MS) {
    const r = await recheck()
    if (typeof r === 'string') return { ...out, failure: r }
    jobs = r
  } else {
    try {
      jobs = await deps.verify.fetchBoard(provider, token, { hasDescription: (id) => stored.get(id)?.descriptionMd5 != null })
    } catch (error) {
      const gone = error instanceof HttpError && (error.status === 404 || error.status === 410)
      const reason: FailReason = gone ? 'no_board' : 'cannot_read'
      await recordRead(db, employer, { ok: false, reason, permanent: gone }, deps.verify.now)
      return { ...out, failure: reason }
    }
    // A board that changed hands: the jobs name an employer and none of them is this one (part 6, re-verification).
    const named = jobs.map((j) => j.employer).filter((n): n is string => !!n)
    if (named.length > 0 && !named.some((n) => sameEmployerName(n, employer.name))) {
      const r = await recheck()
      if (typeof r === 'string') return { ...out, failure: r }
      jobs = r
    }
  }

  const clean = sanitizeJobs(jobs)
  out.listed = clean.length
  const nowIso = new Date(now).toISOString()
  const maxAge = (await followed(db, employer.id)) ? ROLE_MAX_AGE_DAYS : DIRECTORY_MAX_AGE_DAYS
  const ctx = { company: { name: employer.name, domain: employer.domain, careerUrl: employer.careers_url }, now }

  // Count every listing; consider for storage only the employer's own, open, real and recent ones.
  const stats = new Map<string, Stat>()
  const candidates: { job: AtsJob; title: string; c: ReturnType<typeof classifyJob>; t: ReturnType<typeof typeTitle> }[] = []
  for (const job of clean) {
    const title = job.title.trim()
    const t = typeTitle(title)
    const c = classifyJob({ title, description: job.description, location: job.location, companyName: employer.name })
    const key = `${t.role_type ?? ''}|${c.seniority}`
    const s = stats.get(key) ?? { role_type: t.role_type, seniority: c.seniority, open: 0, opened_30d: 0, opened_90d: 0, stated_pay: null }
    s.open++
    const age = job.postedAt ? now - Date.parse(job.postedAt) : NaN
    if (age <= 30 * DAY_MS) s.opened_30d++
    if (age <= 90 * DAY_MS) s.opened_90d++
    if (job.salary) s.stated_pay = { stated: (s.stated_pay?.stated ?? 0) + 1 }
    stats.set(key, s)
    if (isStalePosting(job.postedAt, now, maxAge) || !judgeRole(job, ctx).keep || c.rejectReason || isLowQuality(c)) continue
    candidates.push({ job, title, c, t })
  }

  // Kept when any person's targets keep it. ponytail: people x roles judgements per read; index by role type when it shows.
  const keep = candidates.filter(({ job, title, c, t }) => {
    const role = { title, description: job.description, job_function: c.jobFunction, seniority: c.seniority, country: c.country, language: c.language, is_remote: c.isRemote, postedAt: job.postedAt, title_norm: t.title_norm, role_type: t.role_type }
    return people.some((p) => judgeForPerson(role, p.targets, employer.name, p.prepared).keep)
  })
  out.kept = keep.length

  // New roles up to the employer's cap, newest first; a stored role is written again only when its posting changed.
  let room = Math.max(0, MAX_ROLES_PER_COMPANY - stored.size)
  const rows: Record<string, unknown>[] = []
  for (const { job, title, c } of [...keep].sort((a, b) => (b.job.postedAt ?? '').localeCompare(a.job.postedAt ?? ''))) {
    const have = stored.get(job.externalId)
    const { company_id: _unused, ...row } = jobRow({ id: employer.id, employer_id: employer.id }, job, title, c, provider, nowIso)
    if (!have) {
      if (room-- > 0) rows.push(row)
    } else if (row.description_md && row.description_md5 !== have.descriptionMd5 && !(row.description_state === 'partial' && have.descriptionMd5 !== null)) {
      rows.push(row)
    }
  }
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const { error } = await db.rpc('upsert_employer_jobs', { p_employer: employer.id, p_rows: rows.slice(i, i + WRITE_CHUNK) })
    if (error) out.errors.push('upsert_employer_jobs')
    else out.stored += Math.min(WRITE_CHUNK, rows.length - i)
  }

  // A board that returns a capped window cannot say a role past the cap is gone: it stamps and counts no misses.
  const windowed = typeof providers[provider].maxJobs === 'number' && clean.length >= (providers[provider].maxJobs as number)
  if (clean.length > 0) {
    const { error } = await db.rpc('record_employer_sightings', { p_employer: employer.id, p_external_ids: clean.map((j) => j.externalId), p_sources: windowed ? [] : sourcesFor(provider), p_close_after: 2 })
    if (error) out.errors.push('record_employer_sightings')
  }
  const { error: statsError } = await db.rpc('bump_employer_stats', { p_employer: employer.id, p_rows: [...stats.values()] })
  if (statsError) out.errors.push('bump_employer_stats')

  await recordRead(db, employer, { ok: true, openCount: clean.length }, deps.verify.now)
  return out
}
