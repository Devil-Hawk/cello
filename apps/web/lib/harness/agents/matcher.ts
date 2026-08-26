// Agent: matcher — score jobs against the user's resume and produce rich,
// jobright-style MATCH EXPLANATIONS.
//
// This file is the SINGLE scoring code path shared by three callers:
//   1. the harness DAG step (the `matcher` AgentFn below — cron daily digest
//      and any planner-built run),
//   2. the continuous autopilot tick (lib/graph/autopilot.ts imports
//      `scoreJobBatch` directly),
//   3. on-demand single-job scoring (app/api/agents/match/route.ts imports
//      `scoreJobWithLlm` + `buildMatchDetails` directly).
// Centralizing candidate selection + scoring here means autopilot and the cron
// digest can never double-score or diverge in match quality — both filter
// `match_score is null` at the DB level, so whichever tick gets to a job first
// claims it, and both write the identical match_details shape.
//
// For each target job we ask the runtime LLM (ctx.llm — tokens are metered) for
// a structured verdict: { score 0-100, skills/experience/location sub-scores,
// strengths[], gaps[], seniorityFit, summary }. We persist that to
// jobs.match_score + jobs.match_details (a superset shape the UI's
// components/jobs/match-badge.tsx already understands), then AUTO-TRIAGE: any
// job scoring >= the user's threshold (profiles.preferences.matchThreshold,
// default 85) that is still `is_new` and has no existing application gets an
// application row at stage 'discovered'. Output satisfies MatcherOutput.
//
// DIAGNOSABILITY: every early exit sets `skippedReason` (+ `candidatesConsidered`)
// on the returned output instead of the old silent `{matches:[],topJobIds:[]}`.
// Root cause of the historical "0 of 18,626 jobs scored" no-op (confirmed by
// direct reproduction against prod): matcher's own candidate-selection logic
// was always correct — the daily runs journaled empty results because every
// per-job LLM call failed (an absent/invalid OpenRouter key, or a transient
// upstream error) and the old code caught-and-continued silently, so a step
// where 100% of attempts failed was indistinguishable from "nothing to score".
// scoreJobBatch now tracks failures and surfaces them via skippedReason.

import type { AgentFn, AdminClient, LlmRunner } from '../types'
import { MatcherInput } from '../schemas'
import { parseJsonLoose, MissingKeyError, TruncatedResponseError } from '../llm'
import { resolveTargeting, type Targeting } from '@/lib/targeting'
import { QUALITY_REJECT_THRESHOLD } from '@/lib/jobs/classify'
import { prioritiseByTargetTitles } from '@/lib/jobs/target-relevance'
import { frameJobText } from '@/lib/security/job-text'
import { buildMatchContext } from '@/lib/context/assemble'
import { checkMatchVerdictDeterministic, needsJudgeSample } from '@/lib/graph/verify/matcher'
import { judgeMatchQuality, meteredJudgeClient } from '@/lib/evals/judge'
import { writeVerdict } from '@/lib/evals/verdicts'
import { BudgetCapError } from '@/lib/harness/spend'
import { logHarnessError } from '@/lib/observability/log'
import type { DecryptedApiKeys } from '../types'

const DEFAULT_THRESHOLD = 85

/**
 * Hard per-run cap on jobs scored in a single cron tick / harness step. Keeps
 * each tick's LLM spend and wall-clock time bounded. Unscored jobs are simply
 * picked up by the NEXT tick — every candidate query here filters
 * `match_score is null`, so scores accumulate across ticks instead of one run
 * trying to burn through all ~18k jobs (and blow the serverless deadline) at
 * once. Both the harness cron step and lib/graph/autopilot.ts pass their own
 * limit into scoreJobBatch(); this is just the harness step's default.
 */
const MAX_JOBS_PER_TICK = 25

/** How large a pool to pull before the JS-side targeting/quality filter, per requested `limit`. */
const POOL_MULTIPLIER = 8
const MAX_POOL = 400

/** Trim job descriptions before sending to the model. */
const DESC_LIMIT = 4000
const RESUME_LIMIT = 8000

interface JobRow {
  id: string
  company_id: string
  title: string
  description: string | null
  location: string | null
  url: string | null
  is_new: boolean | null
  match_score: number | null
  posted_at: string | null
  job_function: string | null
  seniority: string | null
  language: string | null
  country: string | null
  is_remote: boolean | null
  quality_score: number | null
  companies?: { name: string | null } | { name: string | null }[] | null
}

export interface LlmVerdict {
  score: number
  skillsMatch: number
  experienceMatch: number
  locationMatch: number
  strengths: string[]
  gaps: string[]
  seniorityFit: string
  summary: string
  matchedSkills: string[]
  missingSkills: string[]
}

/** Minimal job shape scoreJobWithLlm needs — callers map their own row shape into this. */
export interface ScorableJob {
  id: string
  title: string
  description: string | null
  location: string | null
  companyName?: string | null
  /** Feeds buildMatchContext (lib/context/assemble.ts) — optional so a caller
   *  scoring a job with no resolved company yet just gets no extra context,
   *  never a throw. */
  companyId?: string | null
}

function clampPct(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0
  return Math.max(0, Math.min(100, Math.round(v)))
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((s) => s.trim())
}

function companyName(job: JobRow): string {
  const c = job.companies
  if (Array.isArray(c)) return c[0]?.name ?? ''
  return c?.name ?? ''
}

/** Exported so callers scoring jobs outside scoreJobBatch (e.g. the batch match
 *  route's own bounded-concurrency loop) can build the same ScorableJob shape
 *  scoreJobWithLlm expects, instead of re-deriving companyName themselves. */
