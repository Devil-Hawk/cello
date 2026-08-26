// CONTINUOUS AUTOPILOT ENGINE — LangGraph Functional API port of
// lib/harness/autopilot.ts (docs/superpowers/specs/2026-08-16-langgraph-port-
// design.md, step 10). Read the deleted file's own header in git history
// before touching this one — the guarantees below are a direct behavioral
// port, not a redesign.
//
// A scheduled worker that runs on every cron tick while the user is away. Each
// tick, per user who has OPTED IN, it: sources fresh jobs (official ATS APIs),
// scores them against the resume, and for jobs above the user's threshold it
// tailors them and builds a `pending_review` application_draft with a
// prefilled handoff link — the SAME human-approve-queue path applier.ts uses
// by default for any run. It NEVER submits.
//
// SAFETY (non-negotiable, enforced in code below, not by this comment):
// submitting a job application is IRREVERSIBLE and public, and this engine
// runs completely unattended on an hourly cron (.github/workflows/
// autopilot-cron.yml) with no human present at any given tick — there is no
// such thing as "per-run human confirmation" on a schedule. So this file must
// never itself flip applier's `autoSubmit` to true; the `autoSubmit` passed
// to the applier unit inside prepareApplicationDraft below is hardcoded
// `false`. An actual submission always requires a SEPARATE,
// explicit, human-initiated action after the fact (lib/harness/chains.ts#
// buildSubmitConfirmedPlan, which refuses to compile without a literal
// `confirmed:true` the caller supplies, invoked from the apply UI — never
// from this cron path). `autoSubmit` is NOT read from
// lib/automation/capabilities.ts either: that module governs what the UI may
// OFFER; this is a second, independent lock so flipping a UI constant can
// never by itself start firing applications at real employers. Two locks for
// an action that cannot be undone.
//
// "Never stops" = the always-on schedule + fresh-job discovery + drafting,
// NOT unattended submission. Every tick is still disciplined by NON-NEGOTIABLE
// guardrails baked into THIS code (not just prompts):
//
//   KILL SWITCH   preferences.autopilot.enabled defaults FALSE. One toggle off.
//   NEVER SUBMITS autoSubmit is hardcoded false — see SAFETY note above.
//   DEDUPE        never draft for a job that already has an application_draft or
//                 applications row for this user. One draft per job, ever.
//   DAILY CAP     preferences.autopilot.dailyCap (default 15) — retained as an
//                 informational rate signal in the digest (see remainingCap
//                 below); no longer gates a real submission since this file
//                 never submits.
//   QUALITY GATE  only tailor + draft jobs with match_score >=
//                 preferences.autopilot.minScore (default 90).
//   OFFICIAL APIS Handoff links target Greenhouse/Lever/Ashby apply pages only.
//   HONEST CAPS   logs when it hits caps / exhausts matches instead of looping.
//
// Every draft + decision is journaled to agent_steps under an agent_run; the
// run.result is the per-tick digest.
//
// GOAL-DIRECTED TICKS (lib/harness/goals.ts, UNCHANGED by this port)
//   When the user has an ACTIVE goal ("get me 50 FDE applications ready"), a
//   tick advances THAT instead of running the untargeted sweep below: it judges
//   fresh candidates against the goal with a written keep/discard rationale,
//   prepares drafts for the keeps, and stops the moment the goal is satisfied,
//   expired, out of budget, out of fresh candidates, or at one of its hard
//   ceilings. Progress lives in profiles.preferences.searchGoals, so tick 4
//   continues tick 3's work rather than re-judging (and re-paying for) the same
//   postings. With no active goal, every line below behaves exactly as it did
//   before goals existed.
//
//   The goal path changes WHAT gets prepared, never WHETHER anything is sent:
//   both paths prepare applications through the one shared helper below
//   (prepareApplicationDraft), which is the single place `autoSubmit` is set
//   and sets it to a hardcoded false. A goal reaching "50 of 50" means fifty
//   applications are waiting for one human approval — never fifty sent.
//
// FRESH THREAD PER TICK — NO CROSS-TICK RESUME.
//   Every other Functional-API surface in this port (harnessRun, refreshJobs)
//   can be interrupted mid-body and resumed later against the SAME checkpoint
//   thread. Autopilot deliberately never does that: app/api/harness/autopilot/
//   route.ts never passes a `threadId` into invokeGraphForUser, so every tick
//   mints a brand-new graph_threads row and a brand-new checkpoint thread (see
//   that route's own test for the pin). The goal ledger
//   (profiles.preferences.searchGoals, lib/harness/goals.ts) REMAINS the sole
//   durable memory that survives across ticks — its ordered writes (judge,
//   THEN persist, THEN draft — see runGoalTick below) are load-bearing for
//   that reason. A resumable tick would create a SECOND persistence layer
//   (the checkpoint) that can disagree with the ledger about what has already
//   been judged or drafted; there is exactly one source of cross-tick truth,
//   and it is the ledger. Deadline/budget behavior downstream of that: "stop
//   early, ledger holds progress" is a plain terminal return (see finishRun
//   below), never an interrupt() — nothing in this file ever calls
//   interrupt(), and nothing resumes a tick that stopped early. The next
//   scheduled tick (a fresh thread) picks up wherever the ledger says to.
//
// TASKS (LangGraph Functional API `task()`), one per phase that touches a
// model or a third-party API:
//   sourceTask  refreshes the user's tracked companies via the official ATS
//               APIs (lib/ats). Runs at most once per tick — module-level,
//               like lib/graph/runs.ts's plannerTask.
//   scoreTask   scores unscored candidates via the shared matcher path
//               (lib/harness/agents/matcher.ts#scoreJobBatch) — the exact code
//               path the harness's on-demand match route and cron digest use,
//               so autopilot can never silently diverge in match quality.
//               Module-level, once per tick.
//   judgeTask   the goal path's keep/discard judgement
//               (lib/harness/goals.ts#judgeCandidates). Module-level, once per
//               tick, only reached when an active goal exists.
//   draftTask   prepareApplicationDraft for ONE eligible job — tailor, then
//               draft-or-handoff. Named per job (`draft:${jobId}`, mirroring
//               lib/graph/refresh.ts's per-company task naming) since a tick
//               fans this out across every eligible job. THE ONLY task that
//               can reach applier — see prepareApplicationDraft's own header.
//
// journalStep/insertStep/finishStep — the pre-port mini-executor this file
// used to hand-roll for cv_tailor/applier calls — are GONE. Journaling for
// those two agent types now flows automatically from
// lib/graph/unit.ts#runAgentUnit (called inside draftTask); the remaining
// summary-only journal writes (sourcer/matcher/planner) call
// lib/graph/journal.ts's journalStepStart/journalStepFinish directly, exactly
// like lib/graph/runs.ts's runLoopStep/runFanOutStep already do for their own
// non-unit steps.
//
// EACH TASK BUILDS ITS OWN FRESH admin/apiKeys/llm, NEVER PASSED THROUGH TASK
// ARGS. Task inputs/outputs are checkpoint-serializable (persisted to the
// `langgraph` schema) — a live AdminClient, an AbortController or a decrypted
// API key have no business being written there (see lib/graph/refresh.ts's
// RULING 9 for the live-client half of this argument; the API-key half is
// this file's own: unit.ts's own header already establishes "FRESH per call,
// never cached" as the security baseline every model-reaching path in this
// port follows). Every task below calls loadApiKeys(admin, userId) itself,
// exactly like lib/graph/runs.ts's plannerTask/makeUnitTask do.
//
// BUDGET: each task is handed `budgetRemaining` (a plain number — the tick's
// remaining allowance) rather than sharing one mutable counter or one
// AbortController across tasks (neither survives being a task argument). Each
// task builds a local metered LlmRunner that aborts once ITS OWN usage
// crosses that number, and returns how many tokens it actually spent; the
// entrypoint sums those returns into its own `spent` and checks
// `spent >= budgetTokens` BETWEEN task dispatches — the same wave-boundary
// style lib/graph/runs.ts's own budget gate uses. ponytail: this cannot stop
// one already-dispatched draftTask's own two calls (tailor, then apply) from
// completing even if the SECOND one pushes spent over budget — the same
// bounded-overspend-of-one-item's-worth-of-tokens ceiling runs.ts's §3d
// already documents and accepts; upgrade path there is identical (thread a
// live budget accessor into runAgentUnit's own controller, scoped to
// lib/graph/unit.ts, not this file).

