// One rule, tested on its own:
//
//   RE-ENTERING AN ACCESS CODE MUST NOT REFILL THE DEMO'S ALLOWANCE.
//
// A demo user can re-enter their code as many times as they like, and
// app/api/access/redeem re-runs provisioning whenever a first redemption failed
// mid-seed. What a demo has SPENT used to ride along in preferences.budget and
// had to be carried forward by hand by both lib/access/guardrails.ts and
// lib/access/seed-demo.ts. It now lives in the llm_spend ledger (migration
// 20261008030000), which only the service role writes, so the rule holds by
// construction: provisioning and re-seeding write the CAP and nothing else, and
// there is no spend field on the profile to zero. The ledger itself is proven
// against a real database in lib/harness/spend.db.test.ts.
//
// Kept separate from guardrails.test.ts so the invariant is findable by name.

import { describe, expect, it } from 'vitest'
import { DEMO_MONTHLY_USD, demoBudget, demoProfilePreferences } from './guardrails'
import { buildDemoPreferences } from './seed-demo'

describe('demoBudget', () => {
  it('is the cap and nothing else, for a fresh workspace and for junk input', () => {
    for (const input of [undefined, null, {}, 'nonsense', 42, [], { budget: 1 }]) {
      expect(demoBudget(input)).toEqual({ monthlyUsd: DEMO_MONTHLY_USD })
    }
  })

  it('writes no spend counters, whatever the row already carried', () => {
    const carried = demoBudget({ periodStart: '2026-08', spentUsd: 0.9, monthlyUsd: DEMO_MONTHLY_USD })
    expect(carried).toEqual({ monthlyUsd: DEMO_MONTHLY_USD })
    expect(carried).not.toHaveProperty('spentUsd')
    expect(carried).not.toHaveProperty('periodStart')
  })

  it('never RAISES the cap, the demo ceiling only goes down', () => {
    expect(demoBudget({ monthlyUsd: 250 }).monthlyUsd).toBe(DEMO_MONTHLY_USD)
    expect(demoBudget({ monthlyUsd: 0.25 }).monthlyUsd).toBe(0.25)
  })
})

describe('demoProfilePreferences, whose cap is whose', () => {
  const ownerPreferences = {
    api_keys: { openrouter: 'enc:owner-key' },
    budget: { monthlyUsd: 250 },
  }

  it('NEVER takes the cap from the owner', () => {
    expect(demoProfilePreferences(ownerPreferences).budget).toEqual({ monthlyUsd: DEMO_MONTHLY_USD })
  })

  it('cannot be raised by a caller passing a bigger budget in `seed`', () => {
    const prefs = demoProfilePreferences(ownerPreferences, { budget: { monthlyUsd: 50 } }, { budget: { monthlyUsd: 1 } })
    expect(prefs.budget).toEqual({ monthlyUsd: DEMO_MONTHLY_USD })
  })

  it('still forces every other guardrail', () => {
    const existing = {
      provider: { active: 'local-cli', localCli: 'claude', localServerBaseUrl: 'http://10.0.0.5:11434' },
      gmail_permissions: { send: { enabled: true, grantedAt: null, revokedAt: null, migratedFrom: null } },
      targeting: { titles: ['Staff Engineer'] },
    }
    const prefs = demoProfilePreferences(ownerPreferences, {}, existing)
    expect((prefs.provider as { active: string }).active).toBe('openrouter')
    expect((prefs.gmail_permissions as { send: { enabled: boolean } }).send.enabled).toBe(false)
    expect(prefs.targeting).toBeUndefined()
  })
})

describe('provisioning and re-seeding agree', () => {
  it('both write the cap only, and re-seeding keeps the lower cap', () => {
    const provisioned = demoProfilePreferences(null, {}, { budget: { monthlyUsd: 0.5, spentUsd: 0.4, periodStart: '2026-08' } })
    const reseeded = buildDemoPreferences(provisioned)
    expect(provisioned.budget).toEqual({ monthlyUsd: 0.5 })
    expect(reseeded.budget).toEqual({ monthlyUsd: 0.5 })
  })
})
