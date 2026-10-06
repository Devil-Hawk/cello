// Agent: bulk_matcher — TWO-TIER job scoring, built to replace one-LLM-call-
// per-job (matcher.ts's scoreJobWithLlm called in a loop) with a design where
// the expensive, invariant part of every call (the resume + scoring rubric)
// is sent ONCE per batch instead of once per job, and only OUTPUT — which
// cannot be shared across jobs — scales with the number of jobs scored.
//
// WHY TWO TIERS, NOT ONE (do not collapse this):
//   TIER 1 (this file, scoreTier1Batch/runTier1) triages up to TIER1_BATCH_SIZE
//   jobs in a single call: system prompt = resume + rubric (cachePrefix:true,
//   so repeat batches in the same run pay the CACHE READ rate, not the full
//   input rate, for that shared prefix); user prompt = a compact job list
//   keyed by batch-local short ids (j1..jN — NEVER the job uuid, which alone
//   would cost ~12 output tokens per job for zero scoring value). Output per
//   job is just {id, score, reason}, so this tier is cheap enough to run
//   against the ENTIRE unscored backlog.
//
//   TIER 2 (runTier2) re-scores only the jobs tier 1 flagged as plausible
//   fits, one call each, via the EXISTING matcher.ts scoreJobWithLlm — the
//   full strengths/gaps/skills/seniorityFit breakdown the UI renders
//   (components/jobs/match-badge.tsx, components/jobs/job-detail-modal.tsx)
//   is only worth paying for on jobs that already cleared the bar.
//
// Every job that gets a tier-1 verdict is persisted immediately (match_score +
// a thin match_details); tier-2 winners get their match_details OVERWRITTEN
// with the full breakdown. A job that never clears tier 1 (LLM never
// returned a usable verdict for it, even after one requeue retry) is left
// unscored (match_score stays NULL) so the NEXT call's candidate pool picks
// it back up — never silently dropped.

import type { AdminClient, LlmRunner, ReasoningEffort } from '../types'
import { REASONING_EFFORTS } from '../types'
import { parseJsonLoose, MissingKeyError, TruncatedResponseError } from '../llm'
import type { Targeting } from '@/lib/targeting'
import { frameJobTextList } from '@/lib/security/job-text'
import {
  scoreJobWithLlm,
  buildMatchDetails,
  selectCandidateJobs,
  toScorable,
  type ScorableJob,
} from './matcher'

/** Jobs per tier-1 triage call. Deliberately small enough that one truncated
 *  response only wastes a bounded slice of work, large enough that the
 *  cached resume+rubric prefix is amortized over many jobs. */
const TIER1_BATCH_SIZE = 60
/** Floor for the truncation-retry split — below this we stop halving and
 *  just report the jobs as unscored-this-round rather than issuing
 *  arbitrarily many tiny calls. */
const TIER1_MIN_BATCH_SIZE = 5
/** Trim each job's description in the TIER-1 list — most jobs have none at
 *  all (median description length is 0), and tier 1 only needs enough text
 *  to triage, not the full posting (that's what tier 2 is for). */
const TIER1_DESC_CHARS = 300
/** Concurrent tier-1 batch calls in flight. Bounded, not unbounded. */
const TIER1_CONCURRENCY = 3
/** Modest reasoning effort for the triage call. Reasoning tokens bill as
 *  OUTPUT, and output is already the binding cost for this workload (it can't
 *  be cached/shared across jobs the way the resume can) — 'low' buys enough
 *  deliberation to separate "solid fit" from "clearly not" across a batch of
 *  dissimilar postings without materially inflating the output bill on every
 *  one of the ~340 batches needed to triage the full backlog. */
const TIER1_DEFAULT_EFFORT: ReasoningEffort = 'low'
/** Mirrors matcher.ts's RESUME_LIMIT (not exported there) — keep in sync if
 *  that constant changes; it exists so a pathological resume can't blow the
 *  cached system-prompt size across every batch. */
const RESUME_LIMIT = 8000

/** Tier-1 score at/above which a job earns the tier-2 deep pass. Below the
 *  matcher's default auto-triage threshold (85) on purpose — tier 1 is a
 *  coarse triage pass, so this catches "worth a closer look" jobs, not just
 *  slam-dunks; the deep pass is what actually decides fine-grained quality. */
