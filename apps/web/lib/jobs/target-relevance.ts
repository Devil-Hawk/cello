// Should this job be ingested at all?
//
// WHY THIS EXISTS — MEASURED, NOT SUSPECTED
//   The two ingest paths in this codebase do not agree about relevance.
//
//     lib/sources/*  (the 12 job-board adapters) DOES filter: queryAllSources
//                    runs sanitizeLeads(merged, query.targeting) and then
//                    rankAndLimit(...) before anything is written.
//     lib/ats/*      (Greenhouse/Lever/Ashby boards for watched companies)
//                    DOES NOT. refreshCompany drops only rejectReason and
//                    isLowQuality rows, so EVERY role a watched company posts
//                    is stored — sales, legal, finance, support, the lot.
//
//   The result, counted against the live table: 35,109 jobs, of which 2,517
//   (7.2%) even mention AI/ML/GenAI/LLM in the title for a user whose targets
//   are AI engineering roles. Sales alone contributes 4,653; operations 4,170;
//   marketing, finance, support, HR and legal another 3,670 between them. More
//   than 12,500 rows sit in functions this user will never apply to.
//
//   The cost is not just a noisy list. Scoring is metered per job, so an
//   unfiltered corpus is a standing bill: draining that backlog would mean
//   paying to rate ~32,000 roles the user does not want. Only 311 rows (0.9%)
//   have been scored so far, which is the only reason this has not already been
//   expensive.
//
// THE RULE THIS ENCODES
//   Filter at INGEST on the one signal that is free and deterministic — the
//   title, against the titles the user actually configured. Rating stays a
//   later, metered step, exactly as the user put it: "rating can be done later
//   but the job search must be related to the roles we're targeting."
//
// WHY IT DEFAULTS TO KEEPING EVERYTHING
//   A user who has configured no target titles must see no change. Silently
//   discarding their jobs because a preference is empty would be a far worse
//   bug than an over-full list, and it would be invisible — the rows simply
//   never arrive. So: no targets configured means no filtering, and every
//   refusal below carries a reason the caller can log.

import { scoreTitleAgainstTargets, parseTitle, type ParsedTitle } from '../matching/title-rank'

/**
 * Minimum title score (1-100 from scoreTitleAgainstTargets) for a job to be
 * ingested when the user HAS configured target titles.
 *
 * Deliberately permissive. The scorer already returns 0 for "matched nothing",
 * so this threshold only decides how weak a partial match may be. It is set low
 * because the asymmetry is stark: a discarded job is one the user never learns
 * existed, while a kept-but-marginal job costs one row and is sorted to the
 * bottom by the same score. Ranking handles the marginal case; this gate exists
 * to remove the 92.8% that matches nothing at all.
 */
export const MIN_INGEST_TITLE_SCORE = 15

/**
 * Job functions that are never discarded on a weak title match.
 *
 * A target of "AI Engineer" will not textually match "Member of Technical
 * Staff", "Forward Deployed Engineer" or "Research Scientist", and those are
 * exactly the roles this user wants. Function is the coarser, more forgiving
 * signal, so a job in an adjacent technical function survives a weak title
 * match and is left for the scorer to judge properly.
 *
 * This is the deliberate leak in the gate: it is better to keep a hundred
 * unranked engineering roles than to drop the one titled unconventionally.
 */
const ALWAYS_CONSIDER_FUNCTIONS = new Set(['engineering', 'data'])

export interface RelevanceInput {
  title: string | null | undefined
  /** From lib/jobs/classify.ts, when the caller has already classified. */
  jobFunction?: string | null
}

export interface RelevanceDecision {
  keep: boolean
  /** 0-100 title match, or 0 when nothing matched / no targets configured. */
  score: number
  /** The configured target that matched, for display and for logging. */
  matchedTarget: string | null
  /** Why this decision was made, in words. Never empty. */
  reason: string
}

/**
 * Pre-parse the user's targets once, for callers filtering a whole batch.
 * parseTitle is not free and an ATS refresh runs it against every posting on a
 * board; parsing 12 targets once per company rather than once per job matters
 * when a company posts 200 roles.
 */
