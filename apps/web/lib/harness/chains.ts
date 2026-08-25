// Harness runtime — chains: reusable goal templates that compile DIRECTLY to a
// validated Plan for the executor (./executor.ts), bypassing the LLM planner
// entirely (see how app/api/harness/run/route.ts sets agent_runs.plan before
// calling runAgentRun — executor.ts only invokes planGoal() when a run has no
// plan yet). A chain is a pure function: untrusted params in, a PlanSchema-
// valid Plan out (or a thrown ZodError/Error on bad params) — no DB, no LLM,
// no next/* imports, mirroring ./dynamic.ts's own "pure orchestration logic"
// philosophy so every chain here is unit-testable and framework-free.
//
// A chain is built ONLY from the 9 executable agent_type step primitives
// (STEP_AGENT_TYPES) plus the engine's existing loop/fanOut spec — it never
// invents a 10th agent type. Where an agent's REAL implementation diverges
// from its declared schema (several do — see the per-chain comments below),
// the chain is built against the REAL behavior, with the gap called out
// explicitly rather than silently assumed away.
//
// DEGRADE CONTRACT: every chain relies on the engine's existing empty-upstream
// handling (lib/harness/dynamic.ts#firstEmptyUpstreamReason /
// #resolveFanOutItems) — a fan-out/step whose dependency produced nothing
// lands 'skipped' with a clear reason instead of crashing. Chains earn that
// behavior for free by depending on the right upstream step; nothing extra is
// needed here as long as dependsOn is wired correctly.
//
// SAFETY (non-negotiable, see submit-confirmed below): applying for a job is
// IRREVERSIBLE and public. apply-to-role NEVER sets autoSubmit. The ONLY chain
// that can produce a submitting step is submit-confirmed, and it refuses to
// compile at all without an explicit `confirmed: true` from the caller — the
// gate is enforced in code, not by convention.

import { z } from 'zod'
import { PlanSchema } from './schemas'
import type { Plan, PlanStep } from './types'

// --- a. APPLY-TO-ROLE (build phase — never submits) -------------------------
//
// source -> match -> [fan out per top job: tailor CV -> build application] ->
// verify. Produces `pending_review` drafts for a human to look at; the only
// way any of them gets submitted is a separate submit-confirmed run (below).
//
// FAN-OUT LIMITATION (documented, not silently papered over): the executor
// only exposes a fan-out step's AGGREGATE output ({fannedOut,completed,failed,
// childLabels}) to steps that depend on it — never each child's own output
// (see lib/harness/executor.ts#runFanOutStep). So `apply`'s children do not
// automatically receive `tailor`'s per-job resumeSummary/coverLetter through
// ctx.deps; applier.ts's own resolveContent() falls back to the user's raw
// profile resume when no tailored content is found on a dep. `apply` still
// depends on `tailor` (ordering only) so drafts are never built before their
// CV has at least been attempted. Wiring per-child fan-out output through to
// sibling steps would need a small engine change (lib/harness/executor.ts /
// dynamic.ts) that is out of this chain-compiler's file scope.

export const ApplyToRoleParams = z.object({
  /** Free-text role/keyword query handed to the sourcer (e.g. "staff backend"). */
  roleQuery: z.string().trim().min(1).max(300).optional(),
  /** Restrict sourcing to specific tracked companies. */
  companyIds: z.array(z.string().min(1)).max(50).optional(),
  /** How many jobs the sourcer should look for. */
  sourceLimit: z.number().int().positive().max(200).optional(),
  /** How many top matches to tailor + build drafts for (fan-out width). */
  topN: z.number().int().positive().max(10).optional(),
})
export type ApplyToRoleParams = z.infer<typeof ApplyToRoleParams>

