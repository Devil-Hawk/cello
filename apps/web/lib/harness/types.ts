// Harness runtime — shared types.
//
// The agentic harness turns a natural-language goal into a DAG of agent steps,
// executes it with per-step journaling + a token budget, and records everything
// in agent_runs / agent_steps / application_drafts.
//
// NOTE: the harness tables are NOT in @cello/shared's generated `Database`
// type yet, so all harness DB access goes through an *untyped* service-role
// client (see ./supabase-admin.ts) with the row shapes declared here.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { z } from 'zod'
import type {
  PlanSchema,
  StepAgentTypeSchema,
  AgentTypeSchema,
  UnitTypeSchema,
  LoopSpecSchema,
  LoopConditionSchema,
  FanOutSpecSchema,
  ReplanRequestSchema,
} from './schemas'

/** Untyped service-role client. Harness tables aren't in the Database type. */
export type AdminClient = SupabaseClient

/** Every agent_type in the agent_steps enum (planner runs the DAG itself). */
export type AgentType = z.infer<typeof AgentTypeSchema>

/** Agent types that can appear as executable DAG steps (everything but planner). */
export type StepAgentType = z.infer<typeof StepAgentTypeSchema>

/**
 * Every unit lib/graph/unit.ts#runAgentUnit can run — seventeen total:
 * StepAgentType's ten plannable agents, the five graph-port stragglers
 * (bulk_matcher, digest, outreach, resume_optimizer, strategist) that are
 * real, callable units without being plannable, plus analyst and coach. See
 * lib/harness/schemas.ts's UNIT_TYPES for the full rationale.
 */
export type UnitType = z.infer<typeof UnitTypeSchema>

export type Plan = z.infer<typeof PlanSchema>
export type PlanStep = Plan['steps'][number]
export type LoopCondition = z.infer<typeof LoopConditionSchema>
export type LoopSpec = z.infer<typeof LoopSpecSchema>
export type FanOutSpec = z.infer<typeof FanOutSpecSchema>
export type ReplanRequest = z.infer<typeof ReplanRequestSchema>

/** Decrypted per-user LLM keys (subset of settings/keys ApiKeys). */
export interface DecryptedApiKeys {
  openai?: string
  anthropic?: string
  openrouter?: string
  /**
   * Whose spend this is. Optional so every existing caller still compiles, but
   * when absent the monthly cap CANNOT be enforced for that call — loaders
   * (lib/apikeys.ts, lib/harness/keys.ts) always set it.
   */
  userId?: string
  /** Per-user preferred model id (plain string, NOT encrypted). */
  model?: string
  /**
   * Per-user LLM backend choice (profiles.preferences.provider). Not secret —
   * never encrypted. Absent means "use the default" (openrouter); callLlm
   * resolves that via resolveProviderId, so every existing caller that builds
   * a DecryptedApiKeys without this field keeps calling OpenRouter exactly as
   * before the provider layer existed.
   */
  provider?: ProviderPreferences
  /**
   * Per-user default reasoning effort (profiles.preferences.reasoningEffort).
   * Applied by callLlm only when a call doesn't already set opts.reasoning —
   * see lib/harness/llm.ts. Absent means "no default", i.e. today's behavior
   * where only the calls that explicitly opt in ever think.
   */
  reasoningEffort?: ReasoningEffort
}

// --- DB row shapes (hand-declared; mirror the harness migration) -------------