export function prepareTargets(targetTitles: readonly string[]): ParsedTitle[] {
  return targetTitles.map((t) => parseTitle(t)).filter((p) => p.coreCount > 0)
}

/**
 * Decide whether a job belongs in this user's workspace at all.
 *
 * `targets` may be raw strings or the output of prepareTargets().
 */
export function assessTargetRelevance(
  job: RelevanceInput,
  targets: readonly (string | ParsedTitle)[]
): RelevanceDecision {
  // No configured targets => no opinion. Keep everything, exactly as before.
  if (!targets || targets.length === 0) {
    return {
      keep: true,
      score: 0,
      matchedTarget: null,
      reason: 'no target titles configured, so nothing is filtered',
    }
  }

  const match = scoreTitleAgainstTargets(job.title, targets)

  if (match.score >= MIN_INGEST_TITLE_SCORE) {
    return {
      keep: true,
      score: match.score,
      matchedTarget: match.target,
      reason: `title matches "${match.target}" (${match.score}/100)`,
    }
  }

  const fn = (job.jobFunction || '').toLowerCase()
  if (ALWAYS_CONSIDER_FUNCTIONS.has(fn)) {
    return {
      keep: true,
      score: match.score,
      matchedTarget: match.target,
      // Said plainly, because this is the branch that keeps the corpus honest:
      // an unconventional title in the right function is not noise.
      reason: `weak title match but in the ${fn} function, so kept for scoring`,
    }
  }

  return {
    keep: false,
    score: match.score,
    matchedTarget: null,
    reason: fn
      ? `title matches no target title, and ${fn} is not a function you target`
      : 'title matches no target title',
  }
}

/**
 * Reorder a candidate pool so the most on-target jobs come first.
 *
 * WHY SCORING ORDER IS A MONEY DECISION
 *   The batch scorer picks its candidates with SQL facet filters and then
 *   `.order('posted_at', desc).limit(n)` — newest first. Title relevance never
 *   enters into it. With 92.8% of this corpus off-target and `job_function =
 *   engineering` still matching 12,924 rows, "newest" mostly means whichever
 *   unrelated role a watched company happened to post this morning. Every one
 *   of those costs a metered LLM call, which is why the user described the
 *   button as scoring "randomly 25 jobs which you might be bad for".
 *
 *   Title matching is free and deterministic, so it is the obvious thing to
 *   spend BEFORE spending money: rank the already-fetched pool, then let the
 *   scorer pay for the top of it.
 *
 * STABLE, AND A NO-OP WHEN UNCONFIGURED. Jobs with equal title scores keep
 * their incoming order, so the freshest-first contract still holds within a
 * relevance band — and with no target titles configured the input is returned
 * untouched, so an unconfigured user sees exactly the previous behaviour.
 */
export function prioritiseByTargetTitles<T extends RelevanceInput>(
  jobs: readonly T[],
  targetTitles: readonly string[]
): T[] {
  const targets = prepareTargets(targetTitles)
  if (targets.length === 0) return [...jobs]

  return jobs
    .map((job, index) => ({
      job,
      index,
      score: scoreTitleAgainstTargets(job.title, targets).score,
    }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .map((entry) => entry.job)
}

export interface FilterSummary<T> {
  kept: T[]
  /** How many were dropped, and why — for logging and for telling the user. */
  dropped: number
  droppedReasons: Record<string, number>
}

/**
 * Filter a batch, returning both the survivors and a countable account of what
 * was removed.
 *
 * The summary is not decoration. A silent filter is indistinguishable from a
 * broken scraper — "the refresh found nothing" reads the same either way — so
 * every caller gets the numbers it needs to say which one happened.
 */
export function filterToTargets<T extends RelevanceInput>(
  jobs: readonly T[],
  targetTitles: readonly string[]
): FilterSummary<T> {
  const targets = prepareTargets(targetTitles)
  const kept: T[] = []
  const droppedReasons: Record<string, number> = {}

  for (const job of jobs) {
    const decision = assessTargetRelevance(job, targets)
    if (decision.keep) {
      kept.push(job)
    } else {
      droppedReasons[decision.reason] = (droppedReasons[decision.reason] ?? 0) + 1
    }
  }

  return { kept, dropped: jobs.length - kept.length, droppedReasons }
}