const TIER2_SCORE_THRESHOLD = 65
/** Concurrent tier-2 (full scoreJobWithLlm) calls — matches the bound the
 *  previous single-tier implementation of this route used. */
const TIER2_CONCURRENCY = 4

/** Bounded-concurrency DB writes for persisting scores. These are cheap
 *  Supabase updates, not LLM calls, so a higher bound than the LLM tiers is
 *  fine and keeps a large batch's writes from serializing. */
const PERSIST_CONCURRENCY = 10

export interface Tier1Verdict {
  score: number
  reason: string
}

/** Run `fn` over `items` with at most `limit` concurrent in-flight calls.
 *  `shouldStop`, checked before claiming each item, lets a caller halt early
 *  (e.g. on a MissingKeyError, where every remaining call is a guaranteed
 *  repeat failure) without needing to reject the whole Promise.all. */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  shouldStop?: () => boolean
): Promise<void> {
  if (items.length === 0) return
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      if (shouldStop?.()) return
      const i = next++
      if (i >= items.length) return
      await fn(items[i])
    }
  })
  await Promise.all(workers)
}

function buildTier1System(resume: string): string {
  return [
    'You are an expert technical recruiter performing FAST BULK TRIAGE of many job ' +
      'postings against ONE candidate resume.',
    'For EVERY job listed in the user message, output an overall fit score (0-100) and ' +
      'ONE short reason (<=15 words). Be honest and specific. Never invent candidate ' +
      'experience the resume does not support.',
    'Score bands: 0-30 clearly poor fit, 31-64 possible but weak, 65-84 solid fit, ' +
      '85-100 excellent fit.',
    '',
    'CANDIDATE RESUME:',
    resume.slice(0, RESUME_LIMIT),
    '',
    'Respond with ONLY a single JSON object of the exact form:',
    '{"scores":[{"id":"j1","score":73,"reason":"short reason"}, ...]}',
    'Include every job id exactly once, in any order. No markdown fences, no prose ' +
      'outside the JSON object.',
  ].join('\n')
}

/**
 * INJECTION DEFENCE (lib/security/job-text.ts): up to TIER1_BATCH_SIZE
 * EMPLOYER-CONTROLLED descriptions share this one prompt — exactly the shape
 * frameJobTextList exists for: one shared preface instead of repeating it per
 * job (see that function's doc comment for the token-cost reasoning), and
 * scrubbing that stops one hostile posting in the batch closing its own fence
 * or a neighbour's. The compact `[shortId] title @ company (location)` head
 * lines stay OUTSIDE the fence — that metadata is short and not the payload
 * this defends against — and correlate with the fenced blocks by the same
 * shortId.
 */
function buildTier1Prompt(items: { shortId: string; job: ScorableJob }[]): string {
  const heads = items.map(
    ({ shortId, job }) => `[${shortId}] ${job.title} @ ${job.companyName || 'Unknown'} (${job.location ?? 'Unspecified'})`
  )
  const descriptions = frameJobTextList(
    items.map(({ shortId, job }) => ({
      id: shortId,
      text: (job.description ?? '').replace(/\s+/g, ' ').trim().slice(0, TIER1_DESC_CHARS),
    })),
    { label: 'JOB DESCRIPTION' }
  )
  return `Score these ${items.length} jobs:\n${heads.join('\n')}\n\n${descriptions}`
}

interface Tier1RawEntry {
  id?: unknown
  score?: unknown
  reason?: unknown
}
interface Tier1RawBody {
  scores?: unknown
}

/** Parse whatever the model returned, tolerating a malformed or unknown entry
 *  by skipping just that entry — never throws, never discards the batch. */
function parseTier1Response(content: string, validIds: Set<string>): Map<string, Tier1Verdict> {
  const out = new Map<string, Tier1Verdict>()
  let raw: unknown
  try {
    raw = parseJsonLoose<Tier1RawBody | Tier1RawEntry[]>(content)
  } catch {
    return out // unparsable response -> every id in this batch stays "missing"
  }
  const entries: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as Tier1RawBody)?.scores)
      ? ((raw as Tier1RawBody).scores as unknown[])
      : []

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Tier1RawEntry
    const id = typeof e.id === 'string' ? e.id.trim() : ''
    if (!id || !validIds.has(id) || out.has(id)) continue
    const scoreNum = typeof e.score === 'number' ? e.score : Number(e.score)
    if (!Number.isFinite(scoreNum)) continue
    const score = Math.max(0, Math.min(100, Math.round(scoreNum)))
    const reason = typeof e.reason === 'string' ? e.reason.trim().slice(0, 200) : ''
    out.set(id, { score, reason })
  }
  return out
}

