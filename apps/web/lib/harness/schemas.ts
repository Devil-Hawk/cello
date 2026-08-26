// Harness runtime — zod schemas for every agent_type's input/output and for the
// planner-produced DAG. The executor validates each step's output against the
// matching `agentSchemas[type].output` before journaling it, so schema drift in
// an agent implementation surfaces as a failed step rather than corrupt data.

import { z } from 'zod'
import { REASONING_EFFORTS } from './types'

/**
 * Full agent_type enum (matches the agent_steps CHECK values) PLUS the five
 * graph-port stragglers (lib/graph/unit.ts#runAgentUnit — see UNIT_TYPES
 * below) that reach a model outside the DAG executor today: bulk_matcher,
 * digest, outreach, resume_optimizer, strategist. They earn a real
 * agentSchemas entry the same as the original ten — schema-checked and
 * journaled like everything else runAgentUnit wraps — WITHOUT being
 * plannable (see STEP_AGENT_TYPES below, which does not grow).
 */
export const AGENT_TYPES = [
  'planner',
  'sourcer',
  'matcher',
  'enricher',
  'cv_tailor',
  'applier',
  'verifier',
  'follow_upper',
  'interview_prep',
  'company_researcher',
  'contact_sourcer',
  'bulk_matcher',
  'digest',
  'outreach',
  'resume_optimizer',
  'strategist',
  'analyst',
  'coach',
] as const

export const AgentTypeSchema = z.enum(AGENT_TYPES)

/** Agent types allowed as executable DAG steps (planner builds the DAG). */
export const STEP_AGENT_TYPES = [
  'sourcer',
  'matcher',
  'enricher',
  'cv_tailor',
  'applier',
  'verifier',
  'follow_upper',
  'interview_prep',
  'company_researcher',
  'contact_sourcer',
] as const

export const StepAgentTypeSchema = z.enum(STEP_AGENT_TYPES)

/**
 * Every unit type lib/graph/unit.ts#runAgentUnit can run: the ten plannable
 * STEP_AGENT_TYPES plus the five stragglers that bypassed the executor
 * before the graph port (lib/harness/agents/bulk_matcher.ts, digest.ts,
 * outreach.ts, resume_optimizer.ts, strategist.ts — each still callable
 * directly by its own route/cron caller; runAgentUnit is a second, schema-
 * checked/metered/journaled door onto the SAME entry functions, not a
 * replacement for them). Deliberately NOT the same list as STEP_AGENT_TYPES —
 * that one is "what the planner may emit into a DAG", this one is "what
 * runAgentUnit knows how to run", and the five stragglers are real, callable
 * units without being plannable.
 */
export const UNIT_TYPES = [
  ...STEP_AGENT_TYPES,
  'bulk_matcher',
  'digest',
  'outreach',
  'resume_optimizer',
  'strategist',
  'analyst',
  'coach',
] as const

export const UnitTypeSchema = z.enum(UNIT_TYPES)

// --- Per-agent input/output --------------------------------------------------

// sourcer — discover/refresh jobs from tracked companies or a query.
export const SourcerInput = z.object({
  companyIds: z.array(z.string()).optional(),
  query: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
})
export const SourcerOutput = z.object({
  jobIds: z.array(z.string()),
  found: z.number().int().nonnegative(),
  inserted: z.number().int().nonnegative(),
  notes: z.string().optional(),
})

// matcher — score jobs against the user's resume.
export const MatcherInput = z.object({
  jobIds: z.array(z.string()).optional(),
})
export const MatcherOutput = z.object({
  matches: z.array(
    z.object({
      jobId: z.string(),
      score: z.number(),
      highlights: z.array(z.string()).default([]),
      gaps: z.array(z.string()).default([]),
    })
  ),
  topJobIds: z.array(z.string()).default([]),
  /**
   * Additive diagnostics (optional — old journaled rows won't have these).
   * Set whenever the step scored zero jobs, so a no-op is distinguishable from
   * "ran fine, nothing to do" vs "every attempt failed" in agent_steps without
   * digging through server logs. One of: 'no-resume' | 'no-companies' |
   * 'no-candidates' | 'no-candidates-after-targeting-filter' | 'no-llm-key' |
   * 'all N scoring attempt(s) failed: <last error>'.
   */
  skippedReason: z.string().optional(),
  /** How many candidate jobs were pulled from the DB before scoring/filtering. */
  candidatesConsidered: z.number().int().nonnegative().optional(),
})