import { entrypoint, task } from '@langchain/langgraph'
import type { BaseCheckpointSaver, LangGraphRunnableConfig } from '@langchain/langgraph'

import { refreshCompany, mapWithConcurrency, type AtsStore, type CompanyInput, type JobUpsertRow } from '../ats'
import { resolveTargeting, type Targeting } from '../targeting'
import { loadApiKeys } from '../harness/keys'
import { callLlm } from '../harness/llm'
import { canRunLlm } from '../harness/llm-key-message'
import { scoreJobBatch, ownedJobsQuery } from '../harness/agents/matcher'
import { BudgetCapError } from '../harness/spend'
import { createAdminClient } from '../harness/supabase-admin'
import {
  MAX_JUDGEMENTS_PER_TICK,
  activeGoal,
  concludeGoal,
  endTick,
  evaluateGoalProgress,
  goalCounts,
  judgeCandidates,
  pendingDraftJobIds,
  persistGoal,
  readGoals,
  recordDraftAttempt,
  startTick,
  summarizeGoal,
  type GoalCandidate,
  type GoalJudgement,
  type SearchGoal,
} from '../harness/goals'
import { BudgetExceededError, type AdminClient, type DecryptedApiKeys, type LlmResult, type LlmRunner, type LlmRunOptions } from '../harness/types'
import { journalStepFinish, journalStepStart } from './journal'
import { runAgentUnit, type UnitConfig } from './unit'
import { buildGoalStrategyContext } from '../context/assemble'
import { verifyCvTailorDraft, CvTailorContainmentError } from './verify/cv-tailor'
import { writeVerdict } from '../evals/verdicts'
import { logHarnessError } from '../observability/log'

// --- tunables (verbatim from the pre-port file, same comments) -------------
const MAX_USERS_PER_TICK = 10
const USER_CONCURRENCY = 2
const DEFAULT_DAILY_CAP = 15
const DEFAULT_MIN_SCORE = 90
const DEFAULT_BUDGET_TOKENS = 150_000
/** Cap drafts CREATED per user per tick (throttle even for handoffs). */
const MAX_ACTIONS_PER_TICK = 8
/** Cap companies refreshed per tick to bound wall-clock time. */
const MAX_COMPANIES_REFRESH = 20
/** Cap unscored jobs we score per tick. */
const MAX_SCORE_PER_TICK = 60
/** Candidate jobs pulled per user. */
const CANDIDATE_JOB_LIMIT = 150

export { MAX_USERS_PER_TICK, USER_CONCURRENCY }

export interface AutopilotConfig {
  enabled: boolean
  dailyCap: number
  minScore: number
  budgetTokens: number
}

/** Per-tick view of an active goal, for the digest / morning review. */
export interface AutopilotGoalDigest {
  id: string
  statement: string
  target: number
  /** Applications prepared and waiting for approval. NEVER submissions. */
  drafted: number
  kept: number
  discarded: number
  judged: number
  /** Candidates this tick paid to judge (0 when it only cleared a backlog). */
  judgedThisTick: number
  status: string
  stopReason: string | null
  satisfied: boolean
  summary: string
}

export interface AutopilotUserResult {
  userId: string
  runId?: string
  skipped?: string
  discovered?: number
  scored?: number
  eligible?: number
  submitted?: number
  handoff?: number
  failed?: number
  capReached?: boolean
  budgetExhausted?: boolean
  /** Present only when this tick advanced a goal instead of sweeping. */
  goal?: AutopilotGoalDigest
  message: string
}

export interface AutopilotTickResult {
  ok: true
  enabledUsers: number
  processed: number
  results: AutopilotUserResult[]
}

export interface ProfileRow {
  id: string
  full_name: string | null
  email: string | null
  resume_text: string | null
  preferences: Record<string, unknown> | null
}

/** Parse + normalize the per-user autopilot config (KILL SWITCH defaults FALSE). */
export function parseAutopilotConfig(preferences: Record<string, unknown> | null): AutopilotConfig {
  const raw = (preferences?.autopilot ?? {}) as Record<string, unknown>
  const num = (v: unknown, d: number, min: number, max: number) => {
    const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : d
    return Math.min(max, Math.max(min, n))
  }
  return {
    enabled: raw.enabled === true, // must be explicitly true
    dailyCap: num(raw.dailyCap, DEFAULT_DAILY_CAP, 1, 100),
    minScore: num(raw.minScore, DEFAULT_MIN_SCORE, 0, 100),
    budgetTokens: num(raw.budgetTokens, DEFAULT_BUDGET_TOKENS, 10_000, 1_000_000),
  }
}