interface Tier1CallResult {
  /** jobId -> verdict, for jobs this call (or its recursive splits) scored. */
  verdicts: Map<string, Tier1Verdict>
  /** Jobs that got no verdict this round (bad/absent id, or a whole-call failure). */
  missing: ScorableJob[]
  tokensUsed: number
  calls: number
}

/**
 * Score one batch (<= TIER1_BATCH_SIZE jobs). On TruncatedResponseError,
 * split the batch in half and retry each half recursively, down to
 * TIER1_MIN_BATCH_SIZE. On MissingKeyError, propagate — every remaining call
 * in this run is a guaranteed repeat failure, so the caller should stop
 * issuing new ones rather than burning the rest of the backlog on it. Any
 * other failure marks every job in this batch "missing" (never throws) so a
 * single bad call can't take down the whole run.
 */
async function tier1CallBatch(
  llm: LlmRunner,
  systemPrompt: string,
  jobs: ScorableJob[],
  effort: ReasoningEffort
): Promise<Tier1CallResult> {
  if (jobs.length === 0) return { verdicts: new Map(), missing: [], tokensUsed: 0, calls: 0 }

  const items = jobs.map((job, i) => ({ shortId: `j${i + 1}`, job }))
  // Generous ceiling, not spend: max_tokens only bounds truncation risk, it
  // doesn't cost anything by itself — actual billing follows completion
  // tokens used. ~90 tokens/job covers a compact verdict plus headroom for
  // the reasoning budget sharing the same cap on Anthropic models.
  const maxTokens = Math.min(8000, Math.max(1200, jobs.length * 90 + 900))

  let content: string
  let tokensUsed: number
  try {
    const res = await llm({
      system: systemPrompt,
      prompt: buildTier1Prompt(items),
      json: true,
      maxTokens,
      temperature: 0.1,
      cachePrefix: true,
      reasoning: { effort },
    })
    content = res.content
    tokensUsed = res.tokensUsed
  } catch (err) {
    if (err instanceof TruncatedResponseError && jobs.length > TIER1_MIN_BATCH_SIZE) {
      const mid = Math.ceil(jobs.length / 2)
      const [a, b] = await Promise.all([
        tier1CallBatch(llm, systemPrompt, jobs.slice(0, mid), effort),
        tier1CallBatch(llm, systemPrompt, jobs.slice(mid), effort),
      ])
      return {
        verdicts: new Map([...a.verdicts, ...b.verdicts]),
        missing: [...a.missing, ...b.missing],
        tokensUsed: a.tokensUsed + b.tokensUsed,
        calls: a.calls + b.calls,
      }
    }
    if (err instanceof MissingKeyError) throw err
    console.error(`[bulk_matcher] tier1 batch of ${jobs.length} failed`, err)
    return { verdicts: new Map(), missing: jobs, tokensUsed: 0, calls: 1 }
  }

  const validIds = new Set(items.map((i) => i.shortId))
  const bySid = parseTier1Response(content, validIds)
  const verdicts = new Map<string, Tier1Verdict>()
  const missing: ScorableJob[] = []
  for (const { shortId, job } of items) {
    const v = bySid.get(shortId)
    if (v) verdicts.set(job.id, v)
    else missing.push(job)
  }
  return { verdicts, missing, tokensUsed, calls: 1 }
}

export interface Tier1Result {
  verdicts: Map<string, Tier1Verdict>
  /** Jobs tier 1 never produced a verdict for, even after one requeue retry. */
  failedJobIds: string[]
  tokensUsed: number
  calls: number
  /** True when a MissingKeyError stopped the run early — caller should not
   *  proceed to tier 2 or keep requeuing. */
  missingKey: boolean
}