// enricher — add signal (comp, insider connections, seniority) to jobs/companies.
export const EnricherInput = z.object({
  jobIds: z.array(z.string()).optional(),
  companyIds: z.array(z.string()).optional(),
})
export const EnricherOutput = z.object({
  enriched: z.array(
    z.object({
      jobId: z.string().optional(),
      companyId: z.string().optional(),
      signals: z.record(z.string(), z.unknown()).default({}),
    })
  ),
})

// cv_tailor — surface/rephrase (never fabricate) resume + cover letter for a job.
export const CvTailorInput = z.object({
  jobId: z.string(),
  resumeText: z.string().optional(),
  /** Set by lib/graph/verify/cv-tailor.ts's bounded retry loop when a prior
   *  attempt was rejected (containment or the factual-grounding judge) —
   *  fed into the prompt as corrective instruction. Absent on a first
   *  attempt. */
  correctiveContext: z.string().optional(),
})
export const CvTailorOutput = z.object({
  jobId: z.string(),
  resumeSummary: z.string(),
  coverLetter: z.string(),
  keywords: z.array(z.string()).default([]),
})

// applier — build an application_draft + handoff (never auto-POST past policy).
export const ApplierInput = z.object({
  jobId: z.string(),
  resumeSummary: z.string().optional(),
  coverLetter: z.string().optional(),
  answers: z.record(z.string(), z.unknown()).optional(),
  autoSubmit: z.boolean().optional(),
})
export const ApplierOutput = z.object({
  draftId: z.string().nullable(),
  status: z.enum(['pending_review', 'approved', 'submitted', 'rejected', 'failed']),
  handoffUrl: z.string().nullable().optional(),
  submissionRef: z.string().nullable().optional(),
})

// verifier — check a draft/submission for completeness + knock-out issues.
export const VerifierInput = z.object({
  draftId: z.string(),
})
export const VerifierOutput = z.object({
  verified: z.boolean(),
  issues: z.array(z.string()).default([]),
})

// follow_upper — draft a follow-up / outreach message from the user's own graph.
export const FollowUpperInput = z.object({
  applicationId: z.string().optional(),
  contactId: z.string().optional(),
})
export const FollowUpperOutput = z.object({
  message: z.string(),
  suggestedContacts: z.array(z.string()).default([]),
})

// interview_prep — build a per-job interview prep kit (questions + STAR stories).
export const InterviewPrepInput = z.object({
  jobId: z.string(),
  resumeText: z.string().optional(),
})
export const InterviewPrepOutput = z.object({
  kitId: z.string().nullable(),
  jobId: z.string(),
  questionCount: z.number().int().nonnegative(),
  starCount: z.number().int().nonnegative(),
  status: z.enum(['ready', 'practiced']).default('ready'),
  needsResume: z.boolean().optional(),
  needsKey: z.boolean().optional(),
})

// company_researcher — assemble a public-source company dossier + visa + comp.
export const CompanyResearcherInput = z.object({
  companyId: z.string(),
})
export const CompanyResearcherOutput = z.object({
  dossierId: z.string().nullable(),
  companyId: z.string(),
  sponsorsVisa: z.enum(['likely', 'unlikely', 'unknown']),
  hasSummary: z.boolean(),
  sourceCount: z.number().int().nonnegative(),
  partial: z.boolean().optional(),
})