export function buildApplyToRolePlan(rawParams: unknown): Plan {
  const p = ApplyToRoleParams.parse(rawParams ?? {})
  const topN = p.topN ?? 5
  const sourceLimit = p.sourceLimit ?? 40

  const steps: PlanStep[] = [
    {
      label: 'source',
      agent_type: 'sourcer',
      input: { query: p.roleQuery, companyIds: p.companyIds, limit: sourceLimit },
      dependsOn: [],
    },
    // matcher pulls its candidate jobIds from ANY dep output's `.jobIds` field
    // (lib/harness/agents/matcher.ts#collectJobIds) — no need to thread the id
    // list through `input` by hand.
    { label: 'match', agent_type: 'matcher', input: {}, dependsOn: ['source'] },
    {
      label: 'tailor',
      agent_type: 'cv_tailor',
      input: {},
      dependsOn: ['match'],
      fanOut: { overDep: 'match', overKey: 'topJobIds', itemKey: 'jobId', maxChildren: topN },
    },
    {
      label: 'apply',
      agent_type: 'applier',
      // autoSubmit is NEVER true here — see buildSubmitConfirmedPlan, the only
      // chain that can submit, gated on an explicit human confirmation.
      input: { autoSubmit: false },
      dependsOn: ['match', 'tailor'],
      fanOut: { overDep: 'match', overKey: 'topJobIds', itemKey: 'jobId', maxChildren: topN },
    },
    {
      // KNOWN SCHEMA/IMPLEMENTATION GAP: verifier's declared contract
      // (VerifierInput{draftId}) suggests it checks a DRAFT's completeness,
      // but its real implementation (lib/harness/agents/verifier.ts) checks
      // JOB POSTING liveness/consistency/dedupe collisions and never reads
      // draftId at all. Positioned here (after `apply`, right before a human
      // is asked to confirm) it still serves the intended purpose of the slot
      // — one last check before the irreversible step — just on the postings
      // backing the drafts rather than the drafts themselves. `dependsOn`
      // includes 'source' (not 'match') because verifier's own dep-scanning
      // only recognizes a `.jobIds` field, and SourcerOutput has one;
      // MatcherOutput's array field is named `topJobIds`.
      label: 'verify',
      agent_type: 'verifier',
      input: {},
      dependsOn: ['source', 'apply'],
    },
  ]

  return PlanSchema.parse({
    goal:
      `Apply to role${p.roleQuery ? `: ${p.roleQuery}` : ''} — source, match, and build up to ${topN} ` +
      'application draft(s) for human review (never auto-submits)',
    steps,
  })
}

// --- a2. SUBMIT-CONFIRMED — the ONLY chain that can submit -------------------
//
// Takes the exact job ids a human reviewed and approved (typically the
// `pending_review` drafts apply-to-role just built) and submits ONLY those.
// `confirmed: true` must be present and literal — there is no default, no
// inference from a prior run, nothing implicit. Every submit step is a
// distinct, statically-named DAG node (`submit-1`, `submit-2`, ...) rather
// than a generic fan-out, so each one is individually visible/auditable in
// agent_steps with its own jobId baked into its journaled input — job ids are
// already fully known at compile time here (the human supplied them), so
// there is no dynamic-resolution reason to reach for fanOut.

export const SubmitConfirmedParams = z.object({
  jobIds: z.array(z.string().min(1)).min(1).max(20),
  /** Must be the literal `true` — see the safety note above. */
  confirmed: z.literal(true),
})
export type SubmitConfirmedParams = z.infer<typeof SubmitConfirmedParams>

export function buildSubmitConfirmedPlan(rawParams: unknown): Plan {
  const p = SubmitConfirmedParams.parse(rawParams ?? {})
  const jobIds = [...new Set(p.jobIds)]

  const steps: PlanStep[] = [
    // Re-check liveness one last time, immediately before the irreversible
    // action — see the same verifier note in buildApplyToRolePlan above.
    { label: 'pre-submit-check', agent_type: 'verifier', input: { jobIds }, dependsOn: [] },
    ...jobIds.map(
      (jobId, i): PlanStep => ({
        label: `submit-${i + 1}`,
        agent_type: 'applier' as const,
        input: { jobId, autoSubmit: true },
        dependsOn: ['pre-submit-check'],
      })
    ),
  ]

  return PlanSchema.parse({
    goal: `Submit ${jobIds.length} human-confirmed application(s)`,
    steps,
  })
}

// --- b. TAILOR-FOR-ROLE ------------------------------------------------------
//
// One job: research the company -> tailor the CV -> score the fit. No
// loop/fan-out — everything about a single-job chain is already known at
// compile time.
//
// "present diff" is NOT a DAG step: there is no dedicated diff/present agent
// among the 9 step types, and manufacturing one would mean inventing a 10th
// agent type outside this workstream's scope. The diff IS the pairing of this
// run's own step outputs — `tailor`'s {resumeSummary, coverLetter, keywords}
// against `ats-score`'s {matches[0].score, highlights, gaps} — rendering that
// pairing is a UI concern for whatever screen shows the run, not something
// this compiler needs to (or should) fabricate a step for.
//
// "ATS score" reuses `matcher`: there is no separate ATS-scoring agent, and
// matcher already produces the closest existing capability (an LLM fit
// verdict: score/matchedSkills/missingSkills against ONE job). It scores the
// user's STORED resume (profiles.resume_text), not the just-tailored text
// from `tailor` — no agent recomputes a score against ad hoc tailored text
// today. `ats-score` depends on `tailor` for ordering only.

