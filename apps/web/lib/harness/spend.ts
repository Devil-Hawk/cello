// Hard monthly spend cap, enforced at the single LLM choke point.
//
// WHY THIS EXISTS: every existing budget in this codebase is denominated in
// TOKENS and scoped to ONE run (agent_runs.budget_tokens, autopilot's
// DEFAULT_BUDGET_TOKENS). Nothing has ever bounded spend across runs, so a
// daily cron scoring 25 jobs a tick could quietly consume a month's credit —
// the user's whole balance — without any single run looking unreasonable.
// Tokens are also the wrong unit to promise a user in: they budget in money.
//
// The cap is a REFUSAL, not a warning. When the month's allowance is spent,
// the reservation below throws BudgetCapError and the feature reports it
// honestly, exactly like a missing key.
//
// HOW IT IS ENFORCED: RESERVE, THEN SETTLE. This module is the one seam every
// metered model call goes through (callLlm, callEmbedding, the judge client, the
// engine's model middleware).
//   reserveSpend  before the call: the worst case (a conservative prompt estimate
//                 plus max_tokens at the output price) is reserved in ONE atomic
//                 Postgres function (reserve_llm_spend). It admits the call only
//                 if spent + held + estimate <= cap, so N parallel calls cannot
//                 all pass a check and then all charge.
//   settleSpend   after the call: the provider-reported cost replaces the
//                 estimate, exactly once (idempotent by reservation id).
// A call that dies without settling is charged at its estimate by a pg_cron
// sweeper after 15 minutes, so a crash can only over-count. The ledger rows
// (public.llm_spend) are the counter; only the service role writes them.

import type { AdminClient, DecryptedApiKeys } from './types'

/** Conservative default. Deliberately low: a user who never configures this
 *  should not be able to lose real money to a background cron. */
export const DEFAULT_MONTHLY_USD = 10

/** Which allowance ran out: the user's own monthly cap, or the shared monthly
 *  allowance of every demo one owner funds. */
export type BudgetScope = 'user' | 'demo-pool'

export class BudgetCapError extends Error {
  readonly spentUsd: number
  readonly capUsd: number
  readonly scope: BudgetScope
  constructor(spentUsd: number, capUsd: number, scope: BudgetScope = 'user') {
    super(
      scope === 'demo-pool'
        ? 'This demo has used its AI allowance for the month. You can keep looking around.'
        : `Monthly AI spend cap reached: $${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} used. ` +
            `Raise the cap in Settings, or wait for the next billing month.`
    )
    this.name = 'BudgetCapError'
    this.spentUsd = spentUsd
    this.capUsd = capUsd
    this.scope = scope
  }
}
/**
 * Per-million-token prices, USD, mirroring OpenRouter's published rates for the
 * models in lib/models.ts ALLOWED_MODELS.
 *
 * An unknown model falls back to the MOST EXPENSIVE entry rather than zero:
 * under-counting spend is the failure that costs the user money, so an
 * unrecognised model must never look free.
 */
const PRICES: Record<string, { in: number; out: number }> = {
  'anthropic/claude-sonnet-5': { in: 2, out: 10 },
  'anthropic/claude-opus-4.8': { in: 5, out: 25 },
  'anthropic/claude-haiku-4.5': { in: 1, out: 5 },
  'openai/gpt-5.2': { in: 1.75, out: 14 },
  'moonshotai/kimi-k3': { in: 3, out: 15 },
  'moonshotai/kimi-k2-thinking': { in: 0.6, out: 2.5 },
  'google/gemini-2.5-flash': { in: 0.3, out: 2.5 },
  // Cheap bulk models (Gmail classify, scraper extract, career-page verify). Unlisted they
  // would book at the $5/$25 fallback, about 70x too high, and burn a demo's cap in ~70 emails.
  'google/gemini-2.0-flash-001': { in: 0.1, out: 0.4 },
  'openai/gpt-4o-mini': { in: 0.15, out: 0.6 },
  // Embeddings only ever consume input tokens (out: 0) — callEmbedding
  // (lib/harness/llm.ts) always settles with completionTokens=0.
  // Locked model (2026-08-16 langgraph port spec); OpenAI's published rate.
  'openai/text-embedding-3-small': { in: 0.02, out: 0 },
}
const FALLBACK_PRICE = { in: 5, out: 25 }
// OpenRouter's ':free' variants cost nothing per token. Booking them at the
// fallback would charge the ingest pass (which only uses free models) $5/$25
// per million and drain a user's cap on work that costs them nothing.
const FREE_PRICE = { in: 0, out: 0 }