export function toScorable(job: JobRow): ScorableJob {
  return {
    id: job.id,
    title: job.title,
    description: job.description,
    location: job.location,
    companyName: companyName(job),
    companyId: job.company_id,
  }
}

/**
 * Company ids owned by the user (jobs have no user_id — ownership is via
 * companies). Exported so other server-side callers that need the same
 * ownership resolution (e.g. the batch match route) don't reimplement it.
 */
export async function userCompanyIds(admin: AdminClient, userId: string): Promise<string[]> {
  const { data, error } = await admin.from('companies').select('id').eq('user_id', userId)
  if (error) console.error('[harness] matcher: userCompanyIds query failed', error)
  return ((data as { id: string }[] | null) ?? []).map((r) => r.id)
}

/**
 * A `jobs` query scoped to userId's own companies through the FK join
 * instead of an `.in('company_id', companyIds)` querystring array — which
 * broke every load once an account passed ~600 companies (the array crossed
 * the request URL length limit). Ownership semantics are identical: RLS
 * itself scopes jobs the same way (EXISTS companies.id = jobs.company_id AND
 * companies.user_id = auth.uid()), this just does it server-side against an
 * admin client that bypasses RLS.
 *
 * `columns` must embed the join as `companies!inner(...)` (any fields) —
 * `!inner` is what turns the embed into a row-restricting join; without it
 * the `.eq('companies.user_id', ...)` filter has nothing to attach to.
 */
export function ownedJobsQuery(admin: AdminClient, userId: string, columns: string, opts?: { count?: 'exact'; head?: boolean }) {
  return admin.from('jobs').select(columns, opts).eq('companies.user_id', userId)
}

/** Collect jobIds from static input and any dependency step output carrying jobIds. */
function collectJobIds(inputIds: string[] | undefined, deps: Record<string, unknown>): string[] {
  const set = new Set<string>(inputIds ?? [])
  for (const out of Object.values(deps)) {
    const ids = (out as { jobIds?: unknown } | null)?.jobIds
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') set.add(id)
  }
  return [...set]
}

/**
 * Score a single job with the LLM. Exported so autopilot.ts and the on-demand
 * /api/agents/match route reuse the exact same prompt + parsing instead of a
 * second, divergent implementation.
 */
export async function scoreJobWithLlm(
  llm: LlmRunner,
  resume: string,
  job: ScorableJob,
  admin: AdminClient,
  userId: string
): Promise<{ verdict: LlmVerdict; tokensUsed: number }> {
  // CACHE STRUCTURE: the rubric and the RESUME go in `system`, the job goes in
  // `prompt`. This is the highest-volume LLM call in the product — one per job
  // — and the resume (up to RESUME_LIMIT chars, ~2k tokens) is byte-identical
  // across every job a given user scores. Sending it in the user prompt, as
  // this did, re-billed those tokens at full price every single time. As a
  // cached prefix they bill at roughly a tenth on every call after the first.
  const system =
    'You are an expert technical recruiter producing an honest, evidence-based fit assessment ' +
    'between a candidate resume and a job. Be specific and concrete. Never invent candidate ' +
    'experience. Respond with a single JSON object and nothing else.\n\n' +
    `CANDIDATE RESUME (the only source of truth about the candidate — never credit ` +
    `experience that is not here):\n${resume.slice(0, RESUME_LIMIT)}`

  // INJECTION DEFENCE (lib/security/job-text.ts): this is the highest-volume
  // model call in the product — one per job — and the description is
  // EMPLOYER-CONTROLLED (anyone can post a job). frameJobText fences it as
  // DATA and caps it at DESC_LIMIT (the same cap the old `.slice()` used, so
  // the prompt's size budget is unchanged); see that file's header for the
  // concrete payload this guards against ("score this job 100").
  //
  // buildMatchContext (lib/context/assemble.ts) goes in `prompt`, not
  // `system`, on purpose: it is per-COMPANY (dossier/interactions/insights),
  // not per-user like the resume above, so it varies job to job and would
  // break the cached system prefix's byte-identity if it lived there — see
  // this function's own CACHE STRUCTURE comment.
  const matchContext = await buildMatchContext(admin, userId, job.companyId ?? null)
  const prompt = `JOB:\nTitle: ${job.title}\nCompany: ${job.companyName || 'Unknown'}\n` +
    `Location: ${job.location ?? 'Unspecified'}\n` +
    `Description:\n${frameJobText(job.description, { maxChars: DESC_LIMIT, emptyPlaceholder: '(no description provided)' })}\n\n` +
    (matchContext ? `${matchContext}\n\n` : '') +
    `Return JSON with EXACTLY these keys:\n` +
    `{\n` +
    `  "score": <overall fit 0-100>,\n` +
    `  "skillsMatch": <0-100>,\n` +
    `  "experienceMatch": <0-100>,\n` +
    `  "locationMatch": <0-100>,\n` +
    `  "strengths": [<3-5 concrete reasons the candidate fits, each grounded in the resume>],\n` +
    `  "gaps": [<0-5 concrete missing/weak requirements>],\n` +
    `  "seniorityFit": "<one short phrase, e.g. 'Strong fit for senior IC' or 'Slightly junior'>",\n` +
    `  "summary": "<2-3 sentence plain-language explanation of the match>",\n` +
    `  "matchedSkills": [<skills present in BOTH resume and job>],\n` +
    `  "missingSkills": [<skills the job wants that the resume lacks>]\n` +
    `}`

  // 900 tokens was too tight for a verdict carrying strengths, gaps and two
  // skill lists: the only jobs strong enough to reach this deep pass are the
  // ones with the most to say about them, so the richest verdicts truncated
  // and were lost. Retry once wider rather than dropping a top match.
  const base = { system, prompt, json: true, maxTokens: 1800, temperature: 0.2, cachePrefix: true } as const
  let res
  try {
    res = await llm(base)
  } catch (err) {
    if (!(err instanceof TruncatedResponseError)) throw err
    res = await llm({ ...base, maxTokens: base.maxTokens * 2 })
  }
  const raw = parseJsonLoose<Partial<LlmVerdict>>(res.content)

  const verdict: LlmVerdict = {
    score: clampPct(raw.score),
    skillsMatch: clampPct(raw.skillsMatch ?? raw.score),
    experienceMatch: clampPct(raw.experienceMatch ?? raw.score),
    locationMatch: clampPct(raw.locationMatch ?? 100),
    strengths: strArray(raw.strengths),
    gaps: strArray(raw.gaps),
    seniorityFit: typeof raw.seniorityFit === 'string' ? raw.seniorityFit : '',
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    matchedSkills: strArray(raw.matchedSkills),
    missingSkills: strArray(raw.missingSkills),
  }
  return { verdict, tokensUsed: res.tokensUsed }
}