export class AutopilotOwnershipError extends Error {
  constructor(profileId: string, invokerUserId: string) {
    super(`autopilotTick: input.profile.id (${profileId}) does not match config.configurable.userId (${invokerUserId}).`)
    this.name = 'AutopilotOwnershipError'
  }
}

// --- module-level tasks: source, score, judge (each runs at most once per
// tick — same "one shared task, no per-item naming" shape as runs.ts's
// plannerTask) -----------------------------------------------------------

interface SourceTaskArgs {
  companies: CompanyInput[]
}
interface SourceTaskResult {
  discovered: number
  refreshed: number
}

/** Admin (service-role) AtsStore — same contract as /api/jobs/refresh's own. */
function makeAdminStore(admin: AdminClient): AtsStore {
  const PAGE = 1000
  return {
    async listJobExternalIds(companyId: string): Promise<Set<string>> {
      const ids = new Set<string>()
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await admin
          .from('jobs')
          .select('external_id')
          .eq('company_id', companyId)
          .range(from, from + PAGE - 1)
        if (error) throw new Error(error.message)
        for (const row of (data ?? []) as { external_id: string | null }[]) {
          if (row.external_id) ids.add(row.external_id)
        }
        if (!data || data.length < PAGE) break
      }
      return ids
    },
    async upsertJobs(rows: JobUpsertRow[]): Promise<void> {
      const { error } = await admin
        .from('jobs')
        .upsert(rows as never, { onConflict: 'company_id,external_id', ignoreDuplicates: false })
      if (error) throw new Error(error.message)
    },
    async saveCompanyMetadata(companyId: string, metadata: Record<string, unknown>): Promise<void> {
      const { error } = await admin
        .from('companies')
        .update({ metadata: metadata as never })
        .eq('id', companyId)
      if (error) throw new Error(error.message)
    },
    async updateCompanyLastScraped(companyId: string): Promise<void> {
      const { error } = await admin
        .from('companies')
        .update({ last_scraped_at: new Date().toISOString() })
        .eq('id', companyId)
      if (error) throw new Error(error.message)
    },
  }
}

const sourceTask = task('source', async (args: SourceTaskArgs): Promise<SourceTaskResult> => {
  const admin = createAdminClient()
  const store = makeAdminStore(admin)
  const toRefresh = args.companies.slice(0, MAX_COMPANIES_REFRESH)
  const refreshResults = await mapWithConcurrency(toRefresh, 5, (c) => refreshCompany(store, c).catch(() => null))
  const discovered = refreshResults.reduce((s, r) => s + (r?.inserted ?? 0), 0)
  return { discovered, refreshed: toRefresh.length }
})

interface ScoreTaskArgs {
  userId: string
  companyIds: string[]
  resume: string
  targeting: Targeting
  limit: number
  /** Tick's remaining token allowance — bounds THIS task's own local meter. */
  budgetRemaining: number
  /** The tick's minScore — doubles as scoreJobBatch's judgeMatchQuality
   *  sampling threshold (Step 4, item 3): every score crossing it is a real
   *  action-selection candidate and joins the judge sample. */
  minScore: number
  /** Threaded into scoreJobBatch's own runId — see ScoreBatchOptions.runId. */
  runId: string
}
interface ScoreTaskResult {
  scored: number
  failedCount: number
  candidatesConsidered: number
  skippedReason?: string
  tokensUsed: number
}

/** A fresh, per-task metered LlmRunner that aborts once its own usage crosses
 *  `budgetRemaining` — see this file's header BUDGET note. Shared shape
 *  between scoreTask and judgeTask. */
function meteredLlm(apiKeys: DecryptedApiKeys, budgetRemaining: number): { llm: LlmRunner; signal: AbortSignal; used: () => number } {
  const controller = new AbortController()
  let used = 0
  const llm: LlmRunner = async (opts: LlmRunOptions): Promise<LlmResult> => {
    if (controller.signal.aborted) throw new BudgetExceededError()
    const res = await callLlm(apiKeys, opts, controller.signal)
    used += res.tokensUsed
    if (used > budgetRemaining) {
      controller.abort()
      throw new BudgetExceededError()
    }
    return res
  }
  return { llm, signal: controller.signal, used: () => used }
}

const scoreTask = task('score', async (args: ScoreTaskArgs): Promise<ScoreTaskResult> => {
  const admin = createAdminClient()
  const apiKeys = await loadApiKeys(admin, args.userId)
  const { llm, signal, used } = meteredLlm(apiKeys, args.budgetRemaining)
  const batch = await scoreJobBatch({
    admin,
    userId: args.userId,
    companyIds: args.companyIds,
    resume: args.resume,
    targeting: args.targeting,
    llm,
    limit: args.limit,
    signal,
    apiKeys,
    judgeThreshold: args.minScore,
    runId: args.runId,
  })
  return {
    scored: batch.scored.length,
    failedCount: batch.failedCount,
    candidatesConsidered: batch.candidatesConsidered,
    skippedReason: batch.skippedReason,
    tokensUsed: used(),
  }
})

interface JudgeTaskArgs {
  userId: string
  goal: SearchGoal
  candidates: GoalCandidate[]
  resume: string
  allowance: number
  budgetRemaining: number
}
interface JudgeTaskResult {
  goal: SearchGoal
  judged: GoalJudgement[]
  tokensUsed: number
  stopped: 'budget' | 'no-llm' | 'aborted' | null
}

const judgeTask = task('judge', async (args: JudgeTaskArgs): Promise<JudgeTaskResult> => {
  const admin = createAdminClient()
  const apiKeys = await loadApiKeys(admin, args.userId)
  const { llm, signal, used } = meteredLlm(apiKeys, args.budgetRemaining)
  // Source-choice/threshold context (lib/context/assemble.ts): general,
  // non-company-scoped strategy notes learned from past ticks — zero
  // embedding calls, one query, reused for every candidate this tick judges.
  const strategyContext = await buildGoalStrategyContext(admin, args.userId)
  const batch = await judgeCandidates({
    goal: args.goal,
    candidates: args.candidates,
    resume: args.resume,
    llm,
    allowance: args.allowance,
    signal,
    strategyContext,
  })
  return { goal: batch.goal, judged: batch.judged, tokensUsed: used(), stopped: batch.stopped }
})

// --- draftTask: prepareApplicationDraft, named per job -----------------------

/** What happened to one attempt at preparing an application. */
type DraftOutcome = 'drafted' | 'failed' | 'submitted' | 'budget'

interface DraftTaskArgs {
  unitConfig: UnitConfig
  canTailor: boolean
  jobId: string
}
export interface DraftTaskResult {
  status: DraftOutcome
  tokensUsed: number
}

