// Tests for the hard monthly spend cap (lib/harness/spend.ts) — the single
// choke point that stops a background cron from quietly burning a user's
// whole month's AI budget. ZERO network, ZERO real LLM calls, ZERO real DB:
// AdminClient is an in-memory fake built per test (see fakeAdmin below).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BudgetCapError,
  DEFAULT_MONTHLY_USD,
  assertWithinBudget,
  canMeter,
  estimateCostUsd,
  getSpendState,
  recordSpend,
} from './spend'
import type { AdminClient } from './types'

/** Minimal in-memory fake of the exact PostgREST chain shape spend.ts uses:
 *  `.from('profiles').select('preferences').eq('id', userId).single()` and
 *  `.from('profiles').update({ preferences }).eq('id', userId)`. Not a
 *  general Supabase mock — just enough surface for this one table. */
function fakeAdmin(initialPreferences: Record<string, unknown> | null): {
  admin: AdminClient
  getPreferences: () => Record<string, unknown> | null
} {
  let preferences = initialPreferences

  function selectBuilder() {
    const builder = {
      eq(_col: string, _val: string) {
        return builder
      },
      async single() {
        return { data: preferences === null ? null : { preferences }, error: null }
      },
    }
    return builder
  }

  function updateBuilder(patch: { preferences: Record<string, unknown> }) {
    const builder = {
      eq(_col: string, _val: string) {
        preferences = patch.preferences
        return Promise.resolve({ data: null, error: null })
      },
    }
    return builder
  }

  const admin = {
    from(_table: string) {
      return {
        select: () => selectBuilder(),
        update: (patch: { preferences: Record<string, unknown> }) => updateBuilder(patch),
      }
    },
  }
  return { admin: admin as unknown as AdminClient, getPreferences: () => preferences }
}

/** Current UTC billing period in the same "YYYY-MM" shape spend.ts computes
 *  internally, so tests can assert against a real period without importing
 *  the (unexported) currentPeriod helper. */
function currentPeriod(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

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

  it('zero tokens costs zero even for an unknown model', () => {
    expect(estimateCostUsd('unknown/model', 0, 0)).toBe(0)
  })
})

describe('getSpendState / readState', () => {
  it('a user with no preferences row gets the default cap and zero spend', async () => {
    const { admin } = fakeAdmin(null)
    const state = await getSpendState(admin, 'user-1')
    expect(state.spentUsd).toBe(0)
    expect(state.capUsd).toBe(DEFAULT_MONTHLY_USD)
    expect(state.periodStart).toBe(currentPeriod())
  })

  it('reads an existing in-period spend + custom cap unchanged', async () => {
    const { admin } = fakeAdmin({ budget: { periodStart: currentPeriod(), spentUsd: 3.5, monthlyUsd: 20 } })
    const state = await getSpendState(admin, 'user-1')
    expect(state.spentUsd).toBe(3.5)
    expect(state.capUsd).toBe(20)
    expect(state.periodStart).toBe(currentPeriod())
  })

  it('a stored period different from the current one resets spend to zero (new billing month), but keeps the configured cap', async () => {
    const { admin } = fakeAdmin({ budget: { periodStart: '2020-01', spentUsd: 999, monthlyUsd: 20 } })
    const state = await getSpendState(admin, 'user-1')
    expect(state.spentUsd).toBe(0)
    expect(state.periodStart).toBe(currentPeriod())
    // The user's configured monthly cap is read independent of the period
    // check, so a rollover resets spend but must NOT silently reset the cap
    // back to default.
    expect(state.capUsd).toBe(20)
  })

  it('a non-positive or non-numeric monthlyUsd falls back to the default cap', async () => {
    const { admin } = fakeAdmin({ budget: { periodStart: currentPeriod(), spentUsd: 1, monthlyUsd: -5 } })
    const state = await getSpendState(admin, 'user-1')
    expect(state.capUsd).toBe(DEFAULT_MONTHLY_USD)
  })

  it('a negative stored spentUsd is treated as zero, never negative', async () => {
    const { admin } = fakeAdmin({ budget: { periodStart: currentPeriod(), spentUsd: -10, monthlyUsd: 20 } })
    const state = await getSpendState(admin, 'user-1')
    expect(state.spentUsd).toBe(0)
  })
})

