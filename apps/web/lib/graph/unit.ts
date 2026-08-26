// The one agent contract for all 15 agents (docs/superpowers/specs/2026-08-16-
// langgraph-port-design.md — Architecture > Core, "lib/graph/unit.ts#
// runAgentUnit").
//
// WHY THIS FILE EXISTS
//   Before the graph port, ten agents ran through lib/harness/executor.ts (DAG
//   steps, schema-checked + journaled + budget-metered) and five more
//   (bulk_matcher, digest, outreach, resume_optimizer, strategist) reached a
//   model through their own exported entry function, called straight from
//   app/api, with none of that discipline applied uniformly. runAgentUnit is
//   the single door onto all fifteen: it validates input/output against
//   lib/harness/schemas.ts's agentSchemas, builds a FRESH metered LlmRunner
//   per call (never cached — a cached runner is exactly the closure bug
//   makeLlmRunner had, see MissingUserIdError below), applies one shared
//   truncation-retry policy, runs containment DETECTION (never a gate — see
//   ruling 2) for the four content-authoring unit types, and journals
//   start/finish via lib/graph/journal.ts. The underlying AgentFn
//   implementations (lib/harness/registry.ts's UNIT_REGISTRY) are UNCHANGED —
//   this file only wraps them.
//
// userId IS REQUIRED — a caller that satisfies the TYPE with an empty string
// would still build an unmetered/unaudited LlmRunner at runtime (the exact
// makeLlmRunner closure bug this contract exists to close for good, see
// docs/superpowers/specs/2026-08-16-langgraph-port-design.md's Architecture >
// Core note on invokeGraphForUser), so MissingUserIdError is thrown on the
// VALUE, not inferred from the type; lib/harness/spend-chokepoints.test.ts
// pins this on THIS file. Every call also goes through lib/harness/keys.ts#loadApiKeys
// (GUARDED_KEY_SOURCES — lib/access/demo-chokepoints.test.ts), so a demo
// session past its 72 hours is refused here the same way it is everywhere
// else that reaches a model.
//
// CONTAINMENT: DETECT, ATTACH, NEVER THROW (ruling 2).
//   For cv_tailor/resume_optimizer/outreach/follow_upper, runAgentUnit always
//   runs checkTailoringContainment (lib/security/job-text.ts) against the
//   unit's own output and ATTACHES the report — it never gates. Policy
//   (retry, hold for review, refuse) belongs to a future verify node, not
//   here. cv_tailor.ts additionally still runs its OWN internal containment
//   check and THROWS on failure (existing behavior, unchanged by this file) —
//   so by the time this file's check runs on a cv_tailor result, a failing
//   draft has already been refused upstream and this is a second, harmless
//   look at what already passed. The other three unit types have no such
//   internal check, so this file's pass is the only one they get until stage
//   1C moves the check into the agent files directly.
//
//   The TYPE enforces this, not just the runtime: runAgentUnit<T>'s return
//   type is a conditional on T, and `containment` is REQUIRED (not optional)
//   for the four content-authoring unit types — a caller reading
//   `result.containment` for cv_tailor cannot forget to check `undefined`,
//   and a version of this file that stopped attaching it would fail to
//   compile before it ever shipped.

import type {
  AdminClient,
  AgentResult,
  DecryptedApiKeys,
  LlmRunner,
  LlmRunOptions,
  ReplanRequest,
  StepContext,
  UnitType,
} from '../harness/types'
import { agentSchemas } from '../harness/schemas'
import { UNIT_REGISTRY } from '../harness/registry'
import { loadApiKeys } from '../harness/keys'
import { callLlm, parseJsonLoose, TruncatedResponseError } from '../harness/llm'
import { checkTailoringContainment, type TailoringContainmentReport } from '../security/job-text'
import { journalStepFinish, journalStepStart } from './journal'
import { checkToolPostcondition, recordToolPostcondition } from './postcondition'
import { logHarnessError } from '../observability/log'
import { BudgetCapError } from '../harness/spend'
import { acquireSpanScope, runInTraceContext, withSpan } from '../trace/spans'

