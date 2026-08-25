// Harness runtime — zod schemas for every agent_type's input/output and for the
// planner-produced DAG. The executor validates each step's output against the
// matching `agentSchemas[type].output` before journaling it, so schema drift in
// an agent implementation surfaces as a failed step rather than corrupt data.

import { z } from 'zod'

/** Full agent_type enum (matches the agent_steps CHECK values). */
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
 * Per-step loop spec. The executor re-runs the step (same agent_type, same
 * static input) until `until` holds against the step's latest output, or
 * `maxIterations` is hit, or the run's budget/deadline is hit — whichever
 * comes first. `maxIterations` is a HARD cap (<=10): combined with the
 * forward-progress check in lib/harness/dynamic.ts#runLoop (two iterations in
 * a row producing the same `until.key` value stop the loop even if
 * `maxIterations` has not been reached yet), a loop can never spin forever.
 */
export const LoopSpecSchema = z.object({
  maxIterations: z.number().int().positive().max(10),
  until: LoopConditionSchema,
})

/**
 * Per-step fan-out spec: instead of running the step's agent once, the
 * executor resolves `overKey` (a dot-path) inside the `overDep` dependency's
 * output, expects an array, and runs one child invocation of THIS step's
 * agent_type per array element (each child's input is the step's static
 * `input` merged with `{ [itemKey]: <array element> }`). Children run with
 * bounded concurrency and a failed child never fails its siblings — see
 * lib/harness/dynamic.ts#runFanOut. `overDep` MUST be one of the step's own
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
} as const satisfies Record<(typeof AGENT_TYPES)[number], { input: z.ZodTypeAny; output: z.ZodTypeAny }>
