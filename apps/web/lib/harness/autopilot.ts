// CONTINUOUS AUTOPILOT ENGINE.
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
// to `runAgentStep('applier', ...)` below is hardcoded `false`. An actual
// submission always requires a SEPARATE, explicit, human-initiated action
// after the fact (lib/harness/chains.ts#buildSubmitConfirmedPlan, which
// refuses to compile without a literal `confirmed:true` the caller supplies,
// invoked from the apply UI — never from this cron path).
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

import {
  refreshCompany,
  mapWithConcurrency,
  type AtsStore,
  type CompanyInput,
  type JobUpsertRow,
} from '@/lib/ats'
import { resolveTargeting } from '@/lib/targeting'
import { loadApiKeys } from './keys'
import { callLlm } from './llm'
import { canRunLlm } from './llm-key-message'
import { agentSchemas } from './schemas'
import { cv_tailor } from './agents/cv_tailor'
import { applier } from './agents/applier'
import { scoreJobBatch } from './agents/matcher'
import {
  BudgetExceededError,
  type AdminClient,
  type DecryptedApiKeys,
  type LlmResult,
  type LlmRunOptions,
  type StepAgentType,
  type StepContext,
} from './types'

// --- tunables ---------------------------------------------------------------
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

export interface AutopilotConfig {
  enabled: boolean
  dailyCap: number
  minScore: number
  budgetTokens: number
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
  message: string
}

export interface AutopilotTickResult {
  ok: true
  enabledUsers: number
  processed: number
  results: AutopilotUserResult[]
}