/**
 * Thrown when config.configurable.userId is absent. Named distinctly from a
 * bare Error (a "TypedError", per the graph-port spec's core-architecture
 * note) so a caller can distinguish "this call was never going to be
 * metered" from an ordinary agent failure — the same reason
 * lib/harness/providers/index.ts gives MissingKeyError/ProviderUnavailableError
 * their own classes rather than throwing a plain Error for each.
 */
export class MissingUserIdError extends Error {
  readonly unitType: string
  constructor(unitType: string) {
    super(
      `runAgentUnit: config.configurable.userId is required to run unit "${unitType}" — refusing to build an ` +
        `unmetered, unaudited LlmRunner.`
    )
    this.name = 'MissingUserIdError'
    this.unitType = unitType
  }
}

/**
 * The config bag every graph surface threads through
 * (lib/graph/invoke.ts#invokeGraphForUser injects exactly these three keys
 * into config.configurable). Typed as required strings — the REQUIRED half
 * of the contract — with the runtime guard below on `userId` specifically,
 * because a type is not a runtime check (see MissingUserIdError's doc).
 */
export interface UnitConfig {
  configurable: {
    userId: string
    runId: string
    threadId: string
    [key: string]: unknown
  }
}

export interface RunAgentUnitArgs {
  /** Static input for this unit — validated against agentSchemas[unitType].input. */
  input: unknown
  admin: AdminClient
  config: UnitConfig
  /**
   * Dependency outputs, keyed by label — forwarded verbatim into
   * StepContext.deps (defaults to `{}`, this file's pre-existing behavior,
   * when omitted). matcher/applier/verifier read `ctx.deps` directly (e.g.
   * matcher.ts's collectJobIds pulls candidate jobIds off an upstream
   * sourcer step's output), so a DAG caller — lib/graph/runs.ts — MUST pass
   * this for those agent types to see their upstream data at all; the five
   * original stragglers (bulk_matcher/digest/outreach/resume_optimizer/
   * strategist) have no upstream steps and always omit it.
   */
  deps?: Record<string, unknown>
  /**
   * Journal label + StepContext.stepLabel override. Defaults to `unitType`
   * (this file's five original stragglers — bulk_matcher/digest/outreach/
   * resume_optimizer/strategist — run at most once per invocation, so the
   * unit type IS a fine label). lib/graph/runs.ts's DAG steps pass their OWN
   * plan-step label here instead: a plan can legally run the SAME agent_type
   * under two different labels (e.g. two `cv_tailor` steps), and journaling
   * both under the literal string "cv_tailor" would upsert one into the
   * other (lib/graph/journal.ts keys a row on (run_id, label, iteration)).
   */
  label?: string
}

/** Unit types that author content a human or an employer reads, and so get a
 *  containment pass — ruling 2's exact set. */
const CONTAINMENT_UNIT_TYPES = new Set<UnitType>(['cv_tailor', 'resume_optimizer', 'outreach', 'follow_upper'])
type ContainmentUnitType = 'cv_tailor' | 'resume_optimizer' | 'outreach' | 'follow_upper'

/**
 * The return shape is a conditional on the unit type: the four content-
 * authoring types get a REQUIRED `containment` field, everyone else gets
 * none. See this file's header for why that is a type-level guarantee, not
 * just a runtime convention.
 */
export type UnitResult<T extends UnitType> = T extends ContainmentUnitType
  ? { output: unknown; tokensUsed: number; containment: TailoringContainmentReport; replanRequest?: ReplanRequest }
  : { output: unknown; tokensUsed: number; replanRequest?: ReplanRequest }

// --- Shared JSON parse + truncation-retry policy ----------------------------
//
// Lifted from lib/harness/agents/cv_tailor.ts:147-162 (the try/call-then-
// retry-wider-on-truncation pattern, plus the parse-or-throw-a-named-error
// pattern) and generalized so every unit gets it for free, whether or not its
// own implementation remembered to write it. The per-agent copies (cv_tailor,
// matcher, bulk_matcher, resume_optimizer) stay in place until stage 1C
// deletes them — see this file's header.

