// Tests for the hard monthly spend cap (lib/harness/spend.ts): the pure price
// and estimate maths, and the reserve/settle client against a recording fake.
// ZERO network, ZERO real LLM calls. The atomic arithmetic itself (parallel
// reservations, rollover, sweeper, demo pool) is proven against a REAL Postgres
// in spend.db.test.ts.

import { describe, expect, it, vi } from 'vitest'
import {
  BudgetCapError,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MONTHLY_USD,
  actualCostUsd,
  assertWithinBudget,
  canMeter,
  estimateCostDetails,
  estimateCostUsd,
  estimatePromptTokens,
  getSpendState,
  hasListedPrice,
  reserveSpend,
  settleSpend,
  worstCaseUsd,
} from './spend'
import type { AdminClient } from './types'

describe('estimateCostUsd', () => {
  it('prices a known model correctly (per-million-token in/out rates)', () => {
    // anthropic/claude-sonnet-5: { in: 2, out: 10 } per PRICES table.
    const cost = estimateCostUsd('anthropic/claude-sonnet-5', 1_000_000, 1_000_000)
    expect(cost).toBeCloseTo(2 + 10, 6)
  })

  it('prices a fractional token count proportionally', () => {
    const cost = estimateCostUsd('anthropic/claude-haiku-4.5', 500_000, 200_000)
    // in: 1, out: 5 per million.
    expect(cost).toBeCloseTo(0.5 * 1 + 0.2 * 5, 6)
  })

  it('the cheap bulk models are priced at their published rates, not the $5/$25 fallback', () => {
    expect(estimateCostUsd('google/gemini-2.0-flash-001', 1_000_000, 1_000_000)).toBeCloseTo(0.1 + 0.4, 6)
    expect(estimateCostUsd('openai/gpt-4o-mini', 1_000_000, 1_000_000)).toBeCloseTo(0.15 + 0.6, 6)
  })

  it('an UNKNOWN model falls back to the MOST EXPENSIVE known rate, never zero', () => {
    const unknownCost = estimateCostUsd('some/unrecognized-model-xyz', 1_000_000, 1_000_000)
    // FALLBACK_PRICE = { in: 5, out: 25 } — the most expensive entry in PRICES
    // (anthropic/claude-opus-4.8 is also 5/25, so fallback matches the ceiling).
    expect(unknownCost).toBeCloseTo(5 + 25, 6)

    // The fallback must be >= every known model's cost for the same token
    // counts — otherwise an unknown model could under-count spend, which is
    // exactly the failure mode this fallback exists to prevent.
    const knownModels = [
      'anthropic/claude-sonnet-5',
      'anthropic/claude-opus-4.8',
      'anthropic/claude-haiku-4.5',
      'openai/gpt-5.2',
      'moonshotai/kimi-k3',
      'moonshotai/kimi-k2-thinking',
      'google/gemini-2.5-flash',
    ]
    for (const model of knownModels) {
      const knownCost = estimateCostUsd(model, 1_000_000, 1_000_000)
      expect(unknownCost).toBeGreaterThanOrEqual(knownCost)
    }
  })

  it('a :free OpenRouter model costs nothing and is a listed price, not the fallback', () => {
    expect(estimateCostUsd('google/gemma-4-31b-it:free', 1_000_000, 1_000_000)).toBe(0)
    expect(estimateCostDetails('qwen/qwen3.8-27b:free', 1_000_000, 1_000_000)).toEqual({ input: 0, output: 0 })
    expect(hasListedPrice('google/gemma-4-31b-it:free')).toBe(true)
    // The suffix must be exact: a paid model whose id merely contains "free" stays on the fallback.
    expect(estimateCostUsd('some/free-model', 1_000_000, 0)).toBeCloseTo(5, 6)
  })

  it('zero tokens costs zero even for an unknown model', () => {
    expect(estimateCostUsd('unknown/model', 0, 0)).toBe(0)
  })
})

/** A recording fake of the one method spend.ts uses on the admin client. */
function rpcAdmin(reply: (fn: string, args: Record<string, unknown>) => { data?: unknown; error?: { message: string } | null }) {
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => ({ data: null, error: null, ...reply(fn, args) }))
  return { admin: { rpc } as unknown as AdminClient, rpc }
}

const SONNET = 'anthropic/claude-sonnet-5'