function priceFor(model: string): { in: number; out: number } {
  if (model.endsWith(':free')) return FREE_PRICE
  return PRICES[model] ?? FALLBACK_PRICE
}

export function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const p = priceFor(model)
  return (promptTokens / 1e6) * p.in + (completionTokens / 1e6) * p.out
}

/** The same numbers split into Langfuse costDetails buckets (USD). Uses OUR
 *  price table, the one the budget ledger charges, so Langfuse and the cap
 *  agree. */
export function estimateCostDetails(
  model: string,
  promptTokens: number,
  completionTokens: number
): { input: number; output: number } {
  const p = priceFor(model)
  return { input: (promptTokens / 1e6) * p.in, output: (completionTokens / 1e6) * p.out }
}

/** False when estimateCostUsd had to use FALLBACK_PRICE for this model. */
export function hasListedPrice(model: string): boolean {
  return model.endsWith(':free') || Object.prototype.hasOwnProperty.call(PRICES, model)
}

/** Ceiling on a completion when the caller sets none. Every metered call carries
 *  a max_tokens, because the reservation is priced from it. */
export const DEFAULT_MAX_TOKENS = 2048

/** A conservative prompt-token estimate: about 3 characters per token (real text
 *  runs nearer 4, so this over-reserves) plus per-message framing. */
export function estimatePromptTokens(text: string, messages = 1): number {
  return Math.ceil(text.length / 3) + 8 * messages
}

/** The most one call can cost: the prompt estimate at the input price plus the
 *  whole max_tokens ceiling at the output price. Zero for a ':free' model.
 *  Rounded UP to the ledger's six decimals, so rounding never under-reserves. */
export function worstCaseUsd(model: string, promptTokens: number, maxTokens: number): number {
  return Math.ceil(estimateCostUsd(model, promptTokens, maxTokens) * 1e6) / 1e6
}

/** A held slice of a user's allowance. `id` is null for a free model: it costs
 *  nothing, so it writes no ledger row and takes no lock. */
export interface SpendReservation {
  id: string | null
  userId: string
  model: string
  estimateUsd: number
}

export interface ReserveInput {
  userId: string
  model: string
  promptTokens: number
  maxTokens: number
  traceId?: string
}

/**
 * Hold the worst-case cost of a call before making it. Throws BudgetCapError when
 * the user's cap (or, for a demo, its owner's shared allowance) cannot cover it,
 * and a plain Error when the ledger is unreachable: an unreadable ledger means no
 * metered call, never a free one.
 */
export async function reserveSpend(admin: AdminClient, input: ReserveInput): Promise<SpendReservation> {
  if (input.model.endsWith(':free')) return { id: null, userId: input.userId, model: input.model, estimateUsd: 0 }
  const estimateUsd = worstCaseUsd(input.model, input.promptTokens, input.maxTokens)

  const { data, error } = await admin.rpc('reserve_llm_spend', {
    p_user_id: input.userId,
    p_model: input.model,
    p_estimate: estimateUsd,
    p_trace_id: input.traceId ?? null,
  })
  const row = data as { ok?: boolean; id?: string; scope?: BudgetScope; spent_usd?: number; cap_usd?: number } | null
  if (error || !row) throw new Error('spend ledger unavailable')
  if (!row.ok || !row.id) {
    throw new BudgetCapError(Number(row.spent_usd ?? 0), Number(row.cap_usd ?? 0), row.scope === 'demo-pool' ? 'demo-pool' : 'user')
  }
  return { id: row.id, userId: input.userId, model: input.model, estimateUsd }
}

