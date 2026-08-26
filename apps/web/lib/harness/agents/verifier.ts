// Agent: verifier — adversarial checks on freshly-sourced jobs before they are
// trusted enough to trigger auto-triage / application drafting.
//
// Three checks per job:
//   1. Liveness   — the job URL still resolves (HTTP < 400).
//   2. Consistency — the job has a non-empty title and a resolvable company.
//   3. Dedupe     — no colliding row (same external_id/url) for the same company.
//
// A job that fails any check is knocked out: jobs.is_new=false, so the matcher
// step (which only triages is_new jobs) skips it. Verdict is aggregated into the
// VerifierOutput contract ({ verified, issues }); per-job reasons are the issues.
//
// Runs framework-free (global fetch/URL only) so it behaves the same in the
// route and CI contexts. Never throws for a per-job problem — it records it.

import type { AgentFn, AdminClient } from '../types'
import { VerifierInput } from '../schemas'
import { ownedJobsQuery } from './matcher'

/** Cap jobs checked per run. */
const MAX_JOBS = 30
const LIVENESS_TIMEOUT_MS = 8000

interface JobRow {
  id: string
  company_id: string
  title: string | null
  url: string | null
  external_id: string | null
  companies?: { name: string | null } | { name: string | null }[] | null
}

function companyName(job: JobRow): string {
  const c = job.companies
  if (Array.isArray(c)) return c[0]?.name ?? ''
  return c?.name ?? ''
}

async function userCompanyIds(admin: AdminClient, userId: string): Promise<string[]> {
  const { data } = await admin.from('companies').select('id').eq('user_id', userId)
  return ((data as { id: string }[] | null) ?? []).map((r) => r.id)
}

function collectJobIds(inputIds: string[] | undefined, deps: Record<string, unknown>): string[] {
  const set = new Set<string>(inputIds ?? [])
  for (const out of Object.values(deps)) {
    const ids = (out as { jobIds?: unknown } | null)?.jobIds
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') set.add(id)
  }
  return [...set]
}

/** URL liveness — accept 2xx/3xx, treat >=400 and network errors as dead. */
async function isLive(url: string, signal?: AbortSignal): Promise<boolean> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), LIVENESS_TIMEOUT_MS)
  const onAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onAbort)
  try {
    // Some ATS boards reject HEAD; use GET but don't read the body.
    const res = await fetch(parsed.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': 'CelloVerifier/1.0' },
    })
    return res.status < 400
  } catch {
    return false
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

export const verifier: AgentFn = async (ctx) => {
  // Input is not schema-enforced by the executor; accept jobIds (this agent's
  // real contract) OR a draftId (the declared VerifierInput) without throwing.
  const raw = (ctx.input ?? {}) as { jobIds?: unknown; draftId?: unknown }
  const inputIds = Array.isArray(raw.jobIds)
    ? raw.jobIds.filter((x): x is string => typeof x === 'string')
    : undefined
  void VerifierInput // declared contract; verifier operates on jobs, kept for reference

  const jobIds = collectJobIds(inputIds, ctx.deps)

  const companyIds = await userCompanyIds(ctx.admin, ctx.userId)
  if (companyIds.length === 0) {
    return { output: { verified: true, issues: [] }, tokensUsed: 0 }
  }

  // Ownership scoped via the companies FK join (see ownedJobsQuery), not an
  // .in('company_id', companyIds) array — that breaks past ~600 companies.
  const SELECT_COLUMNS = 'id, company_id, title, url, external_id, companies!inner(name)'
  let jobs: JobRow[]
  if (jobIds.length > 0) {
    const { data } = await ownedJobsQuery(ctx.admin, ctx.userId, SELECT_COLUMNS).in(
      'id',
      jobIds.slice(0, MAX_JOBS)
    )
    jobs = (data as JobRow[] | null) ?? []
  } else {
    const { data } = await ownedJobsQuery(ctx.admin, ctx.userId, SELECT_COLUMNS)
      .eq('is_new', true)
      .order('discovered_at', { ascending: false })
      .limit(MAX_JOBS)
    jobs = (data as JobRow[] | null) ?? []
  }

  if (jobs.length === 0) {
    return { output: { verified: true, issues: [] }, tokensUsed: 0 }
  }

  const issues: string[] = []
  const knockouts: string[] = []

  // Detect dedupe collisions within this batch (same company + same external_id/url).
  const seen = new Map<string, string>() // key -> first jobId

  for (const job of jobs) {
    if (ctx.signal.aborted) break
    const reasons: string[] = []

    // 2) Consistency
    if (!job.title || job.title.trim().length === 0) reasons.push('missing job title')
    if (!companyName(job)) reasons.push('unresolved company')

    // 3) Dedupe collision
    const dedupeKey = `${job.company_id}::${(job.external_id || job.url || '').toLowerCase()}`
    if (job.external_id || job.url) {
      const prior = seen.get(dedupeKey)
      if (prior && prior !== job.id) {
        reasons.push(`duplicate of job ${prior} (same external_id/url)`)
      } else {
        seen.set(dedupeKey, job.id)
      }
      // Cross-check the DB for an older colliding row from a different job id.
      const orFilter = [
        job.external_id ? `external_id.eq.${job.external_id}` : null,
        job.url ? `url.eq.${job.url}` : null,
      ]
        .filter(Boolean)
        .join(',')
      if (orFilter) {
        const { data: collisions } = await ctx.admin
          .from('jobs')
          .select('id')
          .eq('company_id', job.company_id)
          .or(orFilter)
          .neq('id', job.id)
          .limit(1)
        if (((collisions as { id: string }[] | null) ?? []).length > 0) {
          reasons.push('duplicate row exists for this company')
        }
      }
    }

    // 1) Liveness
    if (!job.url) {
      reasons.push('missing job URL')
    } else if (!(await isLive(job.url, ctx.signal))) {
      reasons.push('job URL no longer reachable (>=400 or unreachable)')
    }

    if (reasons.length > 0) {
      knockouts.push(job.id)
      issues.push(`${job.id}: ${reasons.join('; ')}`)
    }
  }

  // Knock out failed jobs so the matcher skips triage for them.
  if (knockouts.length > 0) {
    await ctx.admin.from('jobs').update({ is_new: false }).in('id', knockouts)
  }

  return { output: { verified: knockouts.length === 0, issues }, tokensUsed: 0 }
}