describe('estimatePromptTokens and worstCaseUsd', () => {
  it('estimates 3 characters per token plus 8 per message, rounded up', () => {
    expect(estimatePromptTokens('x'.repeat(300))).toBe(100 + 8)
    expect(estimatePromptTokens('x'.repeat(301), 3)).toBe(101 + 24)
    expect(estimatePromptTokens('')).toBe(8)
  })

  it('worst case is the prompt at the input price plus the WHOLE max_tokens at the output price', () => {
    // sonnet-5: $2 in, $10 out per M. 1000 in = 0.002, 2048 out = 0.02048.
    expect(worstCaseUsd(SONNET, 1000, DEFAULT_MAX_TOKENS)).toBeCloseTo(0.02248, 6)
  })

  it('a :free model reserves zero, and an unknown model the most expensive rate', () => {
    expect(worstCaseUsd('google/gemma-4-31b-it:free', 1_000_000, 100_000)).toBe(0)
    expect(worstCaseUsd('some/unrecognized-model', 1_000_000, 0)).toBe(5)
  })

  it('rounds UP to the ledger precision, never down', () => {
    // 1 token at $0.02/M is $0.00000002, which a 6-decimal column would store as 0.
    expect(worstCaseUsd('openai/text-embedding-3-small', 1, 0)).toBe(0.000001)
  })
})