/** Parse an LLM JSON response, or throw a clearly-attributed error — the
 *  general form of cv_tailor.ts's own `catch { throw new Error(...) }`. */
export function parseJsonStrict<T = unknown>(raw: string, context: string): T {
  try {
    return parseJsonLoose<T>(raw)
  } catch {
    throw new Error(`${context}: model did not return valid JSON`)
  }
}

/** Default widening applied when a call didn't set its own maxTokens at all —
 *  mirrors the ceiling cv_tailor.ts's own MAX_TOKENS constant used to double. */
const DEFAULT_MAX_TOKENS = 2048

/**
 * Wrap a fresh LlmRunner so ONE TruncatedResponseError is retried with double
 * maxTokens before it is allowed to fail the call — exactly cv_tailor.ts's
 * own retry, lifted so every unit inherits it transparently through ctx.llm
 * rather than each agent hand-rolling its own try/catch. An agent that still
 * has its own internal retry (cv_tailor, matcher, bulk_matcher today) simply
 * never sees the TruncatedResponseError in the common case — this wrapper
 * already resolved it one layer down.
 */
function withTruncationRetry(llm: LlmRunner): LlmRunner {
  return async (opts: LlmRunOptions) => {
    try {
      return await llm(opts)
    } catch (err) {
      if (!(err instanceof TruncatedResponseError)) throw err
      const widerMaxTokens = (opts.maxTokens ?? DEFAULT_MAX_TOKENS) * 2
      return llm({ ...opts, maxTokens: widerMaxTokens })
    }
  }
}

// --- Containment subject extraction ------------------------------------------