// contact_sourcer — source PLAUSIBLE people/contacts at a company for a role
// (draft-supporting data only; see lib/harness/agents/contact_sourcer.ts —
// this agent never sends anything). Free path works with no external keys;
// Hunter/Apollo are opt-in BYOK enhancements.
export const ContactSourcerInput = z.object({
  companyId: z.string().min(1),
  jobId: z.string().min(1).optional(),
  limit: z.number().int().positive().max(25).optional(),
})
export const ContactSourcerOutput = z.object({
  companyId: z.string(),
  found: z.number().int().nonnegative(),
  inserted: z.number().int().nonnegative(),
  skippedExisting: z.number().int().nonnegative(),
  freePathOnly: z.boolean(),
  providers: z.array(
    z.object({
      provider: z.enum(['hunter', 'apollo']),
      ran: z.boolean(),
      reason: z.enum(['no-key', 'no-domain', 'error']).optional(),
      found: z.number().int().nonnegative(),
    })
  ),
  contactIds: z.array(z.string()),
  /**
   * Set whenever this step found/inserted nothing — mirrors matcher's
   * skippedReason contract (MatcherOutput above): "no candidates" is an
   * expected, clearly-labeled outcome here too, never a raw thrown error a
   * downstream step has to guess about.
   */
  skippedReason: z.string().optional(),
})

// --- Planner (goal -> DAG) ---------------------------------------------------

/** Hard cap on steps in a plan — enforced at initial planning AND at every
 *  mid-run replan extension (see ./replan.ts). Keeps a run auditable and its
 *  worst-case cost bounded. */
export const MAX_PLAN_STEPS = 24

/**
 * A declarative condition evaluated against a step's own JSON output, used by
 * `loop.until` (below) to decide whether to stop re-running the step. `key` is
 * a dot-path into the output (e.g. "found" or "matches.length" — ".length" on
 * an array path returns its length).
 */
export const LoopConditionSchema = z.object({
  key: z.string().min(1),
  op: z.enum(['gte', 'gt', 'lte', 'lt', 'eq', 'neq']),
  value: z.union([z.number(), z.string(), z.boolean()]),
})

/**
 * Per-step loop spec. The engine re-runs the step (same agent_type, same
 * static input) until `until` holds against the step's latest output, or
 * `maxIterations` is hit, or the run's budget/deadline is hit — whichever
 * comes first. `maxIterations` is a HARD cap (<=10): combined with the
 * forward-progress check in lib/graph/runs.ts#runLoopStep (two iterations in
 * a row producing the same `until.key` value stop the loop even if
 * `maxIterations` has not been reached yet), a loop can never spin forever.
 */
export const LoopSpecSchema = z.object({
  maxIterations: z.number().int().positive().max(10),
  until: LoopConditionSchema,
})

/**
 * Per-step fan-out spec: instead of running the step's agent once, the
 * engine resolves `overKey` (a dot-path) inside the `overDep` dependency's
 * output, expects an array, and runs one child invocation of THIS step's
 * agent_type per array element (each child's input is the step's static
 * `input` merged with `{ [itemKey]: <array element> }`). Children run with
 * bounded concurrency and a failed child never fails its siblings — see
 * lib/graph/runs.ts#runFanOutStep. `overDep` MUST be one of the step's own
 * `dependsOn` (enforced below) so the fan-out source is always ready before
 * the step runs.
 */
export const FanOutSpecSchema = z.object({
  overDep: z.string().min(1),
  overKey: z.string().min(1).default('items'),
  itemKey: z.string().min(1).default('item'),
  maxChildren: z.number().int().positive().max(20).default(10),
})

export const PlanStepSchema = z
  .object({
    /** Unique label within the plan; used as the dependency key. */
    label: z.string().min(1).max(80),
    agent_type: StepAgentTypeSchema,
    /** Static input for this step (agents also read dependency outputs). */
    input: z.unknown().optional(),
    /** Labels of steps that must complete before this one runs. */
    dependsOn: z.array(z.string()).default([]),
    /** Re-run this step until `until` holds (see LoopSpecSchema). Mutually
     *  exclusive with `fanOut`. */
    loop: LoopSpecSchema.optional(),
    /** Fan this step out into N parallel children over a dependency's list
     *  output (see FanOutSpecSchema). Mutually exclusive with `loop`. */
    fanOut: FanOutSpecSchema.optional(),
  })
  .superRefine((step, ctx) => {
    if (step.loop && step.fanOut) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `step "${step.label}" cannot combine loop and fanOut in the same step`,
      })
    }
    if (step.fanOut && !step.dependsOn.includes(step.fanOut.overDep)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `step "${step.label}" fanOut.overDep "${step.fanOut.overDep}" must be listed in dependsOn`,
      })
    }
  })