/**
 * Run tier-1 triage over every job in `jobs`, chunked into TIER1_BATCH_SIZE
 * batches with bounded concurrency, plus ONE requeue round for whatever came
 * back missing (a malformed entry, an id the model silently dropped, or a
 * batch that failed outright) — this is the "tolerate partial responses"
 * robustness requirement: a single bad entry never loses the rest of a batch,
 * and a batch-level hiccup gets one more chance before we give up on it.
 */
export async function runTier1(
  llm: LlmRunner,
  resume: string,
  jobs: ScorableJob[],
  effort: ReasoningEffort
): Promise<Tier1Result> {
  const systemPrompt = buildTier1System(resume)
  const verdicts = new Map<string, Tier1Verdict>()
  let missing: ScorableJob[] = []
  let tokensUsed = 0
  let calls = 0
  let missingKey = false

  const runRound = async (round: ScorableJob[]) => {
    const chunks: ScorableJob[][] = []
    for (let i = 0; i < round.length; i += TIER1_BATCH_SIZE) chunks.push(round.slice(i, i + TIER1_BATCH_SIZE))
    const roundMissing: ScorableJob[] = []
    await runWithConcurrency(
      chunks,
      TIER1_CONCURRENCY,
      async (chunk) => {
        try {
          const r = await tier1CallBatch(llm, systemPrompt, chunk, effort)
          for (const [id, v] of r.verdicts) verdicts.set(id, v)
          roundMissing.push(...r.missing)
          tokensUsed += r.tokensUsed
          calls += r.calls
        } catch (err) {
          if (err instanceof MissingKeyError) {
            missingKey = true
            roundMissing.push(...chunk)
            return
          }
          throw err
        }
      },
      () => missingKey
    )
    return roundMissing
  }

  missing = await runRound(jobs)
  if (!missingKey && missing.length > 0) {
    missing = await runRound(missing)
  }

  return { verdicts, failedJobIds: missing.map((j) => j.id), tokensUsed, calls, missingKey }
}

export interface Tier2Result {
  matchDetailsByJobId: Map<string, { score: number; matchDetails: Record<string, unknown> }>
  failedJobIds: string[]
  tokensUsed: number
  missingKey: boolean
}

/** Full deep-pass scoring for the jobs tier 1 flagged as worth a closer
 *  look — reuses matcher.ts's scoreJobWithLlm + buildMatchDetails verbatim so
 *  the persisted shape is byte-identical to every other caller of that
 *  function (the UI's match-badge/job-detail-modal, autopilot, the on-demand
 *  single-job route). */
export async function runTier2(
  llm: LlmRunner,
  resume: string,
  jobs: ScorableJob[],
  admin: AdminClient,
  userId: string
): Promise<Tier2Result> {
  const matchDetailsByJobId = new Map<string, { score: number; matchDetails: Record<string, unknown> }>()
  const failedJobIds: string[] = []
  let tokensUsed = 0
  let missingKey = false

  await runWithConcurrency(
    jobs,
    TIER2_CONCURRENCY,
    async (job) => {
      try {
        const { verdict, tokensUsed: used } = await scoreJobWithLlm(llm, resume, job, admin, userId)
        tokensUsed += used
        matchDetailsByJobId.set(job.id, {
          score: verdict.score,
          // Additive `tier: 2` marker only — every key the UI reads
          // (highlights, gaps, skills.matched/missing, overallScore/score)
          // comes straight out of buildMatchDetails unmodified.
          matchDetails: { ...buildMatchDetails(verdict), tier: 2 },
        })
      } catch (err) {
        failedJobIds.push(job.id)
        if (err instanceof MissingKeyError) {
          missingKey = true
        } else {
          console.error(`[bulk_matcher] tier2 scoring failed for job ${job.id}`, err)
        }
      }
    },
    () => missingKey
  )

  return { matchDetailsByJobId, failedJobIds, tokensUsed, missingKey }
}

interface ScoreUpdate {
  jobId: string
  score: number
  matchDetails: Record<string, unknown>
}

async function persistScores(admin: AdminClient, updates: ScoreUpdate[]): Promise<void> {
  await runWithConcurrency(updates, PERSIST_CONCURRENCY, async (u) => {
    const { error } = await admin
      .from('jobs')
      .update({ match_score: u.score, match_details: u.matchDetails })
      .eq('id', u.jobId)
    if (error) console.error(`[bulk_matcher] persist failed for job ${u.jobId}`, error)
  })
}

