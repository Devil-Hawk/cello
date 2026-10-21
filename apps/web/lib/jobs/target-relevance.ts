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
import type { Targeting } from '../targeting'
import { hasAnyConstraint, type StatedConstraints } from '../scoring/constraints'

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

// --- What a person has stated (the judge itself is lib/roles/keep.ts) -------------------------------
//
// Role types (lib/jobs/role-types) decide the kind of role once the owner turns role_types_live on
// (`typeStep.live`): the person's own word for the title first, else the posting's type, kept only when it
// is one they chose. A role whose type no tier could tell is kept hidden when its title shares a word with
// a chosen type's label or synonym, and counted otherwise.

/** What the type step needs to know about a person (K5c). */
export interface TypeStep {
  /** The role types the person chose (at most 8). */
  chosen: readonly string[]
  /** The person's own word for a normalised title (role_type_synonyms). */
  synonyms: Readonly<Record<string, string>>
  /** The words of the chosen types' labels and synonyms, for a title no tier could type. */
  words: ReadonlySet<string>
  /** role_types_live: the type step decides in place of the title score. Off: it is only counted beside the old filter. */
  live: boolean
}

export interface PersonTargets {
  targeting: Targeting
  /** The role titles the person typed, most specific first. */
  titles: readonly string[]
  typeStep?: TypeStep
  /** The dealbreakers (profiles.preferences.constraints). Absent when none are stated. */
  constraints?: StatedConstraints
}

/** The role's type in the person's eyes, and what that means for keeping it. */
export function typeVerdict(role: { title_norm?: string | null; role_type?: string | null }, step: TypeStep): 'keep' | 'other' | 'unknown' | 'near' {
  const type = (role.title_norm ? step.synonyms[role.title_norm] : undefined) ?? role.role_type
  if (type) return step.chosen.includes(type) ? 'keep' : 'other'
  const shares = (role.title_norm ?? '').split(' ').some((w) => w.length > 2 && step.words.has(w))
  return shares ? 'near' : 'unknown'
}

/** The person has stated something a role can be judged on. With nothing stated, nothing is filtered. */
export function hasPersonTargets(t: PersonTargets): boolean {
  const g = t.targeting
  const set =
    g.functions.length > 0 || g.seniority.length > 0 || g.countries.length > 0 || g.remoteOnly || g.languages.length > 0 || g.excludedCompanies.length > 0 || g.excludedKeywords.length > 0
  return set || (t.constraints ? hasAnyConstraint(t.constraints) : false) || t.titles.some((x) => x.trim().length > 0) || (t.typeStep?.chosen.length ?? 0) > 0
}