export const TailorForRoleParams = z.object({
  jobId: z.string().min(1),
  companyId: z.string().min(1),
})
export type TailorForRoleParams = z.infer<typeof TailorForRoleParams>

export function buildTailorForRolePlan(rawParams: unknown): Plan {
  const p = TailorForRoleParams.parse(rawParams ?? {})

  const steps: PlanStep[] = [
    { label: 'research', agent_type: 'company_researcher', input: { companyId: p.companyId }, dependsOn: [] },
    { label: 'tailor', agent_type: 'cv_tailor', input: { jobId: p.jobId }, dependsOn: ['research'] },
    { label: 'ats-score', agent_type: 'matcher', input: { jobIds: [p.jobId] }, dependsOn: ['tailor'] },
  ]

  return PlanSchema.parse({
    goal: `Tailor CV for job ${p.jobId} and score the fit`,
    steps,
  })
}

// --- c. WARM-INTRO — draft only, never send ----------------------------------
//
// One job: research the company -> find contacts there -> draft personalised
// outreach per contact. SAFETY: draft only. Nothing in this chain, in
// enricher.ts, or in follow_upper.ts sends anything to a real person —
// follow_upper only ever inserts a `follow_ups` row / returns a message
// string; there is no send capability anywhere in this path.
//
// KNOWN SCHEMA/IMPLEMENTATION GAP: follow_upper's declared contract
// (FollowUpperInput.contactId) is not read by its current implementation
// (lib/harness/agents/follow_upper.ts branches only on `applicationId`, and
// for a job with no application yet — the warm-intro case — falls back to
// scanning the user's stale ACTIVE applications, which is very unlikely to be
// this job). This chain fans out over discovered contacts as the DECLARED
// contract intends, but until follow_upper is extended to act on a per-
// contact input, `draft-outreach`'s children will mostly report "no active
// applications to follow up on" rather than a real per-contact draft. Flagged
// here for the outreach workstream rather than silently built around.

export const WarmIntroParams = z.object({
  jobId: z.string().min(1),
  companyId: z.string().min(1),
  maxContacts: z.number().int().positive().max(20).optional(),
})
export type WarmIntroParams = z.infer<typeof WarmIntroParams>

export function buildWarmIntroPlan(rawParams: unknown): Plan {
  const p = WarmIntroParams.parse(rawParams ?? {})
  const maxContacts = p.maxContacts ?? 5

  const steps: PlanStep[] = [
    { label: 'research', agent_type: 'company_researcher', input: { companyId: p.companyId }, dependsOn: [] },
    // A single jobId is enough — enricher resolves the job's own company_id
    // internally, which keeps `find-contacts.enriched` to exactly one entry
    // (index 0) for the fan-out below to target.
    { label: 'find-contacts', agent_type: 'enricher', input: { jobIds: [p.jobId] }, dependsOn: ['research'] },
    {
      label: 'draft-outreach',
      agent_type: 'follow_upper',
      input: {},
      dependsOn: ['find-contacts'],
      fanOut: {
        overDep: 'find-contacts',
        overKey: 'enriched.0.signals.insiderConnections',
        itemKey: 'contact',
        maxChildren: maxContacts,
      },
    },
  ]

  return PlanSchema.parse({
    goal: `Warm intro for job ${p.jobId}: research the company, find contacts, draft outreach (never sends)`,
    steps,
  })
}

// --- d. SOURCE-UNTIL — the concrete loop --------------------------------------
//
// Loops the sourcer until `targetCount` roles are found or `maxIterations` is
// hit — this is the loop the user asked for ("apply to 50 roles" previously
// failed because sourcing only ever ran once; the plan was static).
//
// LOOP-CONDITION CAVEAT (documented, not hidden): the engine's loop
// (lib/harness/dynamic.ts#runLoop) evaluates `until` against EACH ITERATION'S
// OWN output only — there is no cross-iteration running total built into the
// engine. sourcer.ts also takes no pagination/offset input, so repeat calls
// with the SAME static input tend toward near-duplicate results (dedupe drives
// `inserted` toward 0 on a second pass). Requesting `limit: targetCount` up
// front makes a single successful iteration the common case; the loop's real
// value is retrying past a transient per-source failure (one aggregator
// timing out) rather than accumulating a count across passes. The engine's
// own no-forward-progress guard (two iterations reporting the identical
// `jobIds.length`) stops the loop the moment further attempts stop helping,
// well before `maxIterations` if the source pool is exhausted.