describe('reserveSpend', () => {
  const input = { userId: 'user-1', model: SONNET, promptTokens: 1000, maxTokens: 2048, traceId: 'trace-1' }

  it('reserves the worst case in ONE rpc and returns the reservation id', async () => {
    const { admin, rpc } = rpcAdmin(() => ({ data: { ok: true, id: 'res-9' } }))
    const res = await reserveSpend(admin, input)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('reserve_llm_spend', {
      p_user_id: 'user-1',
      p_model: SONNET,
      p_estimate: 0.02248,
      p_trace_id: 'trace-1',
    })
    expect(res).toEqual({ id: 'res-9', userId: 'user-1', model: SONNET, estimateUsd: 0.02248 })
  })

  it('a free model makes no database call at all', async () => {
    const { admin, rpc } = rpcAdmin(() => ({ data: { ok: true, id: 'never' } }))
    const res = await reserveSpend(admin, { ...input, model: 'google/gemma-4-31b-it:free' })
    expect(res.id).toBeNull()
    expect(res.estimateUsd).toBe(0)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('a refusal becomes a BudgetCapError carrying the figures and the scope', async () => {
    const { admin } = rpcAdmin(() => ({ data: { ok: false, scope: 'user', spent_usd: 9.99, cap_usd: 10 } }))
    const err = await reserveSpend(admin, input).catch((e) => e)
    expect(err).toBeInstanceOf(BudgetCapError)
    expect(err).toMatchObject({ spentUsd: 9.99, capUsd: 10, scope: 'user' })
    expect(err.message).toContain('$9.99')

    const { admin: pool } = rpcAdmin(() => ({ data: { ok: false, scope: 'demo-pool', spent_usd: 5, cap_usd: 5 } }))
    const poolErr = await reserveSpend(pool, input).catch((e) => e)
    expect(poolErr).toMatchObject({ scope: 'demo-pool', capUsd: 5 })
  })

  it('an unreachable ledger refuses the call: it is never read as free', async () => {
    const { admin } = rpcAdmin(() => ({ error: { message: 'connection refused' } }))
    await expect(reserveSpend(admin, input)).rejects.toThrow('spend ledger unavailable')
    const { admin: empty } = rpcAdmin(() => ({ data: null }))
    await expect(reserveSpend(empty, input)).rejects.toThrow('spend ledger unavailable')
  })
})

describe('settleSpend', () => {
  const res = { id: 'res-1', userId: 'user-1', model: SONNET, estimateUsd: 0.02 }

  it('settles the provider-reported cost over our own estimate', async () => {
    const { admin, rpc } = rpcAdmin(() => ({ data: true }))
    await settleSpend(admin, res, { model: SONNET, promptTokens: 1_000_000, completionTokens: 1_000_000, costUsd: 0.00042 })
    expect(rpc).toHaveBeenCalledWith('settle_llm_spend', { p_id: 'res-1', p_actual: 0.00042 })
  })

  it('falls back to the price table when the provider reported no cost', async () => {
    const { admin, rpc } = rpcAdmin(() => ({ data: true }))
    await settleSpend(admin, res, { model: SONNET, promptTokens: 1_000_000, completionTokens: 1_000_000 })
    expect(rpc).toHaveBeenCalledWith('settle_llm_spend', { p_id: 'res-1', p_actual: 12 })
  })

  it('a provider error with an HTTP status settles at zero', async () => {
    const { admin, rpc } = rpcAdmin(() => ({ data: true }))
    await settleSpend(admin, res, { failed: Object.assign(new Error('rate limited'), { status: 429 }) })
    expect(rpc).toHaveBeenCalledWith('settle_llm_spend', { p_id: 'res-1', p_actual: 0 })
  })

  it('an abort or network failure is left reserved for the sweeper', async () => {
    const { admin, rpc } = rpcAdmin(() => ({ data: true }))
    await settleSpend(admin, res, { failed: new DOMException('aborted', 'AbortError') })
    await settleSpend(admin, res, { failed: new Error('socket hang up') })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('a reservation with no id (a free model) is a no-op', async () => {
    const { admin, rpc } = rpcAdmin(() => ({ data: true }))
    await settleSpend(admin, { ...res, id: null }, { model: SONNET, promptTokens: 1, completionTokens: 1 })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('never throws on an rpc error or a thrown rpc, and logs loudly', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { admin } = rpcAdmin(() => ({ error: { message: 'function not found' } }))
    await expect(settleSpend(admin, res, { model: SONNET, promptTokens: 1, completionTokens: 1 })).resolves.toBeUndefined()
    const throwing = {
      rpc() {
        throw new Error('simulated DB outage')
      },
    } as unknown as AdminClient
    await expect(settleSpend(throwing, res, { model: SONNET, promptTokens: 1, completionTokens: 1 })).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalledTimes(2)
    spy.mockRestore()
  })
})

describe('actualCostUsd', () => {
  it('reads usage.cost', () => {
    expect(actualCostUsd({ cost: 0.00042, is_byok: false })).toBe(0.00042)
    expect(actualCostUsd({ cost: 0 })).toBe(0)
  })

  it('adds the upstream charge only for a bring-your-own-key request', () => {
    const usage = { cost: 0.001, cost_details: { upstream_inference_cost: 0.019 } }
    expect(actualCostUsd({ ...usage, is_byok: true })).toBeCloseTo(0.02, 9)
    expect(actualCostUsd({ ...usage, is_byok: false })).toBe(0.001)
  })

  it('is undefined when there is no usable figure, so the caller uses the price table', () => {
    for (const bad of [undefined, null, {}, { cost: '0.1' }, { cost: -1 }, { cost: Number.NaN }, 'x']) {
      expect(actualCostUsd(bad)).toBeUndefined()
    }
  })
})

describe('getSpendState and assertWithinBudget', () => {
  const state = (over: Record<string, unknown> = {}) => ({
    data: { period: '2026-10-01', spent_usd: 3.5, held_usd: 0.5, cap_usd: 20, ...over },
  })

  it('maps the ledger state', async () => {
    const { admin, rpc } = rpcAdmin(() => state())
    expect(await getSpendState(admin, 'user-1')).toEqual({ periodStart: '2026-10', spentUsd: 3.5, heldUsd: 0.5, capUsd: 20 })
    expect(rpc).toHaveBeenCalledWith('llm_spend_state', { p_user_id: 'user-1' })
  })

  it('throws when the ledger cannot be read', async () => {
    const { admin } = rpcAdmin(() => ({ error: { message: 'down' } }))
    await expect(getSpendState(admin, 'user-1')).rejects.toThrow('spend ledger unavailable')
  })

  it('the read-only pre-check counts money held for work in progress', async () => {
    const { admin } = rpcAdmin(() => state({ spent_usd: 9.5, held_usd: 0.5, cap_usd: 10 }))
    const err = await assertWithinBudget(admin, 'user-1').catch((e) => e)
    expect(err).toBeInstanceOf(BudgetCapError)
    expect(err).toMatchObject({ spentUsd: 10, capUsd: 10 })
    const { admin: ok } = rpcAdmin(() => state())
    await expect(assertWithinBudget(ok, 'user-1')).resolves.toBeUndefined()
  })

  it('the default cap constant is unchanged', () => {
    expect(DEFAULT_MONTHLY_USD).toBe(10)
  })
})

describe('canMeter', () => {
  it('true when userId is present', () => {
    expect(canMeter({ openrouter: 'key', userId: 'user-1' })).toBe(true)
  })

  it('false when userId is absent: spend cannot be enforced without a user to attribute it to', () => {
    expect(canMeter({ openrouter: 'key' })).toBe(false)
  })
})
