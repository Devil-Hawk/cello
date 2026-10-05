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
// callLlm throws BudgetCapError and the feature reports it honestly, exactly
// like a missing key. Silently continuing to spend would be the worst outcome.

import type { AdminClient, DecryptedApiKeys } from './types'

/** Conservative default. Deliberately low: a user who never configures this
 *  should not be able to lose real money to a background cron. */
export const DEFAULT_MONTHLY_USD = 10

export class BudgetCapError extends Error {
  readonly spentUsd: number
  readonly capUsd: number
  constructor(spentUsd: number, capUsd: number) {
    super(
      `Monthly AI spend cap reached: $${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} used. ` +
        `Raise the cap in Settings, or wait for the next billing month.`
    )
    this.name = 'BudgetCapError'
    this.spentUsd = spentUsd
    this.capUsd = capUsd
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
  // (lib/harness/llm.ts) always passes completionTokens=0 to recordSpend.
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

/** Current UTC billing month, e.g. "2026-07". */
function currentPeriod(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

export interface SpendState {
  periodStart: string
  spentUsd: number
  capUsd: number
}

function readState(preferences: Record<string, unknown> | null | undefined): SpendState {
  const raw = (preferences?.budget ?? {}) as Record<string, unknown>
  const period = typeof raw.periodStart === 'string' ? raw.periodStart : ''
  const cap = typeof raw.monthlyUsd === 'number' && raw.monthlyUsd > 0 ? raw.monthlyUsd : DEFAULT_MONTHLY_USD
  // A new month resets the counter without needing a scheduled job.
  if (period !== currentPeriod()) return { periodStart: currentPeriod(), spentUsd: 0, capUsd: cap }
  return {
    periodStart: period,
    spentUsd: typeof raw.spentUsd === 'number' && raw.spentUsd > 0 ? raw.spentUsd : 0,
    capUsd: cap,
  }
}

export async function getSpendState(admin: AdminClient, userId: string): Promise<SpendState> {
  const { data } = await admin.from('profiles').select('preferences').eq('id', userId).single()
  return readState((data as { preferences?: Record<string, unknown> } | null)?.preferences)
}

/**
 * Throws BudgetCapError when the month's allowance is already spent.
 *
 * Checked BEFORE the call rather than after, because refunding a request that
 * already happened is not possible — the point is to not spend the money.
 */
export async function assertWithinBudget(admin: AdminClient, userId: string): Promise<void> {
  const state = await getSpendState(admin, userId)
  if (state.spentUsd >= state.capUsd) throw new BudgetCapError(state.spentUsd, state.capUsd)
}

/**
 * Record what a completed call cost. Best-effort: a bookkeeping failure must
 * never fail the user's request, but it is logged loudly because silent
 * under-counting is how a cap stops protecting anyone.
 */
export async function recordSpend(
  admin: AdminClient,
  userId: string,
  model: string,
  promptTokens: number,
  completionTokens: number
): Promise<void> {
  try {
    // One atomic UPDATE in Postgres (migration 20261005000005): parallel calls
    // for the same user serialise on the row lock instead of overwriting each
    // other's read-modify-write, and only preferences.budget is touched.
    const { error } = await admin.rpc('record_llm_spend', {
      p_user_id: userId,
      p_cost: estimateCostUsd(model, promptTokens, completionTokens),
    })
    if (error) throw error
  } catch (err) {
    console.error('[spend] failed to record LLM spend — the cap may under-count', err)
  }
}

/** True when the caller supplied the context needed to meter spend. */
export function canMeter(keys: DecryptedApiKeys): boolean {
  return Boolean(keys.userId)
}