export const SourceUntilParams = z.object({
  roleQuery: z.string().trim().min(1).max(300).optional(),
  companyIds: z.array(z.string().min(1)).max(50).optional(),
  // Capped at 200 to match SourcerInput.limit's own max (schemas.ts) — this
  // value is passed straight through as the sourcer step's `limit` input
  // (below), so anything higher than the agent's own cap would fail every
  // loop iteration's input validation with a raw zod dump instead of a clean
  // 400 at compile time.
  targetCount: z.number().int().positive().max(200),
  maxIterations: z.number().int().positive().max(10).optional(),
})
export type SourceUntilParams = z.infer<typeof SourceUntilParams>

export function buildSourceUntilPlan(rawParams: unknown): Plan {
  const p = SourceUntilParams.parse(rawParams ?? {})
  const maxIterations = p.maxIterations ?? 5

  const steps: PlanStep[] = [
    {
      label: 'source-loop',
      agent_type: 'sourcer',
      input: { query: p.roleQuery, companyIds: p.companyIds, limit: p.targetCount },
      dependsOn: [],
      loop: {
        maxIterations,
        until: { key: 'jobIds.length', op: 'gte', value: p.targetCount },
      },
    },
  ]

  return PlanSchema.parse({
    goal: `Source jobs until ${p.targetCount} found (up to ${maxIterations} attempt(s))`,
    steps,
  })
}

// --- registry -----------------------------------------------------------------

export const CHAIN_NAMES = [
  'apply-to-role',
  'submit-confirmed',
  'tailor-for-role',
  'warm-intro',
  'source-until',
] as const
export type ChainName = (typeof CHAIN_NAMES)[number]

export interface ChainDefinition {
  name: ChainName
  label: string
  description: string
  paramsSchema: z.ZodTypeAny
  compile: (params: unknown) => Plan
}

export const CHAINS: Record<ChainName, ChainDefinition> = {
  'apply-to-role': {
    name: 'apply-to-role',
    label: 'Apply to role',
    description:
      'source -> match -> [fan out per top job: tailor CV -> build application] -> verify. ' +
      'Builds pending_review drafts only — never submits. Pair with submit-confirmed.',
    paramsSchema: ApplyToRoleParams,
    compile: buildApplyToRolePlan,
  },
  'submit-confirmed': {
    name: 'submit-confirmed',
    label: 'Submit confirmed applications',
    description:
      'Submit ONLY the job ids a human explicitly reviewed and confirmed. Requires confirmed:true — ' +
      'refuses to compile without it.',
    paramsSchema: SubmitConfirmedParams,
    compile: buildSubmitConfirmedPlan,
  },
  'tailor-for-role': {
    name: 'tailor-for-role',
    label: 'Tailor for role',
    description: 'For one job: research the company -> tailor the CV -> score the fit.',
    paramsSchema: TailorForRoleParams,
    compile: buildTailorForRolePlan,
  },
  'warm-intro': {
    name: 'warm-intro',
    label: 'Warm intro',
    description:
      'For one job: research the company -> find contacts there -> draft personalised outreach per ' +
      'contact. Draft only — never sends.',
    paramsSchema: WarmIntroParams,
    compile: buildWarmIntroPlan,
  },
  'source-until': {
    name: 'source-until',
    label: 'Source until N roles',
    description: 'Loop the sourcer until targetCount roles are found or maxIterations is hit.',
    paramsSchema: SourceUntilParams,
    compile: buildSourceUntilPlan,
  },
}

/** Metadata only (no zod schema) — safe to hand straight to an API response. */
export function describeChains(): { name: ChainName; label: string; description: string }[] {
  return CHAIN_NAMES.map((name) => {
    const { label, description } = CHAINS[name]
    return { name, label, description }
  })
}

export function isChainName(value: string): value is ChainName {
  return (CHAIN_NAMES as readonly string[]).includes(value)
}

/** Compile a named chain's params into a validated Plan. Throws (ZodError or
 *  Error) on an unknown chain name or invalid params — callers (the route
 *  handler) turn that into a 400. */
export function compileChain(name: string, params: unknown): Plan {
  if (!isChainName(name)) {
    throw new Error(`unknown chain "${name}" — valid: ${CHAIN_NAMES.join(', ')}`)
  }
  return CHAINS[name].compile(params)
}