interface ProfileRow {
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

/**
 * Run one autopilot tick across all opted-in users (bounded batch). Safe to call
 * on any schedule; guardrails make repeated calls idempotent-ish (dedupe + caps).
 */
export async function runAutopilotTick(admin: AdminClient): Promise<AutopilotTickResult> {
  const { data: profiles, error } = await admin
    .from('profiles')
    .select('id, full_name, email, resume_text, preferences')
  if (error) throw new Error(`autopilot: failed to load profiles: ${error.message}`)

  const enabled = ((profiles ?? []) as ProfileRow[]).filter(
    (p) => parseAutopilotConfig(p.preferences).enabled
  )
  const batch = enabled.slice(0, MAX_USERS_PER_TICK)

  const results = await mapWithConcurrency(batch, USER_CONCURRENCY, (p) =>
    runAutopilotForUser(admin, p).catch(
      (e): AutopilotUserResult => ({
        userId: p.id,
        message: `error: ${e instanceof Error ? e.message : String(e)}`,
      })
    )
  )

  return { ok: true, enabledUsers: enabled.length, processed: batch.length, results }
}

/** The per-user engine. Never throws for expected conditions — returns a digest. */
export async function runAutopilotForUser(
  admin: AdminClient,
  profile: ProfileRow
): Promise<AutopilotUserResult> {
  const userId = profile.id
  const config = parseAutopilotConfig(profile.preferences)
  if (!config.enabled) {
    return { userId, skipped: 'disabled', message: 'autopilot disabled' }
  }

  const apiKeys = await loadApiKeys(admin, userId)
  const hasResume = !!profile.resume_text && profile.resume_text.trim().length > 0
  if (!hasResume && !canRunLlm(apiKeys)) {
    return { userId, skipped: 'no-resume', message: 'no resume and no usable LLM backend — nothing to do' }
  }

  // --- Create the journaling run --------------------------------------------
  const { data: run, error: runErr } = await admin
    .from('agent_runs')
    .insert({
      user_id: userId,
      goal: 'Autopilot: source, match, and apply to top jobs while the user is away.',
      status: 'running',
      budget_tokens: config.budgetTokens,
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (runErr || !run) {
    return { userId, message: `failed to create run: ${runErr?.message ?? 'no row'}` }
  }
  const runId = (run as { id: string }).id

  // Budget metering shared across all LLM calls this tick.
  const controller = new AbortController()
  let spent = 0
  const llm = async (opts: LlmRunOptions): Promise<LlmResult> => {
    if (controller.signal.aborted) throw new BudgetExceededError()
    const res = await callLlm(apiKeys, opts, controller.signal)
    spent += res.tokensUsed
    if (spent > config.budgetTokens) {
      controller.abort()
      throw new BudgetExceededError()
    }
    return res
  }

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

  try {
    // --- DAILY CAP: submissions in the rolling 24h window -------------------
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { count: submitted24h } = await admin
      .from('application_drafts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'submitted')
      .gte('submitted_at', since)
    let remainingCap = config.dailyCap - (submitted24h ?? 0)

    // --- SOURCE: refresh jobs from the user's companies --------------------
    const companies = await loadCompanies(admin, userId)
    const store = makeAdminStore(admin)
    const toRefresh = companies.slice(0, MAX_COMPANIES_REFRESH)
    const refreshResults = await mapWithConcurrency(toRefresh, 5, (c) =>
      refreshCompany(store, c).catch(() => null)
    )
    const discovered = refreshResults.reduce((s, r) => s + (r?.inserted ?? 0), 0)
    digest.discovered = discovered
    await journalStep(admin, runId, 'sourcer', 'autopilot-source', { companyCount: toRefresh.length }, {
      companiesRefreshed: toRefresh.length,
      inserted: discovered,
    })

    // --- DEDUPE: jobs already drafted or applied ---------------------------
    const excluded = await loadExcludedJobIds(admin, userId)

    // --- SCORE: same shared code path as the harness matcher agent
    // (lib/harness/agents/matcher.ts) — this is what keeps autopilot and the
    // daily-digest cron from double-scoring or diverging in match quality.
    // Both filter `match_score is null` at the DB level, so whichever tick
    // gets to a job first claims it; both prefilter on quality/targeting
    // before spending a token.
    const companyIds = companies.map((c) => c.id)
    const targeting = resolveTargeting(profile.preferences)
    const scoreBatch =
      companyIds.length > 0
        ? await scoreJobBatch({
            admin,
            userId,
            companyIds,
            resume: profile.resume_text ?? '',
            targeting,
            llm,
            limit: MAX_SCORE_PER_TICK,
            signal: controller.signal,
          })
        : { scored: [], failedCount: 0, candidatesConsidered: 0, skippedReason: 'no-companies' as const }

    digest.scored = scoreBatch.scored.length
    await journalStep(
      admin,
      runId,
      'matcher',
      'autopilot-match',
      { candidateCount: scoreBatch.candidatesConsidered },
      {
        scored: scoreBatch.scored.length,
        failed: scoreBatch.failedCount,
        skippedReason: scoreBatch.skippedReason,
        threshold: config.minScore,
      }
    )

    // --- Load ALL candidates (now including whatever was just scored above)
    // for the eligibility/apply gate below.
    const candidates = companyIds.length > 0 ? await loadCandidateJobs(admin, companyIds, excluded) : []

    // --- QUALITY GATE: eligible = score >= minScore, best first ------------
    const eligible = candidates
      .filter((j) => (j.match_score ?? -1) >= config.minScore)
      .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
      .slice(0, MAX_ACTIONS_PER_TICK)
    digest.eligible = eligible.length

    if (eligible.length === 0) {
      digest.message = `No new eligible matches (>= ${config.minScore}). Discovered ${discovered}, scored ${digest.scored}.`
      await finishRun(admin, runId, spent, digest)
      return digest
    }

    // --- ACT: tailor + apply, honoring cap + budget ------------------------
    for (const job of eligible) {
      if (controller.signal.aborted || spent >= config.budgetTokens) {
        digest.budgetExhausted = true
        break
      }

      // Tailor (best-effort; needs an LLM key). Failure → still create handoff.
      let resumeSummary: string | undefined
      let coverLetter: string | undefined
      if (canRunLlm(apiKeys)) {
        try {
          const tailorOut = await runAgentStep(
            { admin, userId, runId, apiKeys, llm, signal: controller.signal },
            'cv_tailor',
            `tailor:${job.id}`,
            { jobId: job.id },
            {}
          )
          const out = tailorOut as { resumeSummary?: string; coverLetter?: string }
          resumeSummary = out.resumeSummary
          coverLetter = out.coverLetter
        } catch (e) {
          if (e instanceof BudgetExceededError) {
            digest.budgetExhausted = true
            break
          }
          // tailoring failed — proceed to handoff draft without tailored content
        }
      }

      // SAFETY: autopilot NEVER auto-submits — see the file header. This
      // unattended cron path always builds a `pending_review` draft with a
      // handoff link; a real submission requires a separate, explicit,
      // human-confirmed action outside this file
      // (lib/harness/chains.ts#buildSubmitConfirmedPlan). `remainingCap` is
      // still tracked below purely as an informational digest signal.
      // Hardcoded false ON PURPOSE, and NOT read from
      // lib/automation/capabilities.ts. That module governs what the UI may
      // OFFER; this is a second, independent lock so that flipping a UI
      // constant can never by itself start firing irreversible applications at
      // real employers from an unattended cron. Two locks for an action that
      // cannot be undone.
      const autoSubmit = false
      try {
        const applyOut = (await runAgentStep(
          { admin, userId, runId, apiKeys, llm, signal: controller.signal },
          'applier',
          `apply:${job.id}`,
          { jobId: job.id, resumeSummary, coverLetter, autoSubmit },
          {}
        )) as { status: string; submissionRef: string | null }

        if (applyOut.status === 'submitted') {
          digest.submitted! += 1
          remainingCap -= 1
          if (remainingCap <= 0) {
            digest.capReached = true
            digest.message = `Daily cap reached after ${digest.submitted} submission(s).`
            break
          }
        } else if (applyOut.status === 'failed') {
          digest.failed! += 1
        } else {
          digest.handoff! += 1 // pending_review with a prefilled handoff link
        }
      } catch (e) {
        if (e instanceof BudgetExceededError) {
          digest.budgetExhausted = true
          break
        }
        digest.failed! += 1
      }
    }

    if (!digest.message) {
      const parts = [
        `Submitted ${digest.submitted}, queued ${digest.handoff} for review, ${digest.failed} failed.`,
      ]
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

// --- run one owned agent as a journaled step (mini-executor) ------------------

interface MiniCtx {
  admin: AdminClient
  userId: string
  runId: string
  apiKeys: DecryptedApiKeys
  llm: (opts: LlmRunOptions) => Promise<LlmResult>
  signal: AbortSignal
}

async function runAgentStep(
  base: MiniCtx,
  agentType: 'cv_tailor' | 'applier',
  label: string,
  input: unknown,
  deps: Record<string, unknown>
): Promise<unknown> {
  const stepId = await insertStep(base.admin, base.runId, agentType, label, input)
  const ctx: StepContext = {
    userId: base.userId,
    runId: base.runId,
    stepLabel: label,
    agentType: agentType as StepAgentType,
    input,
    deps,
    admin: base.admin,
    apiKeys: base.apiKeys,
    llm: base.llm,
    signal: base.signal,
  }
  const agent = agentType === 'cv_tailor' ? cv_tailor : applier
  try {
    const result = await agent(ctx)
    const schema = agentSchemas[agentType].output
    const parsed = schema.safeParse(result.output)
    if (!parsed.success) {
      throw new Error(`output failed schema: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
    }
    if (stepId) await finishStep(base.admin, stepId, 'completed', parsed.data)
    return parsed.data
  } catch (e) {
    if (stepId) {
      await finishStep(base.admin, stepId, 'failed', {
        error: e instanceof Error ? e.message : String(e),
      })
    }
    throw e
  }
}

// --- DB helpers --------------------------------------------------------------

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
  const { data: drafts } = await admin
    .from('application_drafts')
    .select('job_id')
    .eq('user_id', userId)
  for (const r of (drafts ?? []) as { job_id: string }[]) if (r.job_id) excluded.add(r.job_id)
  const { data: apps } = await admin.from('applications').select('job_id').eq('user_id', userId)
  for (const r of (apps ?? []) as { job_id: string }[]) if (r.job_id) excluded.add(r.job_id)
  return excluded
}

async function loadCandidateJobs(
  admin: AdminClient,
  companyIds: string[],
  excluded: Set<string>
): Promise<CandidateJob[]> {
  // Order by recency so freshly discovered (unscored) jobs are always in the
  // window, not crowded out by a backlog of already-scored older postings.
  const { data } = await admin
    .from('jobs')
    .select('id, title, description, location, url, company_id, match_score')
    .in('company_id', companyIds)
    .order('discovered_at', { ascending: false })
    .limit(CANDIDATE_JOB_LIMIT)
  return ((data ?? []) as CandidateJob[]).filter((j) => j.url && !excluded.has(j.id))
}

/** Admin (service-role) AtsStore — same contract as the /api/jobs/refresh store. */
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

// --- journaling --------------------------------------------------------------

async function insertStep(
  admin: AdminClient,
  runId: string,
  agentType: string,
  label: string,
  input: unknown
): Promise<string | null> {
  const { data, error } = await admin
    .from('agent_steps')
    .insert({ run_id: runId, agent_type: agentType, label, status: 'running', input, started_at: new Date().toISOString() })
    .select('id')
    .single()
  if (error) {
    console.error(`[autopilot] failed to insert step ${label}: ${error.message}`)
    return null
  }
  return (data as { id: string }).id
}

async function finishStep(
  admin: AdminClient,
  stepId: string,
  status: 'completed' | 'failed',
  output: unknown
): Promise<void> {
  await admin
    .from('agent_steps')
    .update({ status, output, finished_at: new Date().toISOString() })
    .eq('id', stepId)
}

/** Insert an already-finished journal step (for sourcer/matcher summaries). */
async function journalStep(
  admin: AdminClient,
  runId: string,
  agentType: string,
  label: string,
  input: unknown,
  output: unknown
): Promise<void> {
  await admin.from('agent_steps').insert({
    run_id: runId,
    agent_type: agentType,
    label,
    status: 'completed',
    input,
    output,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  })
}

async function finishRun(
  admin: AdminClient,
  runId: string,
  spent: number,
  digest: AutopilotUserResult
): Promise<void> {
  await admin
    .from('agent_runs')
    .update({
      status: 'completed',
      spent_tokens: spent,
      result: digest as never,
      finished_at: new Date().toISOString(),
    })
    .eq('id', runId)
}