/** Build the persisted jobs.match_details shape from a verdict. Exported for reuse. */
export function buildMatchDetails(verdict: LlmVerdict): Record<string, unknown> {
  return {
    overallScore: verdict.score,
    score: verdict.score,
    skillsMatch: verdict.skillsMatch,
    experienceMatch: verdict.experienceMatch,
    locationMatch: verdict.locationMatch,
    highlights: verdict.strengths, // UI (match-badge) reads `highlights`
    strengths: verdict.strengths,
    gaps: verdict.gaps,
    seniorityFit: verdict.seniorityFit,
    summary: verdict.summary,
    skills: { matched: verdict.matchedSkills, missing: verdict.missingSkills },
    matchedAt: new Date().toISOString(),
    source: 'harness/matcher',
  }
}

/**
 * True when a classified facet's value should be treated as "not yet
 * classified" — passes every targeting filter no matter what the user
 * targeted. lib/jobs/classify.ts's classifier writes the LITERAL STRING
 * 'unknown' when it can't confidently classify seniority or language
 * (SENIORITY_LEVELS includes 'unknown'; detectLanguage() returns 'unknown')
 * — not NULL. passesQualityAndTargeting's contract has always been
 * "unclassified rows pass through" (see below), but the code only ever
 * checked for NULL, so every 'unknown' row was silently treated as a
 * classified value that disagreed with targeting and excluded — 9,225 of
 * ~20k jobs have seniority='unknown', all wrongly excluded whenever the user
 * targets any seniority. Shared + applied uniformly across every classified
 * facet (job_function/seniority/language/country) rather than repeating the
 * check per-facet; job_function and country never actually emit the literal
 * 'unknown' today (job_function's unclassified value is 'other', country's is
 * NULL) but checking it anyway costs nothing and keeps one rule instead of a
 * different rule per facet.
 */
function isUnclassified(value: string | null | undefined): boolean {
  return value == null || value === 'unknown'
}

/**
 * Quality + targeting prefilter. Never spend an LLM call on a confirmed-junk
 * row (quality_score < QUALITY_REJECT_THRESHOLD). Otherwise, a targeting facet
 * only excludes a job when the job HAS a classified value that disagrees —
 * unclassified (NULL, or the classifier's 'unknown' sentinel — see
 * isUnclassified above) columns pass through, since the classifier backfill is
 * still catching up on newly-sourced rows and we'd rather score an unknown-fit
 * job than silently starve the queue on missing metadata.
 *
 * NOTE: for the default candidate pool (fetchDefaultCandidatePool) these same
 * checks are now ALSO pushed into the SQL query below, so LIMIT is applied
 * after filtering instead of before. This function still runs afterward as a
 * safety net — a cheap, harmless re-check for the facets SQL already enforced,
 * plus the two things SQL can't express (excludedCompanies/excludedKeywords
 * need the joined company name / description text) — and it's the ONLY
 * filter for an explicit id list (fetchJobsByIds), which never gets the SQL
 * targeting treatment.
 */
function passesQualityAndTargeting(job: JobRow, targeting: Targeting): boolean {
  if (typeof job.quality_score === 'number' && job.quality_score < QUALITY_REJECT_THRESHOLD) return false
  if (targeting.functions.length > 0 && !isUnclassified(job.job_function) && !targeting.functions.includes(job.job_function!)) {
    return false
  }
  if (targeting.seniority.length > 0 && !isUnclassified(job.seniority) && !targeting.seniority.includes(job.seniority!)) {
    return false
  }
  if (targeting.countries.length > 0 && !isUnclassified(job.country) && !targeting.countries.includes(job.country!)) {
    return false
  }
  if (targeting.languages.length > 0 && !isUnclassified(job.language) && !targeting.languages.includes(job.language!)) {
    return false
  }
  if (targeting.remoteOnly && job.is_remote === false) return false
  if (targeting.excludedCompanies.length > 0) {
    const name = companyName(job).toLowerCase()
    if (name && targeting.excludedCompanies.some((c) => name.includes(c))) return false
  }
  if (targeting.excludedKeywords.length > 0) {
    const haystack = `${job.title} ${job.description ?? ''}`.toLowerCase()
    if (targeting.excludedKeywords.some((k) => haystack.includes(k))) return false
  }
  return true
}