/**
 * Tailor a resume for one job and put a REVIEWABLE DRAFT in front of the user.
 *
 * THE ONE PLACE `autoSubmit` IS SET IN THIS FILE, and it is hardcoded false.
 * Both tick paths (untargeted sweep and goal-directed run) go through here, so
 * the no-submit guarantee is one line in one function rather than a rule two
 * call sites have to remember. Adding a third caller inherits it; the only way
 * to lose it is to edit this literal, which is what the test in
 * lib/harness/goals.test.ts watches.
 *
 * SAFETY (unchanged from the file header): submitting a job application is
 * irreversible and public, and this runs on an unattended cron where no human
 * is present at any given tick. A real submission always requires a separate,
 * explicit, human-initiated action — lib/harness/chains.ts#buildSubmitConfirmedPlan,
 * which refuses to compile without a literal `confirmed:true` the caller
 * supplies, invoked from the apply UI and never from this path. `autoSubmit` is
 * NOT read from lib/automation/capabilities.ts either: that module governs what
 * the UI may OFFER; this is a second, independent lock so flipping a UI constant
 * can never by itself start firing applications at real employers. Two locks for
 * an action that cannot be undone.
 *
 * Called ONLY from inside makeDraftTask's task body below (see this file's
 * header — "the call site must be a task body"); builds its own fresh
 * AdminClient, exactly like lib/graph/runs.ts's makeUnitTask does, rather than
 * receiving one through task args.
 */
/** Exported for lib/graph/verify/cv-tailor-persistence.test.ts's direct,
 *  full-stack proof of ruling 2a (fail-without-persist) and 2c (judge-fail
 *  persists 'failed', never 'pending_review') — every other caller reaches
 *  this only through the autopilotTickGraph entrypoint. */
export async function prepareApplicationDraft(unitConfig: UnitConfig, canTailor: boolean, jobId: string): Promise<DraftTaskResult> {
  const admin = createAdminClient()
  let resumeSummary: string | undefined
  let coverLetter: string | undefined
  let tokensUsed = 0
  // Set only for the two outcomes that persist WITH a verdict to flag
  // (ruling 2c: 'judge-failed' -> status 'failed'; 'unjudged' -> requires
  // human review) — 'verified' needs no override, applier's own
  // 'pending_review' already stands.
  let flaggedVerdict: { verdict: 'fail' | 'unjudged'; rationale: string | null } | null = null

  // Tailor + VERIFY (best-effort; needs an LLM key). Ruling 2a: a containment
  // failure that survives the bounded retry loop is FAIL WITHOUT PERSIST —
  // this whole draft attempt stops here, nothing written to
  // application_drafts for this job on this tick. Any OTHER tailoring
  // failure (no key, a transient error) still proceeds to a handoff draft
  // with no tailored content, exactly like before this stage.
  if (canTailor) {
    try {
      const outcome = await verifyCvTailorDraft({ admin, unitConfig, jobId })
      tokensUsed += outcome.tokensUsed
      resumeSummary = outcome.resumeSummary
      coverLetter = outcome.coverLetter
      if (outcome.kind === 'judge-failed') {
        flaggedVerdict = { verdict: 'fail', rationale: outcome.verdict.summary }
      } else if (outcome.kind === 'unjudged') {
        flaggedVerdict = { verdict: 'unjudged', rationale: null }
      }
    } catch (e) {
      if (isBudgetStop(e)) return { status: 'budget', tokensUsed }
      if (e instanceof CvTailorContainmentError) return { status: 'failed', tokensUsed }
      // Anything else here is NOT one of verifyCvTailorDraft's typed outcomes
      // (its own judge failures already return 'unjudged', logged at their
      // own chokepoint — see cv-tailor.ts) — e.g. a DB read failing inside
      // loadJobFacts/loadResumeText/claimsFor. Still journal it (invariant:
      // no swallowed errors) before falling through to a handoff draft
      // without tailored content, exactly as before this stage.
      logHarnessError(
        { runId: unitConfig.configurable.runId, stepLabel: `tailor:${jobId}`, agentType: 'cv_tailor', phase: 'verify' },
        e
      )
    }
  }

  const autoSubmit = false
  try {
    const applyOut = await runAgentUnit('applier', {
      input: { jobId, resumeSummary, coverLetter, autoSubmit },
      admin,
      config: unitConfig,
      label: `apply:${jobId}`,
    })
    tokensUsed += applyOut.tokensUsed
    const out = applyOut.output as { draftId: string | null; status: string; submissionRef: string | null }

    // FLAG the persisted row (ruling 2c) — applier always persists
    // 'pending_review' for a non-submitted draft; a judge-failed verdict
    // overrides that to 'failed' (NEVER 'pending_review'), an unjudged one
    // leaves 'pending_review' standing but attaches a verdict a human review
    // gate can key off (see app/api/drafts/batch-approve/eligibility.ts).
    if (flaggedVerdict && out.draftId) {
      if (flaggedVerdict.verdict === 'fail') {
        await admin.from('application_drafts').update({ status: 'failed' }).eq('id', out.draftId)
      }
      await writeVerdict(admin, {
        userId: unitConfig.configurable.userId,
        runId: unitConfig.configurable.runId,
        subjectKind: 'cv_tailor_draft',
        subjectId: out.draftId,
        judge: 'factuality',
        verdict: flaggedVerdict.verdict,
        rationale: flaggedVerdict.rationale,
      })
      // A judge-failed draft never counts toward this tick's drafted quota —
      // it lands in the SAME 'failed' bucket a genuine apply failure does
      // (see runGoalTick's status==='failed' branch below), which already
      // excludes it from draftedThisTick and flags it in digest.failed.
      if (flaggedVerdict.verdict === 'fail') return { status: 'failed', tokensUsed }
    }

    if (out.status === 'submitted') return { status: 'submitted', tokensUsed }
    if (out.status === 'failed') return { status: 'failed', tokensUsed }
    return { status: 'drafted', tokensUsed } // pending_review with a prefilled handoff link
  } catch (e) {
    if (isBudgetStop(e)) return { status: 'budget', tokensUsed }
    return { status: 'failed', tokensUsed }
  }
}

/**
 * Out of money, one way or the other.
 *
 * BudgetExceededError is a task's own local per-tick allowance (see this
 * file's header BUDGET note); BudgetCapError is the MONTHLY spend cap
 * (lib/harness/spend.ts), reachable from inside runAgentUnit's own callLlm
 * call. Both mean the same thing to a draft attempt: stop spending, say why.
 */