function buildTier1MatchDetails(v: Tier1Verdict): Record<string, unknown> {
  return {
    overallScore: v.score,
    score: v.score,
    highlights: [],
    strengths: [],
    gaps: [],
    seniorityFit: '',
    summary: v.reason,
    skills: { matched: [], missing: [] },
    matchedAt: new Date().toISOString(),
    source: 'harness/bulk_matcher:tier1',
    tier: 1,
  }
}

/** Wrap an LlmRunner so every call defaults to `model` unless the call site
 *  already specified one. Lets a single request-level model override apply to
 *  both tiers without touching scoreJobWithLlm's signature (shared with
 *  autopilot.ts and the on-demand single-job route — not this file's to
 *  change). */
function withModel(llm: LlmRunner, model: string | undefined): LlmRunner {
  if (!model) return llm
  return (opts) => llm({ ...opts, model: opts.model ?? model })
}

export interface BulkMatchOptions {
  admin: AdminClient
  userId: string
  companyIds: string[]
  resume: string
  targeting: Targeting
  llm: LlmRunner
  /** Max candidates to consider this call (post quality+targeting filter). */
  limit: number
  /** Overrides the account's default model for both tiers when set. */
  model?: string
  /** Tier-1 reasoning effort override; defaults to TIER1_DEFAULT_EFFORT. */
  effort?: ReasoningEffort
  /** Explicit ids to score instead of the default unscored pool. */
  jobIds?: string[]
  /**
   * The titles the user configured (lib/targeting/titles.ts).
   *
   * ORDERS the candidate pool so metered scoring is spent on the most on-target
   * jobs first; it never excludes anything. Without it the pool is simply the
   * newest unscored rows, which in a corpus where 92.8% of titles match no
   * target means paying to rate roles the user will never apply to.
   */
  targetTitles?: readonly string[]
}

export interface JobScoreOutcome {
  jobId: string
  status: 'scored' | 'no-verdict'
  /** Which tier produced the PERSISTED score — 1 (triage only), 2 (triage +
   *  deep pass), or null when status is 'no-verdict'. A tier-2 candidate whose
   *  deep pass itself failed still shows tier 1 here: tier 1's score was
   *  already persisted and stands, it just didn't get upgraded. */
  tier: 1 | 2 | null
  score: number | null
  /** Always a concrete explanation — see bulk_matcher's own comment above on
   *  why this file exists never to return a bare "failed". */
  reason: string
  /** True when this job had no/blank description on file — it was still
   *  scored from the title alone (never silently skipped for this reason),
   *  just at lower confidence, which `reason` calls out explicitly. */
  titleOnly: boolean
}

export interface BulkMatchResult {
  /** Jobs that got at least a tier-1 score persisted. */
  scored: number
  /** Candidates that never got a usable verdict at all. */
  failed: number
  candidatesConsidered: number
  skippedReasons: Record<string, number>
  /** Number of tier-1 LLM calls issued (including truncation-retry splits). */
  batches: number
  tokensUsed: number
  /** Per-job breakdown for every candidate that was actually attempted (i.e.
   *  survived selectCandidateJobs — see matcher.ts's diagnoseCandidateJobs for
   *  candidates that were excluded BEFORE reaching here at all, which this
   *  array cannot know about). Empty for the early-exit paths below (no
   *  candidates were ever selected to attempt). */
  jobOutcomes: JobScoreOutcome[]
}

/**
 * Select candidates (via matcher.ts's selectCandidateJobs — same
 * ownership/quality/targeting prefilter every other caller uses), triage them
 * all with tier 1, persist those scores, then run tier 2 on whatever cleared
 * TIER2_SCORE_THRESHOLD and persist the full match_details for those winners.
 */