const SELECT_COLUMNS =
  'id, company_id, title, description, location, url, is_new, match_score, posted_at, ' +
  'job_function, seniority, language, country, is_remote, quality_score, companies!inner(name)'

async function fetchJobsByIds(admin: AdminClient, ids: string[], userId: string): Promise<JobRow[]> {
  if (ids.length === 0) return []
  // Ownership enforced via the FK join (SELECT_COLUMNS' companies!inner +
  // this .eq), not an .in('company_id', companyIds) array — see
  // ownedJobsQuery. `ids` itself stays a bounded literal (every caller caps
  // it well under Postgres URL limits before it gets here).
  const { data, error } = await ownedJobsQuery(admin, userId, SELECT_COLUMNS).in('id', ids)
  if (error) {
    console.error('[harness] matcher: jobs-by-id query failed', error)
    return []
  }
  return (data as unknown as JobRow[] | null) ?? []
}

/** Human-readable version of passesQualityAndTargeting's verdict — reuses the
 *  exact same checks (in the same order) so this can never drift from what
 *  selectCandidateJobs actually filters; only called on a job that ALREADY
 *  failed passesQualityAndTargeting, so it always finds a reason. */
function explainExclusion(job: JobRow, targeting: Targeting): string {
  if (typeof job.quality_score === 'number' && job.quality_score < QUALITY_REJECT_THRESHOLD) {
    return `low-quality posting (quality score ${job.quality_score}/100, below the ${QUALITY_REJECT_THRESHOLD} floor) — ` +
      `looks like scraper noise (bad title/near-empty listing), so it was never sent to the model`
  }
  if (targeting.functions.length > 0 && !isUnclassified(job.job_function) && !targeting.functions.includes(job.job_function!)) {
    return `job function "${job.job_function}" is outside your targeting (${targeting.functions.join(', ')})`
  }
  if (targeting.seniority.length > 0 && !isUnclassified(job.seniority) && !targeting.seniority.includes(job.seniority!)) {
    return `seniority "${job.seniority}" is outside your targeting (${targeting.seniority.join(', ')})`
  }
  if (targeting.countries.length > 0 && !isUnclassified(job.country) && !targeting.countries.includes(job.country!)) {
    return `country "${job.country}" is outside your targeting (${targeting.countries.join(', ')})`
  }
  if (targeting.languages.length > 0 && !isUnclassified(job.language) && !targeting.languages.includes(job.language!)) {
    return `language "${job.language}" is outside your targeting (${targeting.languages.join(', ')})`
  }
  if (targeting.remoteOnly && job.is_remote === false) {
    return 'not remote, and your targeting is remote-only'
  }
  if (targeting.excludedCompanies.length > 0) {
    const name = companyName(job).toLowerCase()
    if (name && targeting.excludedCompanies.some((c) => name.includes(c))) {
      return `company "${companyName(job)}" matches an excluded-company keyword in your targeting`
    }
  }
  if (targeting.excludedKeywords.length > 0) {
    const haystack = `${job.title} ${job.description ?? ''}`.toLowerCase()
    const hit = targeting.excludedKeywords.find((k) => haystack.includes(k))
    if (hit) return `title/description contains excluded keyword "${hit}" from your targeting`
  }
  return 'excluded by your targeting settings'
}

export interface CandidateDiagnosis {
  jobId: string
  title: string | null
  /** False when the id doesn't resolve to a job in one of the user's tracked
   *  companies at all (wrong id, or a company outside their ownership) — a
   *  distinct case from "found but excluded by quality/targeting" below, kept
   *  as its own field rather than making callers pattern-match `reason`. */
  found: boolean
  /** True when the job's description is empty/whitespace — NOT itself a
   *  failure: a description-less job is still scored from the title alone
   *  (see bulk_matcher's tier-1 prompt), just at lower confidence. */
  hasDescription: boolean
  /** True when this job will be sent to the model at all. */
  willAttemptScoring: boolean
  /** Why willAttemptScoring is false. Always set together with false, never
   *  left for the caller to guess at — see the score_jobs copilot tool, which
   *  surfaces this per job instead of a bare aggregate "N failed". */
  reason: string | null
}

/**
 * Diagnose a specific set of job ids against ownership + the quality/targeting
 * prefilter, WITHOUT scoring them. Exists for the copilot's score_jobs tool:
 * when a request like "score these 3 jobs" only scores 1, this is how it
 * explains WHY the other 2 never even reached the model, instead of
 * collapsing them into an unexplained "2 failed".
 */
export async function diagnoseCandidateJobs(
  admin: AdminClient,
  jobIds: string[],
  userId: string,
  targeting: Targeting
): Promise<CandidateDiagnosis[]> {
  if (jobIds.length === 0) return []
  const rows = await fetchJobsByIds(admin, jobIds, userId)
  const byId = new Map(rows.map((r) => [r.id, r]))
  return jobIds.map((jobId) => {
    const row = byId.get(jobId)
    if (!row) {
      return {
        jobId,
        title: null,
        found: false,
        hasDescription: false,
        willAttemptScoring: false,
        reason: 'not found among your tracked companies\' jobs',
      }
    }
    const hasDescription = Boolean((row.description ?? '').trim())
    const ok = passesQualityAndTargeting(row, targeting)
    return {
      jobId,
      title: row.title,
      found: true,
      hasDescription,
      willAttemptScoring: ok,
      reason: ok ? null : explainExclusion(row, targeting),
    }
  })
}