function isBudgetStop(e: unknown): boolean {
  return e instanceof BudgetExceededError || e instanceof BudgetCapError
}

function makeDraftTask(jobId: string) {
  return task({ name: `draft:${jobId}` }, async (args: DraftTaskArgs): Promise<DraftTaskResult> => {
    return prepareApplicationDraft(args.unitConfig, args.canTailor, args.jobId)
  })
}

// --- shared source+score phase (both tick paths run this identically) -------

function toGoalCandidate(job: CandidateJob): GoalCandidate {
  return { id: job.id, title: job.title, description: job.description, location: job.location, matchScore: job.match_score }
}

/**
 * SOURCE (refresh the user's companies) + SCORE (the shared matcher path) +
 * load the candidate pool.
 *
 * Shared by the untargeted sweep and the goal tick ON PURPOSE. These two paths
 * differ in what they DO with candidates, not in how candidates come to exist,
 * and two copies of "how autopilot finds jobs" is exactly how the goal path
 * would quietly drift into scoring things differently from the digest cron —
 * the divergence lib/harness/agents/matcher.ts's header says centralising was
 * meant to prevent.
 */
async function sourceAndScore(
  admin: AdminClient,
  runId: string,
  userId: string,
  profile: ProfileRow,
  minScore: number,
  budgetRemaining: number,
  digest: AutopilotUserResult
): Promise<{ candidates: CandidateJob[]; tokensUsed: number }> {
  const companies = await loadCompanies(admin, userId)

  await journalStepStart(admin, { runId, label: 'autopilot-source', agentType: 'sourcer', input: { companyCount: Math.min(companies.length, MAX_COMPANIES_REFRESH) } })
  const sourced = await sourceTask({ companies })
  digest.discovered = sourced.discovered
  await journalStepFinish(admin, {
    runId,
    label: 'autopilot-source',
    agentType: 'sourcer',
    status: 'completed',
    output: { companiesRefreshed: sourced.refreshed, inserted: sourced.discovered },
    tokensUsed: 0,
  })

  // --- DEDUPE: jobs already drafted or applied -------------------------------
  const excluded = await loadExcludedJobIds(admin, userId)

  // --- SCORE: same shared code path as the harness matcher agent
  // (lib/harness/agents/matcher.ts) — this is what keeps autopilot and the
  // daily-digest cron from double-scoring or diverging in match quality.
  // Both filter `match_score is null` at the DB level, so whichever tick
  // gets to a job first claims it; both prefilter on quality/targeting
  // before spending a token.
  const companyIds = companies.map((c) => c.id)
  const targeting = resolveTargeting(profile.preferences)

  await journalStepStart(admin, { runId, label: 'autopilot-match', agentType: 'matcher', input: { companyCount: companyIds.length } })
  const scoreResult: ScoreTaskResult =
    companyIds.length > 0
      ? await scoreTask({ userId, companyIds, resume: profile.resume_text ?? '', targeting, limit: MAX_SCORE_PER_TICK, budgetRemaining, minScore, runId })
      : { scored: 0, failedCount: 0, candidatesConsidered: 0, skippedReason: 'no-companies', tokensUsed: 0 }
  digest.scored = scoreResult.scored
  await journalStepFinish(admin, {
    runId,
    label: 'autopilot-match',
    agentType: 'matcher',
    status: 'completed',
    output: {
      scored: scoreResult.scored,
      failed: scoreResult.failedCount,
      candidatesConsidered: scoreResult.candidatesConsidered,
      skippedReason: scoreResult.skippedReason,
      threshold: minScore,
    },
    tokensUsed: scoreResult.tokensUsed,
  })

  // Load ALL candidates (now including whatever was just scored above).
  const candidates = companyIds.length > 0 ? await loadCandidateJobs(admin, userId, excluded) : []
  return { candidates, tokensUsed: scoreResult.tokensUsed }
}

// --- the goal-directed tick --------------------------------------------------

/** Which of these jobs already have an application_draft — the DB's own answer
 *  to "is this one already prepared?". Used before re-drafting a carried-over
 *  keep, so a persist that failed after a successful draft costs one query
 *  rather than a duplicate draft and a second tailoring call. */
async function loadDraftedJobIds(admin: AdminClient, userId: string, jobIds: string[]): Promise<Set<string>> {
  if (jobIds.length === 0) return new Set()
  const { data } = await admin.from('application_drafts').select('job_id').eq('user_id', userId).in('job_id', jobIds)
  return new Set(((data ?? []) as { job_id: string }[]).map((r) => r.job_id).filter(Boolean))
}

function buildGoalDigest(goal: SearchGoal, judgedThisTick: number): AutopilotGoalDigest {
  const counts = goalCounts(goal)
  return {
    id: goal.id,
    statement: goal.statement,
    target: goal.targetCount,
    drafted: counts.drafted,
    kept: counts.kept,
    discarded: counts.discarded,
    judged: counts.judged,
    judgedThisTick,
    status: goal.status,
    stopReason: goal.stopReason,
    satisfied: counts.drafted >= goal.targetCount,
    summary: summarizeGoal(goal),
  }
}

/**
 * Advance one active goal by one tick. Returns the total tokens this tick
 * spent (source + score + judge + every draft) — the caller adds this to its
 * own running `spent` so finishRun records the true per-tick total.
 *
 * REPLAY SAFETY: every ledger write below (persistGoal) is either idempotent
 * by construction (mergeGoal unions judgements by jobId — see goals.ts) or
 * happens strictly AFTER the task whose result it records (judge, THEN
 * persist; draft, THEN recordDraftAttempt, THEN the final persist) — there is
 * no write here a re-execution of this function could duplicate, and (per
 * this file's header) this function's THREAD never gets re-executed anyway:
 * autopilot mints a fresh thread every tick, so nothing ever replays this
 * body against a partially-completed prior attempt.
 */
