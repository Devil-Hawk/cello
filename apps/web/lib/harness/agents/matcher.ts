// Agent: matcher. Decides which roles to show a person, through lib/scoring.
//
// This file is the one door the background callers use:
//   1. the harness DAG step (the `matcher` AgentFn below, the daily cron),
//   2. the continuous autopilot tick (lib/graph/autopilot.ts calls `scoreJobBatch`),
//   3. the bulk runner (lib/harness/agents/bulk_matcher.ts).
// All of them assess roles the same way (lib/scoring/index.ts#assessJobs): roles
// that break a fact the person stated are filtered with the reason, the rest are
// judged on what the person wants (learned from their own reactions) and on their
// chance against the resume, with every requirement checked on a cited line. Nothing
// here writes a score, and nothing creates an application on its own: a role reaches
// Pipeline when the person taps Interested.
//
// DIAGNOSABILITY: every early exit sets `skippedReason` (+ `candidatesConsidered`)
// on the returned output instead of a silent empty result, so a step that assessed
// nothing is distinguishable from one that had nothing to do.

import type { AgentFn, AdminClient, DecryptedApiKeys, LlmRunner } from '../types'
import { MatcherInput } from '../schemas'
import { MissingKeyError } from '../llm'
import { assessJobs, runDailyShortlist } from '@/lib/scoring'
import type { Chance } from '@/lib/scoring/types'
import { ownedJobsQuery, userCompanyIds } from '@/lib/jobs/owned-query'

// Callers across the app resolve ownership through this module; the helpers live
// in lib/jobs/owned-query so scoring can use them without importing an agent.
export { ownedJobsQuery, userCompanyIds }

/**
 * Hard per-run cap on roles assessed in a single cron tick / harness step. Keeps
 * each tick's LLM spend and wall-clock time bounded. Roles not yet assessed are
 * simply picked up by the next tick, so assessments accumulate across ticks.
 */
const MAX_JOBS_PER_TICK = 25

function collectJobIds(inputIds: string[] | undefined, deps: Record<string, unknown>): string[] {
  const set = new Set<string>(inputIds ?? [])
  for (const out of Object.values(deps)) {
    const ids = (out as { jobIds?: unknown } | null)?.jobIds
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') set.add(id)
  }
  return [...set]
}

export interface CandidateDiagnosis {
  jobId: string
  title: string | null
  /** False when the id does not resolve to a job in one of the person's tracked companies. */
  found: boolean
  /** True when the job's description is empty. Not a failure: the role is still assessed, and its chance reads "not assessed yet". */
  hasDescription: boolean
  /** True when this role will be assessed at all. */
  willAttemptScoring: boolean
  /** Why willAttemptScoring is false. Always set together with false. */
  reason: string | null
}

/**
 * Says, for specific job ids, whether they will be assessed and why not when they
 * will not. Exists for the copilot's score_jobs tool, so a request for three roles
 * that assesses one can explain the other two instead of reporting "2 failed".
 */
export async function diagnoseCandidateJobs(admin: AdminClient, jobIds: string[], userId: string): Promise<CandidateDiagnosis[]> {
  if (jobIds.length === 0) return []
  const { data, error } = await ownedJobsQuery(admin, userId, 'id, title, description, companies!inner(user_id)').in('id', jobIds)
  if (error) console.error('[harness] matcher: diagnose query failed', error)
  const byId = new Map(((data as unknown as { id: string; title: string; description: string | null }[] | null) ?? []).map((r) => [r.id, r]))
  return jobIds.map((jobId) => {
    const row = byId.get(jobId)
    if (!row) {
      return { jobId, title: null, found: false, hasDescription: false, willAttemptScoring: false, reason: "not found among your tracked companies' jobs" }
    }
    return { jobId, title: row.title, found: true, hasDescription: Boolean((row.description ?? '').trim()), willAttemptScoring: true, reason: null }
  })
}

/** One role's outcome from an assessment pass. */
export interface AssessedJobResult {
  jobId: string
  /** The stated facts this role breaks, if any: it was filtered, with these reasons. */
  blocked: string[]
  chance: Chance | null
  /** Probability the person is interested, for ordering. Never shown as a number. */
  want: number | null
  wantReason: string | null
  /** Requirements the resume shows, each with the line that shows it. */
  highlights: string[]
  gaps: string[]
}