/**
 * Quote a value for embedding in a hand-built PostgREST filter list
 * (`col.in.(a,b,c)`) when it contains characters the list syntax treats as
 * delimiters. Mirrors @supabase/postgrest-js's own `.in()` escaping (see
 * PostgrestFilterBuilder) so values with a comma/paren/quote round-trip
 * correctly instead of corrupting the filter string or silently matching the
 * wrong thing. In practice targeting values are short slugs/ISO codes and
 * never hit this path, but targeting.countries/languages come from a free-text
 * UI field (lib/targeting.ts resolveTargeting does not validate against a
 * fixed vocabulary), so this is real defense, not decoration.
 */
function quoteFilterValue(v: string): string {
  return /[,()"]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v
}

/**
 * Build the `.or()` fragment for one classified facet: match a targeted
 * value, OR the column is NULL, OR it holds the classifier's 'unknown'
 * sentinel (see isUnclassified — same "unclassified passes through" rule,
 * now expressed in SQL instead of only in the JS safety net below).
 */
function facetOrFilter(column: string, values: string[]): string {
  const list = values.map(quoteFilterValue).join(',')
  return `${column}.is.null,${column}.eq.unknown,${column}.in.(${list})`
}

/**
 * Default candidate pool: unscored jobs for the user's companies, freshest
 * first, with quality + targeting pushed into the SQL query itself.
 *
 * BUG FIX (filter-after-limit starvation): this used to run `.limit(poolSize)`
 * with NO targeting applied, then filter the already-limited page in JS
 * (passesQualityAndTargeting via selectCandidateJobs) — so LIMIT picked the
 * freshest ~100-400 rows FIRST and targeting was applied SECOND, on that
 * already-truncated slice. Reproduced against prod: of the freshest 100
 * unscored rows for a real account, ZERO passed targeting, while thousands of
 * passing rows existed in the account overall — every scheduled run logged
 * 'no-candidates-after-targeting-filter' and scored nothing while reporting
 * success. Pushing job_function/seniority/language/country/is_remote/
 * quality_score into the query (via `.or()`, matching the exact same
 * "unclassified passes through" semantics as passesQualityAndTargeting) means
 * LIMIT is now applied AFTER filtering, so the freshest rows we actually keep
 * are freshest rows that could ever be scored. excludedCompanies/
 * excludedKeywords stay JS-only (need the joined company name / description
 * text) and remain a safety-net-only concern, not a starvation risk, since
 * they're rare/optional user prefs rather than the default-empty case that
 * was silently eating 100% of every pool.
 *
 * MATCHER-POOL FIX (finding 6): this used to additionally require
 * `.eq('is_new', true)`. verifier.ts:181 sets `is_new: false` on jobs it
 * knocks out (dead URL, missing title, dedupe collision) SPECIFICALLY so the
 * matcher skips them for AUTO-TRIAGE (see the score loop below: `if (s.score
 * < threshold || s.isNew === false) continue` before creating an application
 * row) — is_new was never meant to gate SCORING itself, only whether a strong
 * match is trusted enough to auto-apply. Filtering the candidate pool on it
 * too meant a knocked-out job's match_score stayed NULL forever: it could
 * never satisfy `.is('match_score', null)` AND `.eq('is_new', true)`
 * simultaneously again once knocked out, so it silently fell out of every
 * future pool — permanently unreachable by cron, autopilot, AND this pool
 * query, with no error anywhere.
 *
 * The correct gate for "still needs scoring" is `match_score is null` alone.
 * is_new stays exactly where it already worked correctly: the isNew===false
 * guard in the auto-triage loop, so a knocked-out job can still be SCORED
 * (useful for the UI / copilot explain_match) but will never auto-triage into
 * an application. (As of this writing prod has zero unscored rows with
 * is_new=false, so this was a latent bug — not the cause of the current
 * 20,184-unscored backlog — but it would silently reappear the next time
 * verifier knocks a job out before it's been scored.)
 */
async function fetchDefaultCandidatePool(
  admin: AdminClient,
  userId: string,
  poolSize: number,
  targeting: Targeting
): Promise<JobRow[]> {
  let query = ownedJobsQuery(admin, userId, SELECT_COLUMNS)
    .is('match_score', null)
    // Never spend an LLM call on confirmed junk. Was JS-only; pushed into SQL
    // so it no longer eats into LIMIT before targeting gets a say.
    .or(`quality_score.is.null,quality_score.gte.${QUALITY_REJECT_THRESHOLD}`)

  if (targeting.functions.length > 0) query = query.or(facetOrFilter('job_function', targeting.functions))
  if (targeting.seniority.length > 0) query = query.or(facetOrFilter('seniority', targeting.seniority))
  if (targeting.languages.length > 0) query = query.or(facetOrFilter('language', targeting.languages))
  if (targeting.countries.length > 0) query = query.or(facetOrFilter('country', targeting.countries))
  // Mirrors passesQualityAndTargeting: only a job explicitly marked NOT
  // remote is excluded; NULL (unclassified) and true both pass.
  if (targeting.remoteOnly) query = query.or('is_remote.is.null,is_remote.eq.true')

  const { data, error } = await query
    .order('posted_at', { ascending: false, nullsFirst: false })
    .limit(poolSize)
  if (error) {
    console.error('[harness] matcher: candidate pool query failed', error)
    return []
  }
  return (data as unknown as JobRow[] | null) ?? []
}

/**
 * Count of unscored jobs for these companies with NO targeting applied — used
 * only to build a diagnosable skippedReason when the targeted pool comes back
 * empty (see selectCandidateJobs), so a future starvation shows up in
 * agent_steps as "targeting excluded N rows" instead of collapsing back into
 * the same silent-looking no-op this whole fix was written to prevent.
 * Returns null (rather than throwing) when the count query itself fails, so
 * one broken diagnostic query can't take down the caller's real result.
 */
async function countUnscoredJobs(admin: AdminClient, userId: string): Promise<number | null> {
  const { count, error } = await ownedJobsQuery(admin, userId, 'id, companies!inner(user_id)', {
    count: 'exact',
    head: true,
  }).is('match_score', null)
  if (error) {
    console.error('[harness] matcher: unscored-count query failed', error)
    return null
  }
  return count ?? 0
}

/**
 * Resolve the candidate jobs to score: either an explicit id list (from the
 * planner/sourcer's dependency output, or an on-demand caller) or the default
 * unscored/newest-first pool — either way, filtered by quality + targeting and
 * capped at `limit`, ordered by recency (posted_at desc).
 *
 * `totalUnscored` is set only when the resolved pool is empty AND we used the
 * default pool (not an explicit id list): the count of unscored jobs for
 * these companies with NO targeting applied at all, so a caller can tell
 * "nothing left to score" apart from "targeting excluded everything" instead
 * of both collapsing into candidatesConsidered === 0. See scoreJobBatch.
 */
export async function selectCandidateJobs(
  admin: AdminClient,
  userId: string,
  targeting: Targeting,
  limit: number,
  explicitJobIds?: string[],
  /**
   * The titles the user configured (lib/targeting/titles.ts). Used to ORDER the
   * pool, never to filter it — an unrecognised title still gets scored, just
   * later. Optional so existing callers keep their previous behaviour exactly.
   */
  targetTitles: readonly string[] = []
): Promise<{ jobs: JobRow[]; candidatesConsidered: number; totalUnscored?: number | null }> {
  const poolSize = Math.min(MAX_POOL, Math.max(limit * POOL_MULTIPLIER, 100))
  const usingExplicitIds = !!(explicitJobIds && explicitJobIds.length > 0)
  const pool = usingExplicitIds
    ? await fetchJobsByIds(admin, explicitJobIds!.slice(0, poolSize), userId)
    : await fetchDefaultCandidatePool(admin, userId, poolSize, targeting)

  const candidatesConsidered = pool.length
  // Pool is already ordered by posted_at desc (or id-list order); filtering
  // preserves that order, so a plain slice keeps the freshest-first contract.
  // For the default pool this is now a redundant safety net (SQL already
  // applied quality + facet targeting above) plus the two checks SQL can't
  // express; for an explicit id list it's the only filter. Either way LIMIT
  // was already applied AFTER targeting for the default pool, so this slice
  // no longer re-truncates a pre-targeting page.
  const filtered = pool.filter((job) => passesQualityAndTargeting(job, targeting))

  // SPEND ON THE MOST PROMISING JOBS FIRST.
  //
  // The pool above is ordered newest-first, and the SQL facets are coarse —
  // `job_function = engineering` alone matches 12,924 rows in this workspace,
  // of which a measured 7.2% mention AI/ML/GenAI/LLM at all. So "the newest N
  // unscored" is close to an arbitrary N, and every one of them costs a metered
  // LLM call. That is what the user saw: a score button that "just scores
  // randomly 25 jobs which you might be bad for".
  //
  // Title matching is free and deterministic, so it is used to reorder what was
  // already fetched before any money is spent. This is strictly an ORDERING
  // change: nothing new is excluded, so a job whose title matches no target is
  // still scored — it simply waits its turn behind the ones that do. With no
  // target titles configured this is a no-op and the freshest-first contract
  // above is untouched.
  const prioritised = prioritiseByTargetTitles(filtered, targetTitles)
  const jobs = prioritised.slice(0, limit)

  if (jobs.length === 0 && !usingExplicitIds) {
    const totalUnscored = await countUnscoredJobs(admin, userId)
    return { jobs, candidatesConsidered, totalUnscored }
  }
  return { jobs, candidatesConsidered }
}

export interface ScoredJobResult {
  jobId: string
  isNew: boolean | null
  score: number
  highlights: string[]
  gaps: string[]
  matchDetails: Record<string, unknown>
}

export interface ScoreBatchOptions {
  admin: AdminClient
  userId: string
  companyIds: string[]
  resume: string
  targeting: Targeting
  llm: LlmRunner
  limit: number
  signal?: AbortSignal
  /** Explicit ids to score (e.g. from a sourcer step) instead of the default unscored pool. */
  jobIds?: string[]
  /** For lib/graph/verify/matcher.ts's judgeMatchQuality sample (best-effort:
   *  a missing/expired key just means every score in this batch skips the
   *  judge — writeVerdict's own 'unjudged' path, never a crash). */
  apiKeys?: DecryptedApiKeys
  /** The action/auto-triage threshold — every score crossing it joins the
   *  judge sample (Step 4, item 3), alongside a deterministic 10% of the
   *  rest. Defaults to DEFAULT_THRESHOLD when the caller doesn't know the
   *  user's own preference yet (matcher's own AgentFn passes the real one). */
  judgeThreshold?: number
  /** The agent_runs row this batch runs under, when there is one — threaded
   *  into logHarnessError so an unexpected judgeMatchQuality failure (see
   *  verifyMatchVerdict) attributes to a real run, not a bare jobId. */
  runId?: string
}

export interface ScoreBatchResult {
  scored: ScoredJobResult[]
  failedCount: number
  candidatesConsidered: number
  skippedReason?: string
}

/**
 * Build a diagnosable skippedReason for an empty candidate pool. Distinguishes
 * cases that used to collapse into one indistinguishable no-op:
 *  - 'no-unscored-jobs': genuinely nothing left to score for these companies.
 *  - 'no-candidates-after-targeting-filter (unscored=N, after-targeting=0)':
 *    the SQL-pushed targeting filter (job_function/seniority/language/
 *    country/is_remote/quality_score) excluded every unscored row — this is
 *    the exact starvation bug fixed here, now impossible to hide.
 *  - 'no-candidates-after-safety-net-filter (...)': targeting let rows
 *    through but the JS-only safety net (excludedCompanies/excludedKeywords)
 *    filtered the rest.
 * totalUnscored is undefined for explicit id-list runs (no pool to diagnose,
 * see selectCandidateJobs) and null when the diagnostic count query failed.
 */
function buildEmptyPoolReason(candidatesConsidered: number, totalUnscored: number | null | undefined): string {
  if (totalUnscored === undefined) {
    return candidatesConsidered > 0 ? 'no-candidates-after-targeting-filter' : 'no-candidates'
  }
  if (totalUnscored === null) {
    return `no-candidates-after-targeting-filter (unscored-count-unknown, after-targeting=${candidatesConsidered})`
  }
  if (totalUnscored === 0) return 'no-unscored-jobs'
  if (candidatesConsidered === 0) {
    return `no-candidates-after-targeting-filter (unscored=${totalUnscored}, after-targeting=0)`
  }
  return `no-candidates-after-safety-net-filter (unscored=${totalUnscored}, after-targeting=${candidatesConsidered}, after-safety-net=0)`
}

/**
 * Select candidates (prefiltered by quality + targeting) and score them with
 * the LLM, persisting match_score/match_details as it goes. THE shared scoring
 * routine — called by the harness `matcher` step below, by
 * lib/graph/autopilot.ts, and indirectly by the on-demand match route (which
 * calls scoreJobWithLlm directly for a single explicit job, bypassing the
 * targeting prefilter since that's an explicit user action).
 */
/**
 * Deterministic postcondition on EVERY verdict (score range, schema-
 * complete, the fabricated-evidence detector), plus judgeMatchQuality on the
 * sample needsJudgeSample() selects. Best-effort in every direction: a
 * writeVerdict failure is already swallowed by that function; a judge that
 * can't run (no key / over budget) writes 'unjudged' instead of throwing —
 * scoring an entire batch must never fail because verification couldn't. An
 * unexpected judge failure (neither MissingKeyError nor BudgetCapError) is
 * NOT a typed refusal — writeVerdict gets no row for it (same "the score
 * stands, verification just didn't run" contract as any other skipped
 * sample) but it is never silent: logHarnessError before continuing, the
 * same "expected stop vs genuine failure" split every other judge call site
 * in this stage uses (see lib/graph/verify/cv-tailor.ts, lib/evals/judge.ts).
 *
 * Exported for lib/harness/agents/matcher.test.ts's direct integration
 * coverage of the writeVerdict calls / floor-before-spend / catch branches —
 * every other caller reaches this only through scoreJobBatch below.
 */
export async function verifyMatchVerdict(opts: ScoreBatchOptions, jobId: string, verdict: LlmVerdict, framedJobText: string): Promise<void> {
  const deterministic = checkMatchVerdictDeterministic(verdict, framedJobText)
  await writeVerdict(opts.admin, {
    userId: opts.userId,
    runId: opts.runId,
    subjectKind: 'match_score',
    subjectId: jobId,
    judge: 'deterministic',
    verdict: deterministic.ok ? 'pass' : 'fail',
    rationale: deterministic.ok ? null : deterministic.reasons.join('; '),
  })

  const threshold = opts.judgeThreshold ?? DEFAULT_THRESHOLD
  if (!needsJudgeSample(verdict, jobId, threshold)) return
  if (!opts.apiKeys?.openrouter) return // no key -> 'unjudged' by omission, same as the deterministic-only case

  try {
    const client = meteredJudgeClient(opts.admin, opts.userId, opts.apiKeys)
    const verdictSummary =
      `Score: ${verdict.score}. Summary: ${verdict.summary}\nStrengths: ${verdict.strengths.join('; ')}\n` +
      `Gaps: ${verdict.gaps.join('; ')}`
    const jobAndResume = `JOB:\n${framedJobText}\n\nRESUME:\n${opts.resume}`
    const judged = await judgeMatchQuality(client, { verdictSummary, jobAndResume }, { userId: opts.userId })
    await writeVerdict(opts.admin, {
      userId: opts.userId,
      runId: opts.runId,
      subjectKind: 'match_score',
      subjectId: jobId,
      judge: 'closed_qa',
      verdict: judged.verdict,
      score: judged.score,
      threshold: judged.threshold,
      rationale: judged.summary,
    })
  } catch (err) {
    if (err instanceof MissingKeyError || err instanceof BudgetCapError) {
      await writeVerdict(opts.admin, {
        userId: opts.userId,
        runId: opts.runId,
        subjectKind: 'match_score',
        subjectId: jobId,
        judge: 'closed_qa',
        verdict: 'unjudged',
      })
      return
    }
    logHarnessError(
      { runId: opts.runId ?? jobId, stepLabel: `match:${jobId}`, agentType: 'matcher', phase: 'judge', userId: opts.userId },
      err
    )
  }
}

export async function scoreJobBatch(opts: ScoreBatchOptions): Promise<ScoreBatchResult> {
  if (!opts.resume.trim()) {
    return { scored: [], failedCount: 0, candidatesConsidered: 0, skippedReason: 'no-resume' }
  }
  if (opts.companyIds.length === 0) {
    return { scored: [], failedCount: 0, candidatesConsidered: 0, skippedReason: 'no-companies' }
  }

  const { jobs, candidatesConsidered, totalUnscored } = await selectCandidateJobs(
    opts.admin,
    opts.userId,
    opts.targeting,
    opts.limit,
    opts.jobIds
  )
  if (jobs.length === 0) {
    return {
      scored: [],
      failedCount: 0,
      candidatesConsidered,
      skippedReason: buildEmptyPoolReason(candidatesConsidered, totalUnscored),
    }
  }

  const scored: ScoredJobResult[] = []
  let failedCount = 0
  let lastError = ''
  for (const job of jobs) {
    if (opts.signal?.aborted) break
    try {
      const { verdict } = await scoreJobWithLlm(opts.llm, opts.resume, toScorable(job), opts.admin, opts.userId)
      const matchDetails = buildMatchDetails(verdict)
      await opts.admin
        .from('jobs')
        .update({ match_score: verdict.score, match_details: matchDetails })
        .eq('id', job.id)
      scored.push({
        jobId: job.id,
        isNew: job.is_new,
        score: verdict.score,
        highlights: verdict.strengths,
        gaps: verdict.gaps,
        matchDetails,
      })
      // VERIFY (Step 4, item 3) — the SCORE STANDS either way; a failed
      // verification marks the eval_verdicts row, never jobs.match_score.
      // The SAME framed text scoreJobWithLlm's own prompt showed the model —
      // re-framed here (cheap, deterministic) rather than threaded back out
      // of that call, so the fabricated-evidence check tests against exactly
      // what the model actually saw.
      const framedJobText = frameJobText(job.description, { maxChars: DESC_LIMIT, emptyPlaceholder: '' })
      await verifyMatchVerdict(opts, job.id, verdict, framedJobText)
    } catch (err) {
      if (err instanceof MissingKeyError) {
        // No LLM key at all — stop immediately, no point burning the rest of
        // the batch on a guaranteed-repeat failure.
        return { scored, failedCount: failedCount + 1, candidatesConsidered, skippedReason: 'no-llm-key' }
      }
      failedCount++
      lastError = err instanceof Error ? err.message : String(err)
      console.error(`[harness] matcher: scoring failed for job ${job.id}`, err)
    }
  }

  let skippedReason: string | undefined
  if (scored.length === 0 && failedCount > 0) {
    skippedReason = `all ${failedCount} scoring attempt(s) failed: ${lastError}`.slice(0, 300)
  }
  return { scored, failedCount, candidatesConsidered, skippedReason }
}

export const matcher: AgentFn = async (ctx) => {
  const input = MatcherInput.parse(ctx.input ?? {})

  // 1) Resolve the user's resume, auto-triage threshold, and targeting.
  const { data: profile } = await ctx.admin
    .from('profiles')
    .select('resume_text, preferences')
    .eq('id', ctx.userId)
    .single()

  const resume = ((profile?.resume_text as string | null) ?? '').trim()
  const prefs = (profile?.preferences as Record<string, unknown> | null) ?? {}
  const rawThreshold = prefs.matchThreshold ?? prefs.match_threshold
  const threshold =
    typeof rawThreshold === 'number' && Number.isFinite(rawThreshold) ? rawThreshold : DEFAULT_THRESHOLD
  const targeting = resolveTargeting(prefs)

  // 2) Determine candidates: explicit dep-provided ids win; otherwise the
  // default unscored/newest-first pool. Ownership + quality + targeting are
  // enforced by scoreJobBatch/selectCandidateJobs either way.
  const explicitJobIds = collectJobIds(input.jobIds, ctx.deps)
  const companyIds = await userCompanyIds(ctx.admin, ctx.userId)

  const batch = await scoreJobBatch({
    admin: ctx.admin,
    userId: ctx.userId,
    companyIds,
    resume,
    targeting,
    llm: ctx.llm,
    limit: MAX_JOBS_PER_TICK,
    signal: ctx.signal,
    jobIds: explicitJobIds.length > 0 ? explicitJobIds : undefined,
    apiKeys: ctx.apiKeys,
    judgeThreshold: threshold,
    runId: ctx.runId,
  })

  console.log(
    `[harness] matcher user=${ctx.userId}: considered=${batch.candidatesConsidered} ` +
      `scored=${batch.scored.length} failed=${batch.failedCount}` +
      (batch.skippedReason ? ` skippedReason="${batch.skippedReason}"` : '')
  )

  // 3) Auto-triage: strong match, still new (verifier didn't knock it out),
  // and not already tracked → create a 'discovered' application.
  for (const s of batch.scored) {
    if (s.score < threshold || s.isNew === false) continue
    const { data: existing } = await ctx.admin
      .from('applications')
      .select('id')
      .eq('user_id', ctx.userId)
      .eq('job_id', s.jobId)
      .maybeSingle()

    if (!existing) {
      await ctx.admin.from('applications').insert({
        user_id: ctx.userId,
        job_id: s.jobId,
        stage: 'discovered',
        source: 'harness/matcher',
        notes: `Auto-triaged: match ${s.score}% (>= ${threshold}%).`.slice(0, 500),
      })
    }
  }

  const matches = batch.scored.map((s) => ({
    jobId: s.jobId,
    score: s.score,
    highlights: s.highlights,
    gaps: s.gaps,
  }))
  const topJobIds = matches
    .filter((m) => m.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .map((m) => m.jobId)

  return {
    output: {
      matches,
      topJobIds,
      skippedReason: batch.skippedReason,
      candidatesConsidered: batch.candidatesConsidered,
    },
    tokensUsed: 0, // already metered per-call through ctx.llm
  }
}