async function runGoalTick(
  admin: AdminClient,
  runId: string,
  userId: string,
  profile: ProfileRow,
  tickConfig: AutopilotConfig,
  unitConfig: UnitConfig,
  canTailor: boolean,
  goal: SearchGoal,
  digest: AutopilotUserResult
): Promise<number> {
  let spent = 0

  // 1) STOP BEFORE SPENDING. Every stopping condition is checked before the
  // tick sources, scores or judges anything — a satisfied or expired goal must
  // cost nothing at all to discover, since it will be re-discovered every hour
  // until a human looks at it.
  const pre = evaluateGoalProgress(goal, { now: new Date() })
  if (pre.shouldStop && pre.stopReason) {
    const concluded = concludeGoal(goal, pre.stopReason)
    const saved = await persistGoal(admin, userId, concluded)
    await journalStepStart(admin, { runId, label: 'autopilot-goal', agentType: 'planner', input: { goalId: saved.id, statement: saved.statement, target: saved.targetCount } })
    await journalStepFinish(admin, {
      runId,
      label: 'autopilot-goal',
      agentType: 'planner',
      status: 'completed',
      output: { stopped: true, stopReason: saved.stopReason, status: saved.status, summary: summarizeGoal(saved) },
      tokensUsed: 0,
    })
    digest.goal = buildGoalDigest(saved, 0)
    digest.message = summarizeGoal(saved)
    return spent
  }

  // 2) COUNT THE TICK DURABLY, BEFORE THE WORK. Same discipline as the
  // pre-port continuation_count mechanism: bump durably first, so a tick that
  // dies half way must still count against MAX_GOAL_TICKS, or a goal that
  // reliably crashes loops at full price forever.
  let g = await persistGoal(admin, userId, startTick(goal))

  // 3) Source + score, exactly as the untargeted sweep does.
  const sourced = await sourceAndScore(admin, runId, userId, profile, tickConfig.minScore, tickConfig.budgetTokens - spent, digest)
  spent += sourced.tokensUsed

  let budgetHit = false
  const toDraft: string[] = []

  // 4) FINISH WHAT WAS ALREADY PAID FOR: keeps from earlier ticks that never
  // became drafts. Judging cost money; drafting is what turns that spend into
  // something the user can actually approve, so it goes first in the tick.
  const pending = pendingDraftJobIds(g)
  if (pending.length > 0) {
    const alreadyDrafted = await loadDraftedJobIds(admin, userId, pending)
    for (const jobId of pending) {
      // A draft already exists (a previous tick drafted it and died before
      // persisting). Reconcile to the DB rather than drafting it twice; the
      // attempt counter ticks up because discovering this did cost a query.
      if (alreadyDrafted.has(jobId)) g = recordDraftAttempt(g, jobId, 'drafted')
      else toDraft.push(jobId)
    }
  }

  // 5) JUDGE fresh candidates — the keep/discard decision, with a written
  // rationale per candidate. Dedupe against everything this goal has ever
  // judged happens inside judgeCandidates; the allowance is what bounds spend.
  const resume = (profile.resume_text ?? '').trim() || '(no resume on file — judge against the goal statement alone and say so)'
  const goalCandidates = sourced.candidates.map(toGoalCandidate)
  const allowance = Math.min(pre.judgementAllowance, MAX_JUDGEMENTS_PER_TICK)

  await journalStepStart(admin, { runId, label: 'autopilot-goal-judge', agentType: 'matcher', input: { goalId: g.id, considered: goalCandidates.length, allowance } })
  const batch: JudgeTaskResult =
    allowance > 0
      ? await judgeTask({ userId, goal: g, candidates: goalCandidates, resume, allowance, budgetRemaining: tickConfig.budgetTokens - spent })
      : { goal: g, judged: [], tokensUsed: 0, stopped: null }
  spent += batch.tokensUsed
  g = batch.goal
  if (batch.stopped === 'budget') budgetHit = true

  const keptThisTick = batch.judged.filter((j) => j.decision === 'keep')
  for (const j of keptThisTick) toDraft.push(j.jobId)
  digest.eligible = keptThisTick.length

  await journalStepFinish(admin, {
    runId,
    label: 'autopilot-goal-judge',
    agentType: 'matcher',
    status: 'completed',
    output: {
      judged: batch.judged.length,
      kept: keptThisTick.length,
      stopped: batch.stopped,
      // The auditable record, in the run journal as well as the goal ledger:
      // every decision this tick made and the reason it gave.
      decisions: batch.judged.map((j) => ({
        jobId: j.jobId,
        title: j.title,
        decision: j.decision,
        rationale: j.rationale,
        confidence: j.confidence,
        unresolved: j.unresolved ?? false,
      })),
    },
    tokensUsed: batch.tokensUsed,
  })

  // Persist the ledger BEFORE drafting. Judging is the expensive half of a
  // tick; drafting is the half most likely to die on a serverless deadline. If
  // the two shared one write at the end of the tick, a drafting failure would
  // throw away up to a tick's worth of judgements that were already paid for,
  // and the next tick would buy them again.
  g = await persistGoal(admin, userId, g)

  // 6) PREPARE APPLICATIONS for the keeps — never more than the goal still
  // needs, and never more than one tick's action cap.
  const draftBudget = Math.min(pre.draftAllowance, MAX_ACTIONS_PER_TICK)
  let draftedThisTick = 0
  for (const jobId of toDraft.slice(0, Math.max(0, draftBudget))) {
    if (budgetHit || spent >= tickConfig.budgetTokens) {
      budgetHit = true
      break
    }
    const draftTaskFn = makeDraftTask(jobId)
    const { status, tokensUsed } = await draftTaskFn({ unitConfig, canTailor, jobId })
    spent += tokensUsed
    if (status === 'budget') {
      budgetHit = true
      break
    }
    if (status === 'failed') {
      g = recordDraftAttempt(g, jobId, 'failed')
      digest.failed! += 1
    } else {
      // 'submitted' is unreachable (prepareApplicationDraft hardcodes
      // autoSubmit=false); counted honestly rather than silently re-filed.
      if (status === 'submitted') digest.submitted! += 1
      else digest.handoff! += 1
      g = recordDraftAttempt(g, jobId, 'drafted')
      draftedThisTick += 1
    }
  }

  // 7) Close the tick and re-evaluate: this is where a satisfied goal actually
  // becomes satisfied, and where a tick that found nothing new counts toward
  // the exhaustion stop.
  g = endTick(g, {
    candidatesSeen: goalCandidates.length,
    judged: batch.judged.length,
    drafted: draftedThisTick,
    tokensSpent: spent,
    // Couldn't reach a model at all: don't blame the corpus for it (see endTick).
    blocked: batch.stopped === 'no-llm' || batch.stopped === 'budget',
  })
  const post = evaluateGoalProgress(g, { now: new Date(), budgetExhausted: budgetHit })
  if (post.shouldStop && post.stopReason) g = concludeGoal(g, post.stopReason)

  const saved = await persistGoal(admin, userId, g)
  await journalStepStart(admin, { runId, label: 'autopilot-goal', agentType: 'planner', input: { goalId: saved.id, statement: saved.statement, target: saved.targetCount, tick: saved.progress.ticksUsed } })
  await journalStepFinish(admin, {
    runId,
    label: 'autopilot-goal',
    agentType: 'planner',
    status: 'completed',
    output: {
      status: saved.status,
      stopReason: saved.stopReason,
      judgedThisTick: batch.judged.length,
      keptThisTick: keptThisTick.length,
      drafted: goalCounts(saved).drafted,
      summary: summarizeGoal(saved),
    },
    tokensUsed: 0,
  })

  digest.budgetExhausted = budgetHit
  digest.goal = buildGoalDigest(saved, batch.judged.length)
  digest.message = summarizeGoal(saved)
  return spent
}