export type RunStatus =
  | 'queued'
  | 'planning'
  | 'running'
  | 'completed'
  /**
   * At least one step FAILED (or the run was aborted on budget/deadline before
   * every step got to run) but at least one other step still completed. A
   * plain 'completed' status is reserved for a run where nothing broke — see
   * lib/graph/runs.ts's finalStatus computation.
   */
  | 'completed_with_errors'
  /**
   * harnessRun (lib/graph/runs.ts) hit its interrupt({kind:'deadline'})
   * boundary (or an ask-form/review wait) with a LangGraph checkpoint parked
   * mid-DAG — a PAUSE, not a failure. Retired the pre-port bespoke
   * executor's 'incomplete' status, which named a continuation-counter
   * mechanism as the PRIMARY resume path (bump-and-cap on every attempt);
   * the stuck-run reaper is fully deleted by the graph port (see
   * lib/graph/journal.ts#markRunPaused). app/api/harness/cron/route.ts's
   * resume pass picks up every 'paused' run
   * (plus any 'running' one stale past its threshold) and re-enters the
   * thread via invokeGraphForUser with THE RESUME RULE (lib/graph/invoke.ts)
   * uniformly — no branching on why the thread stopped. Two backstops guard
   * against a thread that never reaches a terminal state: a checkpoint-count
   * ceiling for one that keeps legitimately re-pausing, and
   * agent_runs.continuation_count — reused, not deleted, as a narrower
   * consecutive-failure-streak cap — for one whose resume attempts fail
   * before ever producing a checkpoint at all (see continuation_count's own
   * doc on AgentRunRow and RESUME_ATTEMPT_CEILING in cron/route.ts).
   */
  | 'paused'
  | 'failed'
  | 'cancelled'

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export interface AgentRunRow {
  id: string
  user_id: string
  goal: string
  status: RunStatus
  plan: Plan | null
  budget_tokens: number
  spent_tokens: number
  result: unknown
  error: string | null
  started_at: string | null
  finished_at: string | null
  created_at: string
  /**
   * Pre-port: how many times app/api/harness/cron/route.ts's
   * continueIncompleteRuns() had re-entered runAgentRun for this run after it
   * paused with the now-retired 'incomplete' status (that mechanism is
   * deleted — see RunStatus's 'paused' doc above).
   *
   * Graph port: reused by app/api/harness/cron/route.ts's
   * resumeCheckpointedRuns() as RESUME_ATTEMPT_CEILING's CONSECUTIVE
   * resume-attempt failure streak — bumped durably BEFORE each resume attempt
   * (so an attempt killed mid-request still counts), reset to 0 the instant
   * an attempt returns without throwing. Bounds a thread whose resume attempt
   * fails before ever producing a new checkpoint (thread-ownership refusal,
   * expired demo thread, checkpointer connectivity failure) — the one
   * pathology CHECKPOINT_CEILING (lib/graph/pg.ts#countThreadCheckpoints)
   * structurally cannot see, since no checkpoint is ever written on that
   * path. 0/absent for a run that has never failed a resume attempt
   * (including every run that predates this column — read with `?? 0`,
   * never assume it is present).
   */
  continuation_count: number
}

export interface AgentStepRow {
  id: string
  run_id: string
  agent_type: AgentType
  label: string
  status: StepStatus
  input: unknown
  output: unknown
  tokens_used: number
  started_at: string | null
  finished_at: string | null
  created_at: string
  /** Null for a normal plan step. Non-null for a loop iteration or a fan-out
   *  child: points at the plan step's own (parent) agent_steps row. */
  parent_step_id: string | null
  /** Null for a normal step. 1-based iteration/child index otherwise. */
  iteration: number | null
}

// --- Agent execution contract ------------------------------------------------

/** Result returned by callLlm — content plus token accounting. */
export interface LlmResult {
  content: string
  tokensUsed: number
  promptTokens: number
  completionTokens: number
  model: string
  /**
   * Why the model stopped. 'length' means the response hit max_tokens and the
   * content is CUT OFF mid-token — in JSON mode that content can never parse.
   */
  finishReason?: string
  /**
   * The model's extended reasoning, when opts.reasoning asked for it. This is
   * the real chain of thought — distinct from any short "thought" field an
   * agent happens to put in its own JSON output.
   */
  reasoning?: string
}

/**
 * Reasoning effort ladder, in ascending order of spend.
 *
 * Exported so the settings UI can render it as an ordered control (a slider)
 * rather than an unordered dropdown — the levels are a continuum, not a set of
 * unrelated options.
 */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

/**
 * Anthropic models take a thinking-token budget instead of an effort string.
 * These are the budgets each rung maps to. 'none' disables thinking entirely.
 */
export const ANTHROPIC_THINKING_BUDGET: Record<ReasoningEffort, number> = {
  none: 0,
  minimal: 1024,
  low: 2048,
  medium: 6144,
  high: 16384,
  xhigh: 32768,
  max: 63999,
}

/**
 * Selectable LLM backends (lib/harness/providers/*). 'openrouter' is the
 * long-standing default and the only one that works on Vercel serverless —
 * the other two either spawn a local binary or call an address on the user's
 * own network, so they only make sense when Cello itself is self-hosted. See
 * lib/harness/providers/index.ts for capability flags + the registry, and
 * lib/harness/llm-key-message.ts's isSelfHosted-aware messaging.
 */
export const PROVIDER_IDS = ['openrouter', 'local-cli', 'local-server'] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

/**
 * CLI binaries local-cli can spawn. Each authenticates with the user's own
 * subscription account (Claude Pro/Max, ChatGPT Plus/Pro, Gemini) — there is
 * no API key involved, which is the entire point of this backend.
 */
export const LOCAL_CLI_IDS = ['claude', 'codex', 'gemini'] as const
export type LocalCliId = (typeof LOCAL_CLI_IDS)[number]