export async function runBulkMatch(opts: BulkMatchOptions): Promise<BulkMatchResult> {
  if (!opts.resume.trim()) {
    return { scored: 0, failed: 0, candidatesConsidered: 0, skippedReasons: { 'no-resume': 1 }, batches: 0, tokensUsed: 0, jobOutcomes: [] }
  }
  if (opts.companyIds.length === 0) {
    return { scored: 0, failed: 0, candidatesConsidered: 0, skippedReasons: { 'no-companies': 1 }, batches: 0, tokensUsed: 0, jobOutcomes: [] }
  }

  const { jobs, candidatesConsidered } = await selectCandidateJobs(
    opts.admin,
    opts.userId,
    opts.targeting,
    opts.limit,
    opts.jobIds,
    // Orders the pool so metered scoring is spent on the jobs most likely to
    // match, instead of simply the most recently posted. See
    // lib/jobs/target-relevance.ts — it is an ordering, never a filter.
    opts.targetTitles ?? []
  )
  if (jobs.length === 0) {
    const reason = candidatesConsidered > 0 ? 'no-candidates-after-targeting-filter' : 'no-candidates'
    return { scored: 0, failed: 0, candidatesConsidered, skippedReasons: { [reason]: 1 }, batches: 0, tokensUsed: 0, jobOutcomes: [] }
  }

  const scorable = jobs.map(toScorable)
  const isTitleOnly = (job: ScorableJob) => !(job.description ?? '').trim()
  const effort: ReasoningEffort =
    opts.effort && (REASONING_EFFORTS as readonly string[]).includes(opts.effort) ? opts.effort : TIER1_DEFAULT_EFFORT
  const llm = withModel(opts.llm, opts.model)

  const tier1 = await runTier1(llm, opts.resume, scorable, effort)
  if (tier1.missingKey) {
    return {
      scored: 0,
      failed: jobs.length,
      candidatesConsidered,
      skippedReasons: { 'no-llm-key': 1 },
      batches: tier1.calls,
      tokensUsed: tier1.tokensUsed,
      jobOutcomes: scorable.map((job) => ({
        jobId: job.id,
        status: 'no-verdict',
        tier: null,
        score: null,
        reason: 'no OpenRouter key configured for this account',
        titleOnly: isTitleOnly(job),
      })),
    }
  }

  const skippedReasons: Record<string, number> = {}
  const bump = (reason: string, n: number) => {
    if (n > 0) skippedReasons[reason] = (skippedReasons[reason] ?? 0) + n
  }

  await persistScores(
    opts.admin,
    [...tier1.verdicts.entries()].map(([jobId, v]) => ({ jobId, score: v.score, matchDetails: buildTier1MatchDetails(v) }))
  )
  bump('tier1-no-verdict', tier1.failedJobIds.length)

  const winners = scorable.filter((j) => (tier1.verdicts.get(j.id)?.score ?? -1) >= TIER2_SCORE_THRESHOLD)
  let tier2TokensUsed = 0
  let tier2: Tier2Result | null = null
  if (winners.length > 0) {
    tier2 = await runTier2(llm, opts.resume, winners, opts.admin, opts.userId)
    tier2TokensUsed = tier2.tokensUsed
    bump('tier2-scoring-failed', tier2.failedJobIds.length)
    if (tier2.missingKey) bump('no-llm-key', 1)
    await persistScores(
      opts.admin,
      [...tier2.matchDetailsByJobId.entries()].map(([jobId, r]) => ({ jobId, score: r.score, matchDetails: r.matchDetails }))
    )
  }

  const scored = tier1.verdicts.size
  const failed = jobs.length - scored
  const jobOutcomes: JobScoreOutcome[] = scorable.map((job) => {
    const titleOnly = isTitleOnly(job)
    const t1 = tier1.verdicts.get(job.id)
    if (!t1) {
      return {
        jobId: job.id,
        status: 'no-verdict',
        tier: null,
        score: null,
        reason:
          'the model did not return a usable verdict for this job, even after one retry — it stays ' +
          'unscored (never silently dropped) and the next score_jobs call will pick it back up automatically',
        titleOnly,
      }
    }
    const t2 = tier2?.matchDetailsByJobId.get(job.id)
    if (t2) {
      return { jobId: job.id, status: 'scored', tier: 2, score: t2.score, reason: t1.reason, titleOnly }
    }
    return {
      jobId: job.id,
      status: 'scored',
      tier: 1,
      score: t1.score,
      reason: titleOnly
        ? `${t1.reason} (scored from the title only — this posting has no description on file, so treat the score as lower-confidence)`
        : t1.reason,
      titleOnly,
    }
  })

  return {
    scored,
    failed,
    candidatesConsidered,
    skippedReasons,
    batches: tier1.calls,
    tokensUsed: tier1.tokensUsed + tier2TokensUsed,
    jobOutcomes,
  }
}