// --- DB helpers (plain reads/writes, no model calls — unchanged from the
// pre-port file) ---------------------------------------------------------

interface CandidateJob {
  id: string
  title: string | null
  description: string | null
  location: string | null
  url: string | null
  company_id: string | null
  match_score: number | null
}

async function loadCompanies(admin: AdminClient, userId: string): Promise<CompanyInput[]> {
  const { data } = await admin
    .from('companies')
    .select('id, name, domain, career_url, metadata, is_dream_company')
    .eq('user_id', userId)
    .order('is_dream_company', { ascending: false })
  return ((data ?? []) as Record<string, unknown>[]).map((c) => ({
    id: c.id as string,
    name: (c.name as string) ?? '',
    domain: (c.domain as string | null) ?? null,
    career_url: (c.career_url as string | null) ?? null,
    metadata: c.metadata,
  }))
}

async function loadExcludedJobIds(admin: AdminClient, userId: string): Promise<Set<string>> {
  const excluded = new Set<string>()
  const { data: drafts } = await admin.from('application_drafts').select('job_id').eq('user_id', userId)
  for (const r of (drafts ?? []) as { job_id: string }[]) if (r.job_id) excluded.add(r.job_id)
  const { data: apps } = await admin.from('applications').select('job_id').eq('user_id', userId)
  for (const r of (apps ?? []) as { job_id: string }[]) if (r.job_id) excluded.add(r.job_id)
  return excluded
}

/**
 * Which of these already-scored jobIds carry a verified-or-deterministically-
 * clean match_score verdict (lib/graph/verify/matcher.ts's deterministic
 * check or judgeMatchQuality sample) — Step 4, item 3's literal wording, a
 * true ALLOWLIST: a scored job needs a RECORDED non-'fail' eval_verdicts row
 * to be eligible, not merely the absence of a failing one.
 *
 * Every job scored going forward always gets a deterministic verdict (see
 * verifyMatchVerdict — unconditional in scoreJobBatch), so this is never a
 * gap for anything scored by this stage. The two gaps that predate it —
 * production scores from before the verify stage shipped, and demo/seed
 * jobs that write match_score directly (lib/access/fixtures/jobs.ts) — are
 * each closed by an explicit, honestly-labeled backfill instead of a runtime
 * exception: 20260818000004_backfill_match_verdicts.sql grandfathers real
 * pre-stage scores as 'pass', and lib/access/seed-demo.ts#buildDemoWorkspace
 * seeds a matching 'pass' row (judge='deterministic', provenance noted in
 * its rationale) alongside every demo job's match_score. A genuinely
 * unverified score — one that predates this stage's deploy AND wasn't
 * migrated — is excluded, which is the allowlist working as designed.
 */
async function loadVerifiedJobIds(admin: AdminClient, userId: string, jobIds: string[]): Promise<Set<string>> {
  if (jobIds.length === 0) return new Set()
  // Every row for these subjects, not pre-filtered by verdict — a job can
  // carry TWO rows (the unconditional deterministic check, plus a sampled
  // judgeMatchQuality closed_qa row), and a `.neq('verdict', 'fail')`
  // filter would wrongly admit a job whose deterministic row passed but
  // whose SAMPLED judge row failed, just because the passing row also
  // matched. Allowlist membership needs "at least one row, none of them
  // failing" computed per subject, not per row.
  const { data } = await admin
    .from('eval_verdicts')
    .select('subject_id, verdict')
    .eq('user_id', userId)
    .eq('subject_kind', 'match_score')
    .in('subject_id', jobIds)
  const rows = (data ?? []) as { subject_id: string; verdict: string }[]
  const seen = new Set<string>()
  const failed = new Set<string>()
  for (const r of rows) {
    seen.add(r.subject_id)
    if (r.verdict === 'fail') failed.add(r.subject_id)
  }
  return new Set([...seen].filter((id) => !failed.has(id)))
}

async function loadCandidateJobs(admin: AdminClient, userId: string, excluded: Set<string>): Promise<CandidateJob[]> {
  // Order by recency so freshly discovered (unscored) jobs are always in the
  // window, not crowded out by a backlog of already-scored older postings.
  // Ownership via the companies FK join (ownedJobsQuery), not an
  // .in('company_id', companyIds) array — that breaks past ~600 companies.
  const { data } = await ownedJobsQuery(
    admin,
    userId,
    'id, title, description, location, url, company_id, match_score, companies!inner(user_id)'
  )
    .order('discovered_at', { ascending: false })
    .limit(CANDIDATE_JOB_LIMIT)
  const rows = (data ?? []) as unknown as CandidateJob[]
  const scoredIds = rows.filter((j) => j.match_score !== null).map((j) => j.id)
  const verified = await loadVerifiedJobIds(admin, userId, scoredIds)
  // Unscored jobs (match_score === null) pass this filter — they carry
  // nothing yet for a verdict to attach to, and the caller's own quality
  // gate (match_score >= minScore) excludes them from action-selection
  // downstream regardless (see runGoalTick/the untargeted sweep's `eligible`
  // filter). This predicate only ever needs to say no to an ALREADY-scored
  // job with no recorded pass.
  return rows.filter((j) => j.url && !excluded.has(j.id) && (j.match_score === null || verified.has(j.id)))
}

async function finishRun(admin: AdminClient, runId: string, spent: number, digest: AutopilotUserResult): Promise<void> {
  await admin
    .from('agent_runs')
    .update({ status: 'completed', spent_tokens: spent, result: digest as never, finished_at: new Date().toISOString() })
    .eq('id', runId)
}

// --- the entrypoint -----------------------------------------------------------

export interface AutopilotTickInput {
  /** The already-loaded profile row — the calling route already read
   *  `profiles` to decide which users are opted in (parseAutopilotConfig), so
   *  passing it straight through avoids a redundant fetch, the same choice
   *  lib/graph/refresh.ts makes for its own pre-loaded companyIds input. */
  profile: ProfileRow
}