/**
 * DFS cycle detector over a step graph's `dependsOn` edges. Returns the cycle
 * as an ordered array of labels (e.g. ["a","b","a"]) or null when acyclic.
 * Unknown deps are ignored here — PlanSchema's superRefine reports those as a
 * separate issue so a cycle-through-a-typo doesn't produce a confusing
 * "cycle" message instead of the more actionable "unknown step" one.
 *
 * Exported for reuse: PlanSchema uses it to reject a bad initial plan; a
 * mid-run replan (lib/harness/replan.ts) uses it on the MERGED graph so an
 * extension can never sneak in a cycle either.
 */
export function detectCycle(steps: { label: string; dependsOn: string[] }[]): string[] | null {
  const depsByLabel = new Map(steps.map((s) => [s.label, s.dependsOn]))
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  const path: string[] = []
  let cyclePath: string[] | null = null

  function visit(label: string): void {
    if (cyclePath) return
    color.set(label, GRAY)
    path.push(label)
    for (const dep of depsByLabel.get(label) ?? []) {
      if (!depsByLabel.has(dep)) continue // unknown dep — reported separately
      const c = color.get(dep) ?? WHITE
      if (c === GRAY) {
        const idx = path.indexOf(dep)
        cyclePath = [...path.slice(idx), dep]
        return
      }
      if (c === WHITE) visit(dep)
      if (cyclePath) return
    }
    path.pop()
    color.set(label, BLACK)
  }

  for (const s of steps) {
    if ((color.get(s.label) ?? WHITE) === WHITE) visit(s.label)
    if (cyclePath) return cyclePath
  }
  return null
}

/**
 * SAFETY (structural, not prompt-based): strip any submission capability from
 * a set of steps that did NOT come from a trusted chain compiler (see
 * lib/harness/chains.ts#compileChain). `PlanStepSchema.input` is intentionally
 * `z.unknown()` (a step's input shape depends on its agent_type, which the
 * shared step schema doesn't specialize on), so nothing else here stops an
 * `applier` step from carrying `{autoSubmit:true}` if the JSON that produced
 * it says so. The ONLY two producers of a step's JSON are:
 *   1. lib/harness/chains.ts#compileChain — trusted, code-constructed; the
 *      ONE chain allowed to emit autoSubmit:true (submit-confirmed) requires
 *      a literal `confirmed:true` from the caller and is never routed through
 *      this function (see app/api/harness/run/route.ts, which writes a
 *      compiled chain's Plan straight to agent_runs.plan and skips the LLM
 *      planner entirely).
 *   2. lib/harness/planner.ts#planGoal — an LLM turning free text into JSON,
 *      and lib/harness/replan.ts#applyReplan — a step's own AgentResult
 *      (which may echo LLM output) requesting a mid-run graph extension.
 *      Both are untrusted for this specific purpose: nothing but this
 *      function stands between "the model wrote autoSubmit:true" and a real
 *      ATS POST (lib/harness/agents/applier.ts). Call this on every plan/step
 *      list from producer #2 before it is stored or executed.
 * Mutates nothing; returns new step objects only where a change was needed.
 */
type UntrustedStep = z.infer<typeof PlanStepSchema>
export function stripUntrustedSubmit(steps: UntrustedStep[]): UntrustedStep[] {
  return steps.map((step) => {
    if (step.agent_type !== 'applier') return step
    const input = step.input && typeof step.input === 'object' ? (step.input as Record<string, unknown>) : undefined
    if (!input || input.autoSubmit !== true) return step
    return { ...step, input: { ...input, autoSubmit: false } }
  })
}