describe('assertWithinBudget', () => {
  it('does not throw when spend is well under the cap', async () => {
    const { admin } = fakeAdmin({ budget: { periodStart: currentPeriod(), spentUsd: 1, monthlyUsd: 10 } })
    await expect(assertWithinBudget(admin, 'user-1')).resolves.toBeUndefined()
  })

  it('throws BudgetCapError when spend is exactly AT the cap', async () => {
    const { admin } = fakeAdmin({ budget: { periodStart: currentPeriod(), spentUsd: 10, monthlyUsd: 10 } })
    await expect(assertWithinBudget(admin, 'user-1')).rejects.toBeInstanceOf(BudgetCapError)
  })

  it('throws BudgetCapError when spend is OVER the cap', async () => {
    const { admin } = fakeAdmin({ budget: { periodStart: currentPeriod(), spentUsd: 15, monthlyUsd: 10 } })
    await expect(assertWithinBudget(admin, 'user-1')).rejects.toBeInstanceOf(BudgetCapError)
  })

  it('the thrown error carries the exact spent/cap figures for an honest user-facing message', async () => {
    const { admin } = fakeAdmin({ budget: { periodStart: currentPeriod(), spentUsd: 12, monthlyUsd: 10 } })
    try {
      await assertWithinBudget(admin, 'user-1')
      throw new Error('expected assertWithinBudget to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetCapError)
      const capErr = err as BudgetCapError
      expect(capErr.spentUsd).toBe(12)
      expect(capErr.capUsd).toBe(10)
      expect(capErr.message).toContain('$12.00')
      expect(capErr.message).toContain('$10.00')
    }
  })

  it('a fresh billing month is never blocked, even if last month ended over cap', async () => {
    const { admin } = fakeAdmin({ budget: { periodStart: '2020-01', spentUsd: 9999, monthlyUsd: 10 } })
    await expect(assertWithinBudget(admin, 'user-1')).resolves.toBeUndefined()
  })
})

describe('recordSpend', () => {
  it('accumulates cost onto existing spend for a known model', async () => {
    const { admin, getPreferences } = fakeAdmin({
      budget: { periodStart: currentPeriod(), spentUsd: 1, monthlyUsd: 10 },
    })

    await recordSpend(admin, 'user-1', 'anthropic/claude-sonnet-5', 1_000_000, 1_000_000)

    const prefs = getPreferences() as { budget: { spentUsd: number; monthlyUsd: number; periodStart: string } }
    // 1 (existing) + 2 (in) + 10 (out) = 13.
    expect(prefs.budget.spentUsd).toBe(13)
    expect(prefs.budget.monthlyUsd).toBe(10)
    expect(prefs.budget.periodStart).toBe(currentPeriod())
  })

  it('starts a fresh accumulation in a new billing period rather than carrying stale spend', async () => {
    const { admin, getPreferences } = fakeAdmin({
      budget: { periodStart: '2020-01', spentUsd: 9999, monthlyUsd: 10 },
    })

    await recordSpend(admin, 'user-1', 'anthropic/claude-haiku-4.5', 1_000_000, 0)

    const prefs = getPreferences() as { budget: { spentUsd: number; periodStart: string } }
    expect(prefs.budget.spentUsd).toBe(1) // haiku in-price is 1/million, no stale 9999 carried over
    expect(prefs.budget.periodStart).toBe(currentPeriod())
  })

  it('preserves other preference keys untouched (only the budget key is replaced)', async () => {
    const { admin, getPreferences } = fakeAdmin({
      theme: 'dark',
      budget: { periodStart: currentPeriod(), spentUsd: 0, monthlyUsd: 10 },
    })

    await recordSpend(admin, 'user-1', 'anthropic/claude-sonnet-5', 0, 0)

    const prefs = getPreferences() as { theme: string }
    expect(prefs.theme).toBe('dark')
  })

  it('never throws on a bookkeeping failure — a DB error is swallowed, not propagated', async () => {
    const brokenAdmin = {
      from() {
        return {
          select() {
            return {
              eq() {
                return this
              },
              async single() {
                throw new Error('simulated DB outage')
              },
            }
          },
        }
      },
    } as unknown as AdminClient

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(recordSpend(brokenAdmin, 'user-1', 'anthropic/claude-sonnet-5', 100, 100)).resolves.toBeUndefined()
    expect(consoleSpy).toHaveBeenCalled() // logged loudly, per the source comment
    consoleSpy.mockRestore()
  })

  it('never throws even when the update step itself fails', async () => {
    const adminUpdateFails = {
      from() {
        return {
          select() {
            return {
              eq() {
                return this
              },
              async single() {
                return { data: { preferences: { budget: { periodStart: currentPeriod(), spentUsd: 0, monthlyUsd: 10 } } }, error: null }
              },
            }
          },
          update() {
            return {
              eq() {
                throw new Error('simulated write failure')
              },
            }
          },
        }
      },
    } as unknown as AdminClient

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(recordSpend(adminUpdateFails, 'user-1', 'anthropic/claude-sonnet-5', 100, 100)).resolves.toBeUndefined()
    expect(consoleSpy).toHaveBeenCalled()
    consoleSpy.mockRestore()
  })
})

describe('canMeter', () => {
  it('true when userId is present', () => {
    expect(canMeter({ openrouter: 'key', userId: 'user-1' })).toBe(true)
  })

  it('false when userId is absent — spend cannot be enforced without a user to attribute it to', () => {
    expect(canMeter({ openrouter: 'key' })).toBe(false)
  })
})