export const autopilotTickGraph = entrypoint(
  {
    name: 'autopilotTick',
    // `true` defers the checkpointer to a per-call override — see
    // lib/graph/runs.ts's identical field for the verified-safe cast this
    // mirrors. Autopilot never interrupts (see this file's header), so the
    // checkpointer here only ever records ONE completed execution per
    // thread — but a fresh thread every tick still needs one to exist for
    // invokeGraphForUser's getState/invoke machinery to work at all.
    checkpointer: true as unknown as BaseCheckpointSaver,
  },
  async (input: AutopilotTickInput, config: LangGraphRunnableConfig): Promise<AutopilotUserResult> => {
    const profile = input.profile
    const userId = profile.id

    const invokerUserId = config.configurable?.userId
    const threadId = config.configurable?.threadId
    if (typeof invokerUserId !== 'string' || !invokerUserId) {
      throw new Error('autopilotTick: config.configurable.userId is required — see lib/graph/invoke.ts#invokeGraphForUser')
    }
    if (typeof threadId !== 'string' || !threadId) {
      throw new Error('autopilotTick: config.configurable.threadId is required — see lib/graph/invoke.ts#invokeGraphForUser')
    }
    // Anti-IDOR, defense-in-depth — mirrors lib/graph/runs.ts's own
    // RunOwnershipError check: invokeGraphForUser already verified the
    // calling user owns the graph THREAD; this catches a caller that passed
    // a mismatched profile as input for that thread.
    if (profile.id !== invokerUserId) {
      throw new AutopilotOwnershipError(profile.id, invokerUserId)
    }

    const admin: AdminClient = createAdminClient()
    const tickConfig = parseAutopilotConfig(profile.preferences)
    if (!tickConfig.enabled) {
      return { userId, skipped: 'disabled', message: 'autopilot disabled' }
    }

    const apiKeys = await loadApiKeys(admin, userId)
    const hasResume = !!profile.resume_text && profile.resume_text.trim().length > 0
    const canTailor = canRunLlm(apiKeys)
    if (!hasResume && !canTailor) {
      return { userId, skipped: 'no-resume', message: 'no resume and no usable LLM backend — nothing to do' }
    }

    // --- Create the journaling run --------------------------------------------
    const { data: run, error: runErr } = await admin
      .from('agent_runs')
      .insert({
        user_id: userId,
        goal: 'Autopilot: source, match, and apply to top jobs while the user is away.',
        status: 'running',
        budget_tokens: tickConfig.budgetTokens,
        started_at: new Date().toISOString(),
        thread_id: threadId,
      })
      .select('id')
      .single()
    if (runErr || !run) {
      return { userId, message: `failed to create run: ${runErr?.message ?? 'no row'}` }
    }
    const runId = (run as { id: string }).id

    let spent = 0
    const digest: AutopilotUserResult = {
      userId,
      runId,
      discovered: 0,
      scored: 0,
      eligible: 0,
      submitted: 0,
      handoff: 0,
      failed: 0,
      capReached: false,
      budgetExhausted: false,
      message: '',
    }
    const unitConfig: UnitConfig = { configurable: { userId, runId, threadId } }

    try {
      // --- GOAL-DIRECTED TICK ------------------------------------------------
      // An active goal owns the tick: it decides what is worth judging, records
      // WHY each candidate was kept or dropped, and stops on its own terms. With
      // no active goal this is skipped entirely and the untargeted sweep below
      // runs exactly as it always has.
      const goal = activeGoal(readGoals(profile.preferences))
      if (goal) {
        spent += await runGoalTick(admin, runId, userId, profile, tickConfig, unitConfig, canTailor, goal, digest)
        await finishRun(admin, runId, spent, digest)
        return digest
      }

      // --- DAILY CAP: submissions in the rolling 24h window -------------------
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const { count: submitted24h } = await admin
        .from('application_drafts')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('status', 'submitted')
        .gte('submitted_at', since)
      let remainingCap = tickConfig.dailyCap - (submitted24h ?? 0)

      // --- SOURCE + SCORE + load candidates (shared with the goal path) ------
      const sourced = await sourceAndScore(admin, runId, userId, profile, tickConfig.minScore, tickConfig.budgetTokens - spent, digest)
      spent += sourced.tokensUsed

      // --- QUALITY GATE: eligible = score >= minScore, best first ------------
      const eligible = sourced.candidates
        .filter((j) => (j.match_score ?? -1) >= tickConfig.minScore)
        .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
        .slice(0, MAX_ACTIONS_PER_TICK)
      digest.eligible = eligible.length

      if (eligible.length === 0) {
        digest.message = `No new eligible matches (>= ${tickConfig.minScore}). Discovered ${digest.discovered}, scored ${digest.scored}.`
        await finishRun(admin, runId, spent, digest)
        return digest
      }

      // --- ACT: tailor + apply, honoring cap + budget ------------------------
      for (const job of eligible) {
        if (spent >= tickConfig.budgetTokens) {
          digest.budgetExhausted = true
          break
        }

        const draftTaskFn = makeDraftTask(job.id)
        const { status, tokensUsed } = await draftTaskFn({ unitConfig, canTailor, jobId: job.id })
        spent += tokensUsed
        if (status === 'budget') {
          digest.budgetExhausted = true
          break
        }
        if (status === 'submitted') {
          // Unreachable while prepareApplicationDraft hardcodes autoSubmit=false
          // (applier only reports 'submitted' when it was told to submit). Kept
          // so the accounting stays honest rather than silently mis-filing a
          // status this file does not expect to ever see.
          digest.submitted! += 1
          remainingCap -= 1
          if (remainingCap <= 0) {
            digest.capReached = true
            digest.message = `Daily cap reached after ${digest.submitted} submission(s).`
            break
          }
        } else if (status === 'failed') {
          digest.failed! += 1
        } else {
          digest.handoff! += 1 // pending_review with a prefilled handoff link
        }
      }

      if (!digest.message) {
        const parts = [`Submitted ${digest.submitted}, queued ${digest.handoff} for review, ${digest.failed} failed.`]
        if (digest.budgetExhausted) parts.push('Token budget exhausted this tick.')
        if (remainingCap <= 0) parts.push('Daily submission cap reached.')
        digest.message = parts.join(' ')
      }

      await finishRun(admin, runId, spent, digest)
      return digest
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      digest.message = `error: ${message}`
      await admin
        .from('agent_runs')
        .update({ status: 'failed', error: message, spent_tokens: spent, finished_at: new Date().toISOString() })
        .eq('id', runId)
      return digest
    }
  }
)