export interface ScoreBatchOptions {
  admin: AdminClient
  userId: string
  llm: LlmRunner
  /** Max roles to assess this call. */
  limit: number
  /** Explicit ids to assess instead of the newest unassessed roles. */
  jobIds?: string[]
  /** Lets the taste similarity use an embedding provider; without it that signal is skipped. */
  apiKeys?: DecryptedApiKeys
  signal?: AbortSignal
}

export interface ScoreBatchResult {
  scored: AssessedJobResult[]
  /** Roles that were filtered because they break something the person stated. Counted in `scored` too. */
  blockedCount: number
  failedCount: number
  candidatesConsidered: number
  remaining: number
  skippedReason?: string
}

/** Assesses a batch of roles for one person. The one shared routine behind the matcher step, autopilot and the bulk runner. */
export async function scoreJobBatch(opts: ScoreBatchOptions): Promise<ScoreBatchResult> {
  const none = (skippedReason: string): ScoreBatchResult => ({ scored: [], blockedCount: 0, failedCount: 0, candidatesConsidered: 0, remaining: 0, skippedReason })
  if (opts.signal?.aborted) return none('aborted')
  try {
    const out = await assessJobs({ admin: opts.admin, userId: opts.userId, apiKeys: opts.apiKeys, llm: opts.llm, jobIds: opts.jobIds, limit: opts.limit })
    if (out.skippedReason) return { ...none(out.skippedReason), remaining: out.remaining }
    const scored: AssessedJobResult[] = [...out.fits.values()].map((fit) => ({
      jobId: fit.jobId ?? '',
      blocked: fit.blocked.map((b) => b.text),
      chance: fit.chance?.label ?? null,
      want: fit.want?.p ?? null,
      wantReason: fit.want?.reason ?? null,
      highlights: fit.chance ? fit.chance.checks.filter((c) => c.status === 'met' && c.evidence).slice(0, 4).map((c) => `${c.requirement}: ${c.evidence!.quote}`) : [],
      gaps: fit.chance?.gaps ?? [],
    }))
    return {
      scored,
      blockedCount: out.blocked,
      failedCount: out.failed,
      candidatesConsidered: out.assessed + out.blocked + out.failed,
      remaining: out.remaining,
      skippedReason: out.assessed + out.blocked === 0 && out.failed > 0 ? `all ${out.failed} assessment(s) failed` : undefined,
    }
  } catch (err) {
    if (err instanceof MissingKeyError) return none('no-llm-key')
    throw err
  }
}

export const matcher: AgentFn = async (ctx) => {
  const input = MatcherInput.parse(ctx.input ?? {})
  // Explicit ids from a dependency step win; otherwise the newest roles not yet assessed.
  const explicit = collectJobIds(input.jobIds, ctx.deps)

  const batch = await scoreJobBatch({
    admin: ctx.admin,
    userId: ctx.userId,
    llm: ctx.llm,
    limit: MAX_JOBS_PER_TICK,
    jobIds: explicit.length > 0 ? explicit : undefined,
    apiKeys: ctx.apiKeys,
    signal: ctx.signal,
  })

  // The day's shortlist is picked once, from what was just assessed and what is already known.
  let topJobIds: string[] = []
  if (!batch.skippedReason || batch.skippedReason === 'no-roles') {
    try {
      const run = await runDailyShortlist({ admin: ctx.admin, userId: ctx.userId, apiKeys: ctx.apiKeys, llm: ctx.llm, skipIfBuilt: true })
      topJobIds = run.picks.map((p) => p.jobId)
    } catch (err) {
      if (!(err instanceof MissingKeyError)) throw err
    }
  }

  console.log(
    `[harness] matcher user=${ctx.userId}: considered=${batch.candidatesConsidered} assessed=${batch.scored.length} ` +
      `blocked=${batch.blockedCount} failed=${batch.failedCount}` +
      (batch.skippedReason ? ` skippedReason="${batch.skippedReason}"` : '')
  )

  const matches = batch.scored
    .filter((s) => s.chance !== null && s.want !== null)
    .map((s) => ({ jobId: s.jobId, chance: s.chance!, want: s.want!, highlights: s.highlights, gaps: s.gaps }))
  return {
    output: {
      matches,
      topJobIds,
      skippedReason: batch.skippedReason,
      candidatesConsidered: batch.candidatesConsidered,
    },
    tokensUsed: 0, // already metered per call through ctx.llm
  }
}