/** Per-user LLM backend choice, stored at profiles.preferences.provider. */
export interface ProviderPreferences {
  active: ProviderId
  /** Which CLI local-cli spawns when active === 'local-cli'. */
  localCli: LocalCliId
  /** Base URL of an OpenAI-compatible local server (Ollama, LM Studio, vLLM). */
  localServerBaseUrl: string
  /** Model id to request from the local server — server-specific, freeform. */
  localServerModel: string
  /**
   * Embedding model id to request from the local server. Separate from
   * localServerModel (a chat model id) because callEmbedding's fallback chain
   * (lib/harness/providers/embeddings.ts) is independent of the chat provider
   * choice above — a local server only ever enters that chain when this is
   * set. Empty means "not configured", which is how ruling 10 (langgraph port
   * spec) gates the local-server embedding fallback: no id here, no attempt.
   * The 1536-dim requirement it also states is enforced at call time
   * (assertDims in embeddings.ts throws rather than trusting the id).
   *
   * Optional (unlike its chat-model sibling above) so every existing literal
   * ProviderPreferences in this codebase — settings UI, tests fixtures —
   * keeps compiling unchanged; `undefined` and `''` both read as "not
   * configured" everywhere this is checked.
   */
  localServerEmbeddingModel?: string
}

export const DEFAULT_PROVIDER_PREFERENCES: ProviderPreferences = {
  active: 'openrouter',
  localCli: 'claude',
  localServerBaseUrl: '',
  localServerModel: '',
  localServerEmbeddingModel: '',
}

export interface LlmRunOptions {
  /** Optional system prompt. */
  system?: string
  /** User prompt (shorthand for a single user message). */
  prompt?: string
  /** Full message list (overrides `prompt` when provided). */
  messages?: { role: 'system' | 'user' | 'assistant'; content: string }[]
  model?: string
  maxTokens?: number
  temperature?: number
  /** Ask the model for a JSON object response. */
  json?: boolean
  /**
   * Turn on extended reasoning. Reasoning tokens are billed as OUTPUT, so
   * enable it where judgement quality matters (scoring, planning) rather than
   * on every call.
   *
   * NOTE ON PROVIDER DIFFERENCES (this is why the mapping in llm.ts exists):
   *   - OpenAI/Grok-style models accept the full effort ladder, xhigh and max
   *     included.
   *   - Google Gemini caps at 'high' and maps anything above it back down.
   *   - Anthropic models do NOT take an effort level at all — they allocate a
   *     THINKING TOKEN BUDGET via reasoning.max_tokens. So "xhigh on Claude"
   *     means a large budget, not an effort string, and callLlm translates.
   */
  reasoning?: { effort: ReasoningEffort }
  /**
   * Mark the system prompt as a cacheable prefix.
   *
   * Worth it whenever the same large preamble (a resume + rubric) is reused
   * across many calls. Anthropic models need an explicit cache_control
   * breakpoint; Moonshot/Gemini cache implicitly, so this is a no-op there and
   * safe to set unconditionally.
   */
  cachePrefix?: boolean
}

/**
 * Budget-aware LLM runner handed to each agent. It calls OpenRouter with the
 * user's key, meters tokens against the run budget, and aborts the run (via the
 * shared AbortSignal) the moment the budget is exceeded.
 */
export type LlmRunner = (opts: LlmRunOptions) => Promise<LlmResult>

/** Everything an agent implementation receives when it runs. */
export interface StepContext {
  userId: string
  runId: string
  stepLabel: string
  /**
   * Widened from StepAgentType to UnitType so lib/graph/unit.ts#runAgentUnit
   * can build a StepContext-compatible ctx for the five graph-port
   * stragglers too, without changing what the ten existing StepAgentType
   * AgentFn implementations receive (StepAgentType ⊂ UnitType — every value
   * they were already passed still type-checks here unchanged).
   */
  agentType: UnitType
  /** Static input declared for this step by the planner. */
  input: unknown
  /** Outputs of dependency steps, keyed by their label. */
  deps: Record<string, unknown>
  /** Service-role client (bypasses RLS) — server-side writes only. */
  admin: AdminClient
  /** The signed-in user's decrypted LLM keys. */
  apiKeys: DecryptedApiKeys
  /** Budget-aware LLM helper (preferred — tokens are metered automatically). */
  llm: LlmRunner
  /** Aborted when the budget is exhausted or the run is cancelled. */
  signal: AbortSignal
}

export interface AgentResult {
  /** Must satisfy the agent_type's output zod schema. */
  output: unknown
  /**
   * Out-of-band token cost NOT already metered through `ctx.llm`. Leave 0/omit
   * when you only used `ctx.llm` (that path meters itself).
   */
  tokensUsed?: number
  /**
   * Optional bounded graph-extension request — see lib/harness/replan.ts. Only
   * honored by the executor for a plain (non-loop, non-fanOut) step's FIRST
   * successful attempt; ignored everywhere else. No shipped agent sets this
   * today — it's a forward-looking capability for a future agent that wants
   * to say "extend the plan" instead of only "here is my output".
   */
  replanRequest?: ReplanRequest
}

/** An agent implementation: pure async function, no next/* imports. */
export type AgentFn = (ctx: StepContext) => Promise<AgentResult>

/** Thrown when a step's LLM usage would push the run past its token budget. */
export class BudgetExceededError extends Error {
  constructor(message = 'Token budget exceeded') {
    super(message)
    this.name = 'BudgetExceededError'
  }
}
