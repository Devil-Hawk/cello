// One rule, tested on its own because two files used to disagree about it:
//
//   RE-ENTERING AN ACCESS CODE MUST NOT REFILL THE DEMO'S ALLOWANCE.
//
// lib/access/seed-demo.ts's buildDemoPreferences has always preserved
// `spentUsd` on a re-seed, and says why in a comment: a demo user can re-enter
// their code as many times as they like, so a re-seed that zeroed the ledger
// would make the $1 cap a decoration. lib/access/guardrails.ts's
// demoProfilePreferences forced `spentUsd: 0`, and app/api/access/redeem
// re-runs it whenever a first redemption failed mid-seed and released its
// claim — so the preserving side could be quietly undone by the provisioning
// side. This file pins the reconciliation: the PRESERVING behaviour wins, in
// both modules, and it is checked through the real lib/harness/spend.ts because
// that is the only thing that ever interprets the block.
//
// Kept separate from guardrails.test.ts so the cross-module invariant is
// findable by name rather than buried among the send and expiry cases.

import { describe, expect, it } from 'vitest'
import { DEMO_MONTHLY_USD, demoBudget, demoProfilePreferences } from './guardrails'
import { buildDemoPreferences } from './seed-demo'
import { assertWithinBudget, getSpendState, BudgetCapError } from '@/lib/harness/spend'
import type { AdminClient } from '@/lib/harness/types'

const DEMO_ID = 'demo-user-1'

/** The UTC month spend.ts is currently in — its reset test compares against it. */
function currentPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

/** The PostgREST chain spend.ts uses, over an in-memory preferences map. */
function fakeAdmin(rows: Record<string, Record<string, unknown>>): AdminClient {
  function selectBuilder() {
    let target = ''
    const builder = {
      eq(_column: string, value: string) {
        target = value
        return builder
      },
      async single() {
        const preferences = rows[target]
        return { data: preferences === undefined ? null : { preferences }, error: null }
      },
    }
    return builder
  }

  const admin = {
    from(_table: string) {
      return {
        select: () => selectBuilder(),
        update: (patch: { preferences: Record<string, unknown> }) => ({
          eq(_column: string, value: string) {
            rows[value] = patch.preferences
            return Promise.resolve({ data: null, error: null })
          },
        }),
      }
    },
  }
  return admin as unknown as AdminClient
}

describe('demoBudget — a fresh workspace', () => {
  it('is unchanged: an empty ledger and an empty period', () => {
    // '' fails spend.ts's `period !== currentPeriod()` test, which is how a new
    // workspace gets a zeroed counter without this file knowing that format.
    expect(demoBudget()).toEqual({ periodStart: '', spentUsd: 0, monthlyUsd: DEMO_MONTHLY_USD })
  })

  it('treats a missing, empty or junk budget block as fresh', () => {
    for (const input of [undefined, null, {}, 'nonsense', 42, [], { budget: 1 }]) {
      expect(demoBudget(input)).toEqual({ periodStart: '', spentUsd: 0, monthlyUsd: DEMO_MONTHLY_USD })
    }
  })
})

describe('demoBudget — a workspace that has already spent', () => {
  it('CARRIES THE SPEND FORWARD rather than zeroing it', () => {
    const period = currentPeriod()
    expect(demoBudget({ periodStart: period, spentUsd: 0.9, monthlyUsd: DEMO_MONTHLY_USD })).toEqual({
      periodStart: period,
      spentUsd: 0.9,
      monthlyUsd: DEMO_MONTHLY_USD,
    })
  })

  it('carries the PERIOD with it, because spend without a period reads back as zero', () => {
    // The subtle half of the bug: spend.ts resets the counter whenever the
    // stored period is not the current one, so preserving `spentUsd: 0.9` under
    // `periodStart: ''` would be theatre. Asserted through spend.ts itself
    // below; this pins the shape.
    const carried = demoBudget({ periodStart: currentPeriod(), spentUsd: 0.9, monthlyUsd: 1 })
    expect(carried.periodStart).toBe(currentPeriod())
  })

  it('never RAISES the cap — the demo ceiling only goes down', () => {
    // A profile carrying $250 is the owner-shaped number this must not inherit.
    expect(demoBudget({ periodStart: '2026-08', spentUsd: 0.5, monthlyUsd: 250 }).monthlyUsd).toBe(
      DEMO_MONTHLY_USD
    )
    // And an already-lower ceiling is kept: provisioning is not a way to buy
    // headroom back.
    expect(demoBudget({ periodStart: '2026-08', spentUsd: 0.1, monthlyUsd: 0.25 }).monthlyUsd).toBe(0.25)
  })

  it('reads a corrupt spend as zero rather than as a negative allowance', () => {
    for (const spentUsd of [-5, Number.NaN, '0.9', null]) {
      expect(demoBudget({ periodStart: currentPeriod(), spentUsd, monthlyUsd: 1 }).spentUsd).toBe(0)
    }
  })
})