export type SpendOutcome =
  | { model: string; promptTokens: number; completionTokens: number; costUsd?: number }
  | { failed: unknown }

/** The HTTP status an error carries, when the provider answered at all. */
function errorStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : undefined
}

/**
 * Charge what the call really cost, once. Never throws: a bookkeeping failure
 * must not fail the user's request, and the sweeper still charges the estimate.
 *   - a result charges the provider-reported cost, else our price estimate
 *   - an error with an HTTP status (the provider answered, nothing was generated)
 *     charges 0
 *   - any other failure (abort, timeout, dropped connection) is left reserved, so
 *     the sweeper charges the estimate
 */
export async function settleSpend(admin: AdminClient, res: SpendReservation, outcome: SpendOutcome): Promise<void> {
  if (!res.id) return
  let actual: number
  if ('failed' in outcome) {
    if (errorStatus(outcome.failed) === undefined) return
    actual = 0
  } else {
    actual = outcome.costUsd ?? estimateCostUsd(outcome.model, outcome.promptTokens, outcome.completionTokens)
  }
  try {
    const { error } = await admin.rpc('settle_llm_spend', { p_id: res.id, p_actual: actual })
    if (error) throw error
  } catch (err) {
    console.error('[spend] failed to settle LLM spend; the sweeper will charge the estimate', err)
  }
}

/** What the provider says a call cost: OpenRouter's usage.cost (USD), plus the
 *  upstream provider's own charge when the key is bring-your-own. Undefined when
 *  the response carries no usable figure, so the caller falls back to PRICES. */
export function actualCostUsd(usage: unknown): number | undefined {
  const u = usage as { cost?: unknown; is_byok?: unknown; cost_details?: { upstream_inference_cost?: unknown } } | null | undefined
  if (typeof u?.cost !== 'number' || !Number.isFinite(u.cost) || u.cost < 0) return undefined
  const upstream = u.cost_details?.upstream_inference_cost
  return u.is_byok === true && typeof upstream === 'number' && Number.isFinite(upstream) && upstream > 0
    ? u.cost + upstream
    : u.cost
}

export interface SpendState {
  periodStart: string
  spentUsd: number
  heldUsd: number
  capUsd: number
}

/** This month's settled spend, what in-flight calls hold, and the user's cap. */
export async function getSpendState(admin: AdminClient, userId: string): Promise<SpendState> {
  const { data, error } = await admin.rpc('llm_spend_state', { p_user_id: userId })
  const row = data as { period?: string; spent_usd?: number; held_usd?: number; cap_usd?: number } | null
  if (error || !row) throw new Error('spend ledger unavailable')
  return {
    periodStart: String(row.period ?? '').slice(0, 7),
    spentUsd: Number(row.spent_usd ?? 0),
    heldUsd: Number(row.held_usd ?? 0),
    capUsd: Number(row.cap_usd ?? DEFAULT_MONTHLY_USD),
  }
}

/**
 * A read-only early refusal for a route that would rather say "you are out of
 * allowance" before doing any work. NOT the enforcement: that is reserveSpend,
 * which is the only thing that holds money.
 */
export async function assertWithinBudget(admin: AdminClient, userId: string): Promise<void> {
  const state = await getSpendState(admin, userId)
  const committed = state.spentUsd + state.heldUsd
  if (committed >= state.capUsd) throw new BudgetCapError(committed, state.capUsd)
}

/** True when the caller supplied the context needed to meter spend. */
export function canMeter(keys: DecryptedApiKeys): boolean {
  return Boolean(keys.userId)
}