export const PlanSchema = z
  .object({
    goal: z.string(),
    steps: z.array(PlanStepSchema).min(1).max(MAX_PLAN_STEPS),
  })
  .superRefine((plan, ctx) => {
    const labels = new Set<string>()
    for (const step of plan.steps) {
      if (labels.has(step.label)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate step label: ${step.label}` })
      }
      labels.add(step.label)
    }
    for (const step of plan.steps) {
      for (const dep of step.dependsOn) {
        if (!labels.has(dep)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `step "${step.label}" depends on unknown step "${dep}"`,
          })
        }
        if (dep === step.label) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `step "${step.label}" depends on itself` })
        }
      }
    }
    const cycle = detectCycle(plan.steps.map((s) => ({ label: s.label, dependsOn: s.dependsOn })))
    if (cycle) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `dependency cycle detected: ${cycle.join(' -> ')}`,
      })
    }
  })

/**
 * A step's request to extend the live run's graph (see lib/harness/replan.ts
 * for validation + application). An agent implementation may set this on its
 * AgentResult (`replanRequest`, alongside `output`) to append bounded,
 * validated follow-up steps — e.g. "I found 40 jobs, spawn a tailor step per
 * top match." Every proposed step goes through the SAME PlanStepSchema rules
 * as the initial plan (no cycles, no unknown deps, no duplicate labels) plus
 * the run's remaining step/token budget.
 */
export const ReplanRequestSchema = z.object({
  reason: z.string().min(1).max(500),
  steps: z.array(PlanStepSchema).min(1).max(8),
})

export const PlannerInput = z.object({
  goal: z.string(),
  context: z.record(z.string(), z.unknown()).optional(),
})

// --- The five graph-port stragglers ------------------------------------------
//
// bulk_matcher/digest/outreach/resume_optimizer reach a model today through
// their own exported entry function (called straight from app/api — see each
// file's own header) rather than through the DAG executor. Their zod shapes
// below are derived from what those existing callers actually pass/receive
// (app/api/agents/match/batch/route.ts, app/api/digest/send/route.ts +
// app/api/harness/cron/route.ts, app/api/outreach/draft+follow-up/route.ts,
// app/api/resume/optimize+documents/route.ts) — permissive-but-typed, per the
// graph-port spec's stage-1 scope; a stricter pass can follow once
// runAgentUnit is the only door onto these five (stage 1C).
// strategist already defines its own StrategistInput/StrategistOutput
// (lib/harness/agents/strategist.ts) — imported above rather than
// re-declared, so the schema stays byte-identical to the one that file's own
// AgentFn parses against.

// bulk_matcher — two-tier batch scoring (lib/harness/agents/bulk_matcher.ts#runBulkMatch).
export const BulkMatcherInput = z.object({
  companyIds: z.array(z.string()).optional(),
  jobIds: z.array(z.string()).optional(),
  limit: z.number().int().positive().max(2000).optional(),
  model: z.string().optional(),
  effort: z.enum(REASONING_EFFORTS).optional(),
  targetTitles: z.array(z.string()).optional(),
})
const JobScoreOutcomeSchema = z.object({
  jobId: z.string(),
  status: z.enum(['scored', 'no-verdict']),
  tier: z.union([z.literal(1), z.literal(2), z.null()]),
  score: z.number().nullable(),
  reason: z.string(),
  titleOnly: z.boolean(),
})
export const BulkMatcherOutput = z.object({
  scored: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  candidatesConsidered: z.number().int().nonnegative(),
  skippedReasons: z.record(z.string(), z.number()),
  batches: z.number().int().nonnegative(),
  tokensUsed: z.number().int().nonnegative(),
  jobOutcomes: z.array(JobScoreOutcomeSchema),
})

// digest — compose (+ best-effort send) today's digest (lib/harness/agents/digest.ts#composeAndStoreDigest).
// No `send` handler is accepted here — a graph-run context has no Gmail
// provider_token (request-context-only, same constraint the cron caller
// already has; see that file's header), so a unit run always degrades to
// compose-and-store, exactly like cron does.
export const DigestInput = z.object({
  force: z.boolean().optional(),
})
export const DigestOutput = z.object({
  userId: z.string(),
  outcome: z.enum(['sent', 'stored', 'skipped_disabled', 'skipped_already', 'error']),
  reason: z.string().optional(),
  empty: z.boolean().optional(),
})

// outreach — draft a cold-outreach / follow-up email (lib/harness/agents/outreach.ts#generateOutreachDraft).
export const OutreachInput = z.object({
  userName: z.string(),
  userEmail: z.string(),
  jobTitle: z.string(),
  companyName: z.string(),
  contactName: z.string().nullable().optional(),
  contactTitle: z.string().nullable().optional(),
  resumeText: z.string().nullable().optional(),
  matchHighlights: z.array(z.string()).optional(),
  jobDescription: z.string().nullable().optional(),
  kind: z.enum(['initial', 'follow_up']).optional(),
  /** Set by lib/graph/verify/outreach.ts's ONE bounded regeneration when the
   *  groundedness/specificity judge failed the first draft — fed into the
   *  prompt as corrective instruction. Absent on a first attempt. */
  correctiveContext: z.string().optional(),
})
export const OutreachOutput = z.object({
  subject: z.string(),
  body: z.string(),
  tokensUsed: z.number().int().nonnegative(),
})

// resume_optimizer — score/rewrite/rescore a resume against one job
// (lib/harness/agents/resume_optimizer.ts#optimizeResume). The unit wrapper
// (lib/harness/registry.ts) is ACT-ONLY (ruling 2, langgraph port design doc
// Step 4) and never persists, regardless of `jobId` — see that file's own
// comment on why the persist branch was removed and on where a verify-then-
// persist module belongs once a real caller exists.
export const ResumeOptimizerInput = z.object({
  resumeText: z.string(),
  job: z.object({
    title: z.string(),
    company: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
  }),
  jobId: z.string().optional(),
})
const AtsScoreSchema = z.object({
  atsScore: z.number(),
  missingKeywords: z.array(z.string()),
  formatIssues: z.array(z.string()),
  matchedKeywords: z.array(z.string()),
})
export const ResumeOptimizerOutput = AtsScoreSchema.extend({
  suggestedRewrite: z.string(),
  rescore: AtsScoreSchema,
  tokensUsed: z.number().int().nonnegative(),
  /** Unused by the current ACT-ONLY unit wrapper (lib/harness/registry.ts
   *  never sets it — optimizeResumeAndSave, the only thing that persists a
   *  resume_documents row, runs outside this unit entirely, from
   *  app/api/resume/documents/route.ts). Kept optional for a future
   *  verify-then-persist caller that DOES set it. */
  documentId: z.string().optional(),
})

// strategist — turns outcome data into honestly-gated strategy answers +
// proposals (lib/harness/agents/strategist.ts#strategist). This schema used
// to live in that file (a self-contained AgentFn ahead of its DAG wiring —
// see its own file header's "COORDINATION NOTE"); it moves here now that
// wiring lands, and strategist.ts imports it back, so the shape stays
// EXACTLY what that file's own AgentFn parses against — mirrors
// lib/strategy/types.ts's StrategyReport 1:1.
export const StrategistInput = z.object({
  /**
   * Demo-only escape hatch — routes to the in-memory synthetic fixture
   * (lib/strategy/fixtures.ts) instead of the real database. NEVER set this
   * from a real planned run; it exists so the same AgentFn contract can
   * demonstrate the 'answered' path without 50 real applications. Mirrors
   * app/api/strategy/route.ts's `?demo=synthetic` query param.
   */
  useSyntheticDemo: z.boolean().optional(),
})

const OutcomeBucketSchema = z.object({
  label: z.string(),
  applications: z.number().int().nonnegative(),
  replies: z.number().int().nonnegative(),
  interviews: z.number().int().nonnegative(),
  replyRate: z.number().nullable(),
  interviewRate: z.number().nullable(),
  thinBucket: z.boolean(),
})

function questionResultSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.discriminatedUnion('status', [
    z.object({
      status: z.literal('insufficient_data'),
      question: z.string(),
      sampleSize: z.number().int().nonnegative(),
      minRequired: z.number().int().positive(),
      message: z.string(),
    }),
    z.object({
      status: z.literal('answered'),
      question: z.string(),
      sampleSize: z.number().int().nonnegative(),
      minRequired: z.number().int().positive(),
      data: dataSchema,
      summary: z.string(),
      caveats: z.array(z.string()),
    }),
  ])
}

const SourceFunnelDataSchema = z.object({
  totalApplications: z.number().int().nonnegative(),
  totalWithKnownSource: z.number().int().nonnegative(),
  buckets: z.array(OutcomeBucketSchema),
})

const ScoreBandBucketSchema = OutcomeBucketSchema.extend({ min: z.number(), max: z.number() })
const MatchScoreAccuracyDataSchema = z.object({
  totalApplications: z.number().int().nonnegative(),
  totalScored: z.number().int().nonnegative(),
  bands: z.array(ScoreBandBucketSchema),
  verdict: z.enum(['validates', 'refutes', 'inconclusive']),
})

const ResumeVariantDataSchema = z.object({
  totalApplications: z.number().int().nonnegative(),
  totalWithResumeLink: z.number().int().nonnegative(),
  buckets: z.array(OutcomeBucketSchema),
})

const OutreachImpactDataSchema = z.object({
  totalApplications: z.number().int().nonnegative(),
  totalOutreachMessagesSent: z.number().int().nonnegative(),
  buckets: z.array(OutcomeBucketSchema),
})

const RejectionGroupSchema = z.object({
  kind: z.enum(['company', 'job_function', 'seniority']),
  key: z.string(),
  totalApplications: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  rejectionRate: z.number(),
})
const RejectionPatternsDataSchema = z.object({
  totalApplications: z.number().int().nonnegative(),
  totalRejected: z.number().int().nonnegative(),
  groups: z.array(RejectionGroupSchema),
  groupsTooThinToReport: z.number().int().nonnegative(),
})

const TimingBucketSchema = OutcomeBucketSchema.extend({ minDays: z.number(), maxDays: z.number().nullable() })
const ApplicationTimingDataSchema = z.object({
  totalApplications: z.number().int().nonnegative(),
  totalWithTimestamps: z.number().int().nonnegative(),
  medianDaysToApply: z.number().nullable(),
  buckets: z.array(TimingBucketSchema),
})

const FilterDimensionImpactSchema = z.object({
  dimension: z.enum(['functions', 'seniority', 'countries', 'remoteOnly', 'languages', 'excludedCompanies', 'excludedKeywords', 'minScore (not enforced)']),
  configured: z.boolean(),
  jobsExcludedByThisAlone: z.number().int().nonnegative(),
})
const FilterImpactDataSchema = z.object({
  totalJobsInScope: z.number().int().nonnegative(),
  totalPassingAllConfiguredFilters: z.number().int().nonnegative(),
  totalExcluded: z.number().int(),
  jobsWithNoDescription: z.number().int().nonnegative(),
  dimensions: z.array(FilterDimensionImpactSchema),
  compSponsorshipFilterExists: z.literal(false),
  compSponsorshipNote: z.string(),
  causalEvidence: questionResultSchema(z.object({ note: z.string() })),
})

const EvidencePhraseSchema = z.object({
  phrase: z.string(),
  occurrences: z.number().int().nonnegative(),
  applicationIds: z.array(z.string()),
})
const RecurringEvidenceDataSchema = z.object({
  totalSuccessfulApplications: z.number().int().nonnegative(),
  phrases: z.array(EvidencePhraseSchema),
})

const StrategyProposalSchema = z.object({
  id: z.string(),
  title: z.string(),
  change: z.string(),
  why: z.string(),
  evidence: z.array(z.object({ question: z.string(), sampleSize: z.number().int().nonnegative(), summary: z.string() })),
  expectedEffect: z.string(),
  status: z.literal('proposed'),
})

export const StrategistOutput = z.object({
  generatedAt: z.string(),
  userId: z.string(),
  totalApplications: z.number().int().nonnegative(),
  sourceFunnel: questionResultSchema(SourceFunnelDataSchema),
  matchScoreAccuracy: questionResultSchema(MatchScoreAccuracyDataSchema),
  resumeVariants: questionResultSchema(ResumeVariantDataSchema),
  outreachImpact: questionResultSchema(OutreachImpactDataSchema),
  rejectionPatterns: questionResultSchema(RejectionPatternsDataSchema),
  applicationTiming: questionResultSchema(ApplicationTimingDataSchema),
  filterImpact: FilterImpactDataSchema,
  recurringEvidence: questionResultSchema(RecurringEvidenceDataSchema),
  proposals: z.array(StrategyProposalSchema),
})

// --- analyst + coach ----------------------------------------------------------
//
// Two MORE stragglers, joining the five above (step 9 of the langgraph port —
// docs/superpowers/specs/2026-08-16-langgraph-port-design.md). Both used to
// reach a model through packages/agents' own OpenAI/Anthropic-fetch client
// (packages/agents/src/analyst/llm-client.ts) instead of the harness's own
// metered model path; both now
// run as lib/harness/agents/{analyst,coach}.ts, callable through
// runAgentUnit the same as everything else.

// analyst — per-job AI insights for the job-detail modal
// (lib/harness/agents/analyst.ts). Output is intentionally exactly what
// app/api/agents/analyze/route.ts used to hand back — nothing more.
export const AnalystInput = z.object({
  jobId: z.string(),
})
export const AnalystOutput = z.object({
  summary: z.string(),
  talkingPoints: z.array(z.string()),
  companyInsights: z.array(z.string()),
  interviewTips: z.array(z.string()),
})

// coach — a follow-up suggestion (+ drafted message, when one is due) for one
// application (lib/harness/agents/coach.ts).
export const CoachInput = z.object({
  applicationId: z.string(),
})
export const CoachOutput = z.object({
  applicationId: z.string(),
  suggestion: z.string(),
  suggestedContacts: z.array(z.string()).optional(),
  draftMessage: z.string().optional(),
})

// --- Registry of schemas keyed by agent_type ---------------------------------

export const agentSchemas = {
  planner: { input: PlannerInput, output: PlanSchema },
  sourcer: { input: SourcerInput, output: SourcerOutput },
  matcher: { input: MatcherInput, output: MatcherOutput },
  enricher: { input: EnricherInput, output: EnricherOutput },
  cv_tailor: { input: CvTailorInput, output: CvTailorOutput },
  applier: { input: ApplierInput, output: ApplierOutput },
  verifier: { input: VerifierInput, output: VerifierOutput },
  follow_upper: { input: FollowUpperInput, output: FollowUpperOutput },
  interview_prep: { input: InterviewPrepInput, output: InterviewPrepOutput },
  company_researcher: { input: CompanyResearcherInput, output: CompanyResearcherOutput },
  contact_sourcer: { input: ContactSourcerInput, output: ContactSourcerOutput },
  bulk_matcher: { input: BulkMatcherInput, output: BulkMatcherOutput },
  digest: { input: DigestInput, output: DigestOutput },
  outreach: { input: OutreachInput, output: OutreachOutput },
  resume_optimizer: { input: ResumeOptimizerInput, output: ResumeOptimizerOutput },
  strategist: { input: StrategistInput, output: StrategistOutput },
  analyst: { input: AnalystInput, output: AnalystOutput },
  coach: { input: CoachInput, output: CoachOutput },
} as const satisfies Record<(typeof AGENT_TYPES)[number], { input: z.ZodTypeAny; output: z.ZodTypeAny }>