describe('demoProfilePreferences — whose ledger is whose', () => {
  const ownerPreferences = {
    api_keys: { openrouter: 'enc:owner-key' },
    budget: { periodStart: currentPeriod(), spentUsd: 4.2, monthlyUsd: 250 },
  }

  it('NEVER takes the ledger from the owner, however much they have spent', () => {
    // The owner's spend is the owner's. Copying it would charge a stranger's
    // demo for the owner's month before it had made a single call.
    const prefs = demoProfilePreferences(ownerPreferences)
    expect(prefs.budget).toEqual({ periodStart: '', spentUsd: 0, monthlyUsd: DEMO_MONTHLY_USD })
  })

  it('takes the ledger from the DEMO’s own existing preferences', () => {
    const existing = { budget: { periodStart: currentPeriod(), spentUsd: 0.87, monthlyUsd: 1 } }
    const prefs = demoProfilePreferences(ownerPreferences, {}, existing)

    expect(prefs.budget).toEqual({
      periodStart: currentPeriod(),
      spentUsd: 0.87,
      monthlyUsd: DEMO_MONTHLY_USD,
    })
  })

  it('still forces every other guardrail while preserving the ledger', () => {
    // Preserving spend must not become a crack that lets a previous, possibly
    // half-provisioned row keep anything else. Only the ledger survives.
    const existing = {
      budget: { periodStart: currentPeriod(), spentUsd: 0.5, monthlyUsd: 1 },
      provider: { active: 'local-cli', localCli: 'claude', localServerBaseUrl: 'http://10.0.0.5:11434' },
      gmail_permissions: { send: { enabled: true, grantedAt: null, revokedAt: null, migratedFrom: null } },
      targeting: { titles: ['Staff Engineer'] },
    }
    const prefs = demoProfilePreferences(ownerPreferences, {}, existing)

    expect((prefs.provider as { active: string }).active).toBe('openrouter')
    expect((prefs.gmail_permissions as { send: { enabled: boolean } }).send.enabled).toBe(false)
    expect(prefs.targeting).toBeUndefined()
    expect((prefs.budget as { spentUsd: number }).spentUsd).toBe(0.5)
  })

  it('cannot be refilled by a caller passing a zeroed budget in `seed`', () => {
    const existing = { budget: { periodStart: currentPeriod(), spentUsd: 0.99, monthlyUsd: 1 } }
    const prefs = demoProfilePreferences(
      ownerPreferences,
      { budget: { periodStart: currentPeriod(), spentUsd: 0, monthlyUsd: 50 } },
      existing
    )

    expect(prefs.budget).toEqual({
      periodStart: currentPeriod(),
      spentUsd: 0.99,
      monthlyUsd: DEMO_MONTHLY_USD,
    })
  })
})

describe('the two modules now agree', () => {
  it('provisioning and re-seeding preserve the same ledger', () => {
    // seed-demo.ts owns RE-SEEDING and guardrails.ts owns PROVISIONING. They
    // run against the same row, in that order, on a redemption that retries
    // after a failed seed. If either resets the counter the other's preservation
    // is worthless, so the invariant is that both agree.
    const spent = { budget: { periodStart: currentPeriod(), spentUsd: 0.73, monthlyUsd: 1 } }

    const provisioned = demoProfilePreferences(null, {}, spent)
    const reseeded = buildDemoPreferences(provisioned)

    expect((provisioned.budget as { spentUsd: number }).spentUsd).toBe(0.73)
    expect((reseeded.budget as { spentUsd: number }).spentUsd).toBe(0.73)
    expect((reseeded.budget as { monthlyUsd: number }).monthlyUsd).toBe(DEMO_MONTHLY_USD)
  })
})

describe('through the REAL spend.ts — re-entering a code is not a refill', () => {
  it('a demo at its cap is STILL at its cap after being re-provisioned', async () => {
    // The whole point, end to end. A demo that has burned its dollar re-enters
    // the code (or a failed first redemption is retried, which re-provisions).
    // If the ledger were rebuilt, the very next model call would be allowed.
    const burned = { budget: { periodStart: currentPeriod(), spentUsd: DEMO_MONTHLY_USD, monthlyUsd: DEMO_MONTHLY_USD } }

    const rows: Record<string, Record<string, unknown>> = {
      [DEMO_ID]: demoProfilePreferences(null, {}, burned),
    }
    const admin = fakeAdmin(rows)

    const state = await getSpendState(admin, DEMO_ID)
    expect(state.spentUsd).toBe(DEMO_MONTHLY_USD)
    expect(state.capUsd).toBe(DEMO_MONTHLY_USD)

    await expect(assertWithinBudget(admin, DEMO_ID)).rejects.toBeInstanceOf(BudgetCapError)
  })

  it('the OLD behaviour would have allowed the call — this is the regression guard', async () => {
    // Written as the counterexample on purpose: `spentUsd: 0` in the same shape
    // reads back as a full allowance. If someone re-forces zero, the test above
    // fails and this one explains what they broke.
    const refilled = { periodStart: '', spentUsd: 0, monthlyUsd: DEMO_MONTHLY_USD }
    const admin = fakeAdmin({ [DEMO_ID]: { budget: refilled } })

    await expect(assertWithinBudget(admin, DEMO_ID)).resolves.toBeUndefined()
  })

  it('a fresh workspace still starts at zero, and is allowed to spend', async () => {
    const admin = fakeAdmin({ [DEMO_ID]: demoProfilePreferences(null) })
    const state = await getSpendState(admin, DEMO_ID)

    expect(state.spentUsd).toBe(0)
    expect(state.capUsd).toBe(DEMO_MONTHLY_USD)
    await expect(assertWithinBudget(admin, DEMO_ID)).resolves.toBeUndefined()
  })
})