interface ContainmentSubject {
  /** The text a human/employer will actually read — what gets diffed against the resume. */
  tailored: string
  /** Legitimate facts even though the resume never contained them (company name, job title, ...). */
  allow: string[]
  /** The job description this output was conditioned on, when known — sets `fromJobText`. */
  jobText: string | null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

/** Pulls the (tailored text, allow-list, job text) triple out of a unit's own
 *  input/output shapes — one case per CONTAINMENT_UNIT_TYPES member. Reading
 *  `output`/`input` as loose records here is deliberate: both were ALREADY
 *  validated against their real zod schemas by the time this runs (see
 *  runAgentUnit), so this is just field access on a known-good shape, not a
 *  second validation pass. */
function extractContainmentSubject(unitType: ContainmentUnitType, input: unknown, output: unknown): ContainmentSubject {
  const i = (input ?? {}) as Record<string, unknown>
  const o = (output ?? {}) as Record<string, unknown>

  switch (unitType) {
    case 'cv_tailor':
      return { tailored: `${str(o.resumeSummary)}\n\n${str(o.coverLetter)}`.trim(), allow: [], jobText: null }

    case 'resume_optimizer': {
      const job = (i.job ?? {}) as Record<string, unknown>
      return {
        tailored: str(o.suggestedRewrite),
        allow: [strOrNull(job.title), strOrNull(job.company)].filter((v): v is string => v !== null),
        jobText: strOrNull(job.description),
      }
    }

    case 'outreach':
      return {
        tailored: `${str(o.subject)}\n\n${str(o.body)}`.trim(),
        allow: [strOrNull(i.companyName), strOrNull(i.jobTitle), strOrNull(i.contactName), strOrNull(i.contactTitle), strOrNull(i.userName)].filter(
          (v): v is string => v !== null
        ),
        jobText: strOrNull(i.jobDescription),
      }

    case 'follow_upper':
      return { tailored: str(o.message), allow: [], jobText: null }
  }
}

/** Explicit resumeText the unit's own input already carried wins; otherwise
 *  fall back to the user's stored resume — mirrors cv_tailor.ts's own
 *  "explicit input wins, else profiles.resume_text" fallback. */
async function resolveResumeText(admin: AdminClient, userId: string, explicit: string | null): Promise<string> {
  const trimmed = (explicit ?? '').trim()
  if (trimmed) return trimmed
  const { data } = await admin.from('profiles').select('resume_text').eq('id', userId).single()
  return ((data as { resume_text?: string | null } | null)?.resume_text ?? '').trim()
}

function explicitResumeText(unitType: ContainmentUnitType, input: unknown): string | null {
  if (unitType === 'follow_upper') return null // FollowUpperInput carries no resumeText field at all
  return strOrNull((input as Record<string, unknown>)?.resumeText)
}

// --- The contract -------------------------------------------------------------

export async function runAgentUnit<T extends UnitType>(unitType: T, ctx: RunAgentUnitArgs): Promise<UnitResult<T>> {
  const { userId, runId } = ctx.config.configurable

  // The runtime half of the "userId IS REQUIRED" guard this file's header
  // describes — lib/harness/spend-chokepoints.test.ts pins it on THIS file;
  // see MissingUserIdError's class doc for why this checks the value, not
  // just the type.
  if (!userId) {
    throw new MissingUserIdError(unitType)
  }

  const label = ctx.label ?? unitType

  // 'node' span around the whole unit (spec Step 2: "runAgentUnit emits
  // 'node' spans around each unit"). acquireSpanScope joins the ambient
  // invocation's buffer when runAgentUnit is nested inside invokeGraphForUser
  // (the ordinary case — lib/graph/runs.ts/autopilot.ts), or starts a fresh
  // one when called directly with no invocation around it at all
  // (lib/graph/oneshot.ts#runUnitOnce) — see lib/trace/spans.ts's own doc.
  // `runId` here is ALWAYS this call's own domain agent_runs.id (the same
  // value journalStepStart/Finish already write to agent_steps.run_id below),
  // never the ambient scope's — an outer graph invocation may know no
  // agent_runs row at all (see invoke.ts's header), but this unit always does.
  const scope = acquireSpanScope(userId)
  try {
    return await withSpan(
      scope.buffer,
      { parentSpanId: scope.parentSpanId, runId, kind: 'node', name: label },
      (spanId) =>
        runInTraceContext({ buffer: scope.buffer, parentSpanId: spanId, runId }, () =>
          runUnitBody(unitType, ctx, label, userId, runId)
        ),
      (result, err) =>
        result
          ? { agentType: unitType, label, tokensUsed: result.tokensUsed }
          : { agentType: unitType, label, error: err instanceof Error ? err.message : String(err) }
    )
  } finally {
    // Only the call that CREATED this buffer (no ambient context) flushes it
    // — a unit nested inside a graph invocation leaves flushing to
    // invokeGraphForUser, which owns that buffer's whole lifetime.
    if (scope.owns) await scope.buffer.flush(ctx.admin)
  }
}

async function runUnitBody<T extends UnitType>(
  unitType: T,
  ctx: RunAgentUnitArgs,
  label: string,
  userId: string,
  runId: string
): Promise<UnitResult<T>> {
  const schema = agentSchemas[unitType]
  const parsedInput = schema.input.parse(ctx.input ?? {})

  await journalStepStart(ctx.admin, {
    runId,
    label,
    agentType: unitType,
    input: parsedInput,
  })

  // FRESH per call, never cached at module/graph scope — a cached runner is
  // exactly the historical makeLlmRunner closure bug (a stale userId/key
  // survives a key rotation or a budget reset, and spend silently goes
  // unmetered or gets attributed to the wrong account).
  const apiKeys: DecryptedApiKeys = await loadApiKeys(ctx.admin, userId)
  const controller = new AbortController()
  // Sums every ctx.llm call this unit makes — most agent implementations
  // return `tokensUsed: 0` from their own AgentResult on the understanding
  // that a caller meters ctx.llm itself (see e.g.
  // lib/harness/agents/matcher.ts:832's "already metered per-call through
  // ctx.llm" comment; lib/harness/executor.ts#attemptOnce did this same
  // summing for the pre-port DAG executor). Without it, tokensUsed below
  // would silently read 0 for most units and the run-level budget gate in
  // lib/graph/runs.ts would never trip.
  const meter = { used: 0 }
  const rawLlm: LlmRunner = async (opts) => {
    const res = await callLlm(apiKeys, opts, controller.signal)
    meter.used += res.tokensUsed
    return res
  }
  const llm = withTruncationRetry(rawLlm)

  const stepCtx: StepContext = {
    userId,
    runId,
    stepLabel: label,
    agentType: unitType,
    input: parsedInput,
    deps: ctx.deps ?? {},
    admin: ctx.admin,
    apiKeys,
    llm,
    signal: controller.signal,
  }

  const fn = UNIT_REGISTRY[unitType]

  // Everything from the agent call through output-schema validation and
  // containment detection is journaled as ONE failure unit: a thrown
  // schema.output.parse (an agent returning output that fails its own
  // schema — exactly the case journaling exists to catch) or a thrown
  // resolveResumeText/checkTailoringContainment on the containment path must
  // still reach journalStepFinish('failed'), not leave the row stuck at
  // 'running' forever.
  let output: unknown
  let tokensUsed: number
  let containment: TailoringContainmentReport | undefined
  let replanRequest: ReplanRequest | undefined
  try {
    const agentResult: AgentResult = await fn(stepCtx)
    output = schema.output.parse(agentResult.output)
    tokensUsed = meter.used + (agentResult.tokensUsed ?? 0)
    replanRequest = agentResult.replanRequest

    if (CONTAINMENT_UNIT_TYPES.has(unitType)) {
      const containmentType = unitType as ContainmentUnitType
      const subject = extractContainmentSubject(containmentType, parsedInput, output)
      const resumeText = await resolveResumeText(ctx.admin, userId, explicitResumeText(containmentType, parsedInput))
      containment = checkTailoringContainment(resumeText, subject.tailored, { allow: subject.allow, jobText: subject.jobText })
    }
  } catch (err) {
    // The one operator-visible channel for harness failures (structured
    // stderr + optional Sentry). Expected control-flow stops are deliberately
    // NOT logged as errors, per docs/OBSERVABILITY.md: a spend-cap refusal or
    // an aborted request is the system working, not the system breaking.
    const expectedStop =
      err instanceof BudgetCapError || (err instanceof Error && err.name === 'AbortError')
    if (!expectedStop) {
      logHarnessError({ runId, stepLabel: label, agentType: unitType, phase: 'unit' }, err)
    }
    const failedStepId = await journalStepFinish(ctx.admin, {
      runId,
      label,
      agentType: unitType,
      status: 'failed',
      output: { error: err instanceof Error ? err.message : String(err) },
      tokensUsed: meter.used,
    })
    // TOOL POSTCONDITIONS (item 4): a real failure gets its own tool_call
    // verdict too, so cross-run success-rate is a query over eval_verdicts
    // rather than a manual agent_steps scan. Expected control-flow stops
    // (budget cap, abort) are skipped — same reasoning as the log line just
    // above: the system refusing before spend is not the tool failing.
    if (!expectedStop) {
      await recordToolPostcondition(ctx.admin, {
        userId,
        runId,
        stepId: failedStepId,
        check: { ok: false, reasons: [err instanceof Error ? err.message : String(err)] },
      })
    }
    throw err
  }

  const finishedStepId = await journalStepFinish(ctx.admin, {
    runId,
    label,
    agentType: unitType,
    status: 'completed',
    output: containment ? { ...(output as Record<string, unknown>), containment } : output,
    tokensUsed,
  })
  await recordToolPostcondition(ctx.admin, {
    userId,
    runId,
    stepId: finishedStepId,
    check: checkToolPostcondition(output, tokensUsed),
  })

  return { output, tokensUsed, ...(containment ? { containment } : {}), ...(replanRequest ? { replanRequest } : {}) } as UnitResult<T>
}
