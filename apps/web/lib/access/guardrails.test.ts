// Tests for lib/access/guardrails.ts — the three rules that make it safe to
// hand a stranger a REAL, working account.
//
// WHY THIS FILE EXISTS
//   A demo user is a genuine Supabase auth user with a genuine profiles row, so
//   RLS does the isolation and every feature runs for real. That leaves exactly
//   three things RLS cannot decide — whose money a model call spends, whether an
//   email reaches a real human, and whether 72 hours have passed — and this file
//   is where each of those answers is pinned in executable form. Any future
//   change that loosens one has to delete an assertion that says out loud why it
//   existed.
//
//   Two of the three tests deliberately reach ACROSS files: the spend cases run
//   the real lib/harness/spend.ts against a fake DB, and the send cases compose
//   with the real canSendNow from lib/outreach/guardrails.ts. A demo guardrail
//   that is only correct in isolation is not correct — the failure modes here
//   are all about how this module meets the ones that already exist. The last
//   block in this file goes further still: it reads the lockdown migration and
//   the two settings routes, because "whose money" is only decided correctly if
//   the SQL, the module and the handlers all agree.
//
// No network, no real DB: the only fake is the PostgREST chain spend.ts uses.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEMO_MONTHLY_USD,
  DemoAccessError,
  assertDemoMaySend,
  assertDemoSessionActive,
  demoBudget,
  demoLockdownGate,
  demoProfilePreferences,
  demoSafeApiKeys,
  demoSendGate,
  demoSessionGate,
  demoSettingsGate,
  describeDemoTimeRemaining,
  firstRefusal,
  isDemoProfile,
  type DemoGate,
  type DemoProfileFacts,
} from './guardrails'
import { ACCESS_CODE_TTL_HOURS } from './codes'
import { canSendNow, type Gate } from '@/lib/outreach/guardrails'
import {
  DEFAULT_OUTREACH_PREFS,
  type OutreachMessageRow,
  type OutreachStatus,
} from '@/lib/outreach/types'
import {
  BudgetCapError,
  assertWithinBudget,
  estimateCostUsd,
  getSpendState,
  recordSpend,
} from '@/lib/harness/spend'
import type { AdminClient, DecryptedApiKeys } from '@/lib/harness/types'

const HOUR_MS = 60 * 60 * 1000
const OWNER_ID = 'owner-user-1'
const DEMO_ID = 'demo-user-1'

const ISSUED_AT = new Date('2026-08-03T09:00:00.000Z')
const EXPIRES_AT = new Date(ISSUED_AT.getTime() + ACCESS_CODE_TTL_HOURS * HOUR_MS)

function demoProfile(overrides: Partial<DemoProfileFacts> = {}): DemoProfileFacts & { id: string } {
  return {
    id: DEMO_ID,
    is_demo: true,
    demo_expires_at: EXPIRES_AT.toISOString(),
    ...overrides,
  }
}

function ownerProfile(overrides: Partial<DemoProfileFacts> = {}): DemoProfileFacts & { id: string } {
  return { id: OWNER_ID, is_demo: false, demo_expires_at: null, ...overrides }
}

/** At `hoursAfterIssue` hours past the moment the code was issued. */
function at(hoursAfterIssue: number): Date {
  return new Date(ISSUED_AT.getTime() + hoursAfterIssue * HOUR_MS)
}

function message(status: OutreachStatus): OutreachMessageRow {
  return {
    id: 'msg-1',
    user_id: DEMO_ID,
    contact_id: 'contact-1',
    job_id: 'job-1',
    company_id: 'company-1',
    run_id: null,
    to_email: 'a.real.person@example.com',
    to_name: 'A Real Person',
    subject: 'Quick question about the ML engineer role',
    body: 'Hello…',
    status,
    kind: 'initial',
    parent_id: null,
    gmail_message_id: null,
    gmail_thread_id: null,
    error: null,
    sent_at: null,
    replied_at: null,
    reply_gmail_message_id: null,
    reply_classification: null,
    created_at: '2026-08-03T09:00:00.000Z',
    updated_at: '2026-08-03T09:00:00.000Z',
  }
}

/** In-memory fake of the exact chain lib/harness/spend.ts uses, keyed by user
 *  id so one instance can hold BOTH the owner's row and the demo's row —
 *  which is the whole point: the assertions below are about which of the two
 *  actually moves. */
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

  function updateBuilder(patch: { preferences: Record<string, unknown> }) {
    return {
      eq(_column: string, value: string) {
        rows[value] = patch.preferences
        return Promise.resolve({ data: null, error: null })
      },
    }
  }

  const admin = {
    from(_table: string) {
      return {
        select: () => selectBuilder(),
        update: (patch: { preferences: Record<string, unknown> }) => updateBuilder(patch),
      }
    },
  }
  return admin as unknown as AdminClient
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isDemoProfile — which signal makes a workspace a demo', () => {
  it('reads the flag', () => {
    expect(isDemoProfile(demoProfile())).toBe(true)
    expect(isDemoProfile(ownerProfile())).toBe(false)
  })

  it('treats a lone demo deadline as a demo even if the flag was lost', () => {
    // A partial update that drops is_demo must not silently promote a demo
    // workspace into a full account with no cap and no expiry.
    expect(isDemoProfile({ is_demo: false, demo_expires_at: EXPIRES_AT.toISOString() })).toBe(true)
    expect(isDemoProfile({ is_demo: null, demo_expires_at: EXPIRES_AT.toISOString() })).toBe(true)
  })

  it('answers false for a missing profile — it is a question, not a decision', () => {
    // The gates handle "profile unreadable" explicitly, and they REFUSE. This
    // function must never be the thing standing between a stranger and a send.
    expect(isDemoProfile(null)).toBe(false)
    expect(isDemoProfile(undefined)).toBe(false)
  })
})

describe('demoSessionGate — (3) expiry enforced at USE time', () => {
  it('lets a live demo through', () => {
    expect(demoSessionGate(demoProfile(), at(1))).toEqual({ allowed: true })
    expect(demoSessionGate(demoProfile(), at(71)).allowed).toBe(true)
  })

  it('never blocks the owner', () => {
    expect(demoSessionGate(ownerProfile(), at(1000))).toEqual({ allowed: true })
  })

  it('THE POINT: a session opened at hour 71 is dead by hour 73', () => {
    // Redemption-time checking alone would leave this session alive as long as
    // its cookie — the promise would be about issuing codes, not about access.
    const profile = demoProfile()
    expect(demoSessionGate(profile, at(71)).allowed).toBe(true)
    const later = demoSessionGate(profile, at(73))
    expect(later.allowed).toBe(false)
    expect(later.code).toBe('demo-expired')
    expect(later.message).toMatch(/72 hours/)
  })

  it('blocks AT the deadline, not one tick past it', () => {
    expect(demoSessionGate(demoProfile(), new Date(EXPIRES_AT.getTime() - 1)).allowed).toBe(true)
    expect(demoSessionGate(demoProfile(), new Date(EXPIRES_AT.getTime())).allowed).toBe(false)
  })

  it('fails CLOSED on an unreadable deadline', () => {
    // new Date('nope').getTime() is NaN and `now >= NaN` is false, so the naive
    // check reads corruption as "not expired yet" and the session works
    // forever. This is the exact shape that fell open once already in
    // lib/outreach/guardrails.ts's follow-up window.
    const gate = demoSessionGate(demoProfile({ demo_expires_at: 'not-a-date' }), at(1))
    expect(gate.allowed).toBe(false)
    expect(gate.code).toBe('demo-expiry-unreadable')
  })

  it('fails CLOSED on a demo with no deadline at all', () => {
    // A demo row with a null expiry IS the "lives forever" bug. It can never be
    // the state that grants access.
    const gate = demoSessionGate({ is_demo: true, demo_expires_at: null }, at(1))
    expect(gate.allowed).toBe(false)
    expect(gate.code).toBe('demo-expiry-missing')
  })

  it('fails CLOSED when the profile could not be read', () => {
    // Absence of proof is not proof of absence. Blocking a real user costs a
    // retry; allowing an expired demo costs whatever the stranger does next.
    for (const missing of [null, undefined]) {
      const gate = demoSessionGate(missing, at(1))
      expect(gate.allowed).toBe(false)
      expect(gate.code).toBe('profile-unavailable')
    }
  })

  it('still expires a demo whose is_demo flag was lost', () => {
    const gate = demoSessionGate({ is_demo: false, demo_expires_at: EXPIRES_AT.toISOString() }, at(73))
    expect(gate.allowed).toBe(false)
    expect(gate.code).toBe('demo-expired')
  })

  it('every refusal carries a display-ready sentence, so no surface has to invent one', () => {
    const refusals = [
      demoSessionGate(null, at(1)),
      demoSessionGate(demoProfile(), at(73)),
      demoSessionGate(demoProfile({ demo_expires_at: null }), at(1)),
      demoSessionGate(demoProfile({ demo_expires_at: 'nope' }), at(1)),
    ]
    for (const gate of refusals) {
      expect(gate.allowed).toBe(false)
      expect(gate.reason).toBeTruthy()
      expect(gate.message).toBeTruthy()
    }
  })
})

describe('assertDemoSessionActive — the throwing form', () => {
  it('is silent for a live demo and for the owner', () => {
    expect(() => assertDemoSessionActive(demoProfile(), at(1))).not.toThrow()
    expect(() => assertDemoSessionActive(ownerProfile(), at(1000))).not.toThrow()
  })

  it('throws a DemoAccessError carrying the gate and a readable message', () => {
    try {
      assertDemoSessionActive(demoProfile(), at(73))
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DemoAccessError)
      const demoErr = err as DemoAccessError
      expect(demoErr.code).toBe('demo-expired')
      expect(demoErr.gate.allowed).toBe(false)
      expect(demoErr.message).toMatch(/demo has ended/i)
    }
  })
})

describe('describeDemoTimeRemaining — the banner can never contradict the gate', () => {
  it('is null for the owner, so no banner is rendered', () => {
    expect(describeDemoTimeRemaining(ownerProfile(), at(1))).toBeNull()
    expect(describeDemoTimeRemaining(null, at(1))).toBeNull()
  })

  it('counts down for a live demo', () => {
    expect(describeDemoTimeRemaining(demoProfile(), at(0))).toBe('3d left')
    expect(describeDemoTimeRemaining(demoProfile(), at(6))).toBe('2d 18h left')
    expect(describeDemoTimeRemaining(demoProfile(), at(71))).toBe('1h left')
  })

  it('says expired — never "unknown" — for the states the gate refuses', () => {
    // If the banner said "unknown" while the gate blocked every request, the
    // user would be told the session is fine while nothing works.
    expect(describeDemoTimeRemaining(demoProfile(), at(80))).toBe('expired')
    expect(describeDemoTimeRemaining(demoProfile({ demo_expires_at: 'nope' }), at(1))).toBe('expired')
    expect(describeDemoTimeRemaining(demoProfile({ demo_expires_at: null }), at(1))).toBe('expired')
  })
})

describe('demoSendGate — (2) a demo drafts, judges and previews, but never delivers', () => {
  it('refuses a demo, with a friendly reason that explains what DOES work', () => {
    const gate = demoSendGate(demoProfile(), at(1))
    expect(gate.allowed).toBe(false)
    expect(gate.code).toBe('demo-send-disabled')
    expect(gate.message).toMatch(/draft, judge and preview/i)
  })

  it('never blocks the owner — this file only ever narrows a demo', () => {
    expect(demoSendGate(ownerProfile(), at(1000))).toEqual({ allowed: true })
  })

  it('reports an expired demo as expired, not as a sending problem', () => {
    // Both refuse; the more informative reason is the one the user sees.
    expect(demoSendGate(demoProfile(), at(73)).code).toBe('demo-expired')
  })

  it('fails CLOSED when the profile could not be read', () => {
    expect(demoSendGate(null, at(1)).allowed).toBe(false)
    expect(demoSendGate(undefined, at(1)).code).toBe('profile-unavailable')
  })

  it('no demo state anywhere is sendable', () => {
    // Exhaustive sweep over every demo shape this module recognises. If someone
    // adds a branch and forgets the send rule, this catches it regardless of
    // which branch they forgot.
    const sendable = [
      demoProfile(),
      demoProfile({ demo_expires_at: null }),
      demoProfile({ demo_expires_at: 'nope' }),
      demoProfile({ is_demo: false, demo_expires_at: EXPIRES_AT.toISOString() }),
      demoProfile({ is_demo: null }),
    ].filter((profile) => demoSendGate(profile, at(1)).allowed)
    expect(sendable).toEqual([])
  })
})

describe('assertDemoMaySend — the throwing form', () => {
  it('is silent for the owner', () => {
    expect(() => assertDemoMaySend(ownerProfile(), at(1))).not.toThrow()
  })

  it('throws for a demo', () => {
    expect(() => assertDemoMaySend(demoProfile(), at(1))).toThrow(DemoAccessError)
    expect(() => assertDemoMaySend(demoProfile(), at(1))).toThrow(/Sending is off in the demo/)
  })

  it('returns void, so it cannot be mistaken for a gate whose answer was dropped', () => {
    // A function named assert* that returned a gate could be called on its own
    // line, read as a guard, and do nothing. The failure mode of that mistake
    // is a real email to a real person.
    expect(assertDemoMaySend(ownerProfile(), at(1))).toBeUndefined()
  })
})

describe('composition with the existing outreach guardrails', () => {
  it('is structurally a Gate, so the send route needs no new branch', () => {
    // Compile-time half of the claim: DemoGate must be assignable to the Gate
    // that canSendNow/checkDailyCap/followUpWindowElapsed already return.
    const asGate: Gate = demoSendGate(demoProfile(), at(1))
    expect(asGate.allowed).toBe(false)
    expect(typeof asGate.reason).toBe('string')

    // …and the other direction, so firstRefusal can take either.
    const asDemoGate: DemoGate = canSendNow(message('pending_review'), DEFAULT_OUTREACH_PREFS)
    expect(asDemoGate.allowed).toBe(false)
  })

  it('blocks a demo even on a message canSendNow would happily send', () => {
    // An 'approved' message with autoSend on is the most permissive state the
    // outreach guardrails have. The demo rule still wins.
    const permissive = canSendNow(message('approved'), { ...DEFAULT_OUTREACH_PREFS, autoSend: true })
    expect(permissive).toEqual({ allowed: true })

    const combined = firstRefusal(demoSendGate(demoProfile(), at(1)), permissive)
    expect(combined.allowed).toBe(false)
    expect(combined.code).toBe('demo-send-disabled')
  })

  it('leaves the owner subject to exactly the guardrails they had before', () => {
    const combined = firstRefusal(
      demoSendGate(ownerProfile(), at(1)),
      canSendNow(message('pending_review'), DEFAULT_OUTREACH_PREFS)
    )
    // The refusal is the outreach one, unmodified — the demo gate added nothing.
    expect(combined).toEqual({ allowed: false, reason: 'awaiting approval (auto-send is disabled)' })
  })

  it('passes an owner send that every guardrail allows', () => {
    const combined = firstRefusal(
      demoSendGate(ownerProfile(), at(1)),
      canSendNow(message('approved'), DEFAULT_OUTREACH_PREFS)
    )
    expect(combined).toEqual({ allowed: true })
  })

  it('firstRefusal returns the FIRST refusal, so ordering decides what is reported', () => {
    const expired = demoSendGate(demoProfile(), at(73))
    const alreadySent = canSendNow(message('sent'), DEFAULT_OUTREACH_PREFS)
    expect(firstRefusal(expired, alreadySent).code).toBe('demo-expired')
    expect(firstRefusal(alreadySent, expired).reason).toBe('already sent')
  })

  it('with no gates at all it allows — callers must pass the gates they mean', () => {
    expect(firstRefusal()).toEqual({ allowed: true })
  })
})

describe('demoProfilePreferences — (1) provisioning a demo that cannot overspend', () => {
  const ownerPreferences = {
    api_keys: { openrouter: 'enc:owner-openrouter-key' },
    budget: { periodStart: '2026-08', spentUsd: 4.2, monthlyUsd: 250 },
    provider: { active: 'local-cli', localCli: 'claude', localServerBaseUrl: 'http://10.0.0.5:11434', localServerModel: 'llama3' },
    gmail_permissions: { send: { enabled: true, grantedAt: '2026-07-01', revokedAt: null, migratedFrom: null } },
    targeting: { titles: ['Staff ML Engineer'], locations: ['Seattle'] },
    digest: { enabled: true, lastSentDate: '2026-08-02' },
    gmail_sync: { historyId: '99123' },
    contact: { email: 'owner@example.com', phone: '+1 555 0100' },
  }

  it('gives the demo its own empty ledger and its own $1 cap — never the owner’s numbers', () => {
    const prefs = demoProfilePreferences(ownerPreferences)
    expect(prefs.budget).toEqual({ periodStart: '', spentUsd: 0, monthlyUsd: DEMO_MONTHLY_USD })
    expect(prefs.budget).not.toMatchObject({ monthlyUsd: 250 })
  })

  it('carries the owner’s key across, because a demo with no model key is not a demo', () => {
    expect(demoProfilePreferences(ownerPreferences).api_keys).toEqual({ openrouter: 'enc:owner-openrouter-key' })
  })

  it('prefers a dedicated demo key when one is seeded, so the owner’s is never copied', () => {
    const prefs = demoProfilePreferences(ownerPreferences, { api_keys: { openrouter: 'enc:demo-only-key' } })
    expect(prefs.api_keys).toEqual({ openrouter: 'enc:demo-only-key' })
  })

  it('CARRIES THE MODEL KEY AND NOTHING ELSE — the paid non-LLM credits stay with the owner', () => {
    // `api_keys` is ONE blob: the model keys sit beside hunter, apollo, apify,
    // tavily, serper, exa and searxng. Copying it whole gave a stranger the
    // owner's paid contact-lookup, scraping and web-search credits — and
    // lib/harness/spend.ts meters model TOKENS, so the $1 cap bounds none of
    // them. Uncapped spend on someone else's account, for 72 hours.
    const prefs = demoProfilePreferences({
      api_keys: {
        openrouter: 'enc:owner-openrouter-key',
        openai: 'enc:owner-openai-key',
        anthropic: 'enc:owner-anthropic-key',
        hunter: 'enc:owner-hunter-key',
        apollo: 'enc:owner-apollo-key',
        apify: 'enc:owner-apify-token',
        tavily: 'enc:owner-tavily-key',
        serper: 'enc:owner-serper-key',
        exa: 'enc:owner-exa-key',
        searxng: 'https://searx.owner.example',
      },
    })
    expect(prefs.api_keys).toEqual({ openrouter: 'enc:owner-openrouter-key' })
  })

  it('drops openai and anthropic too, so every model call lands on the metered backend', () => {
    // Not paranoia about the key type — see guardrails.ts's DEMO_API_KEY_ALLOWLIST
    // doc: '@cello/agents' createLLMClient (formerly used by app/api/agents/
    // {analyze,coach}, both gone as of the langgraph port) PREFERS anthropic,
    // then openai, over openrouter. Kept as defense-in-depth even though
    // nothing reaches for it any more — a demo profile should never carry a
    // credential the guardrails can't meter.
    const prefs = demoProfilePreferences({
      api_keys: { openai: 'enc:owner-openai-key', anthropic: 'enc:owner-anthropic-key' },
    })
    expect(prefs.api_keys).toBeUndefined()
  })

  it('narrows a SEEDED blob by the same allowlist, and cannot be smuggled past the spread', () => {
    // The subtle half: `...seed` is spread into the result, so a seed whose
    // api_keys survives narrowing as "nothing" must still have its original
    // blob removed — otherwise the unnarrowed object rides through on the
    // spread and the allowlist is decorative.
    const smuggled = demoProfilePreferences(ownerPreferences, {
      api_keys: { hunter: 'enc:seeded-hunter-key', apify: 'enc:seeded-apify-token' },
    })
    expect(smuggled.api_keys).toBeUndefined()

    const mixed = demoProfilePreferences(null, {
      api_keys: { openrouter: 'enc:demo-key', tavily: 'enc:seeded-tavily-key' },
    })
    expect(mixed.api_keys).toEqual({ openrouter: 'enc:demo-key' })
  })

  it('PINS THE PROVIDER TO THE METERED ONE', () => {
    // lib/harness/llm.ts only enforces the cap when provider === 'openrouter'
    // (a local CLI or local server costs nothing per token, so charging them
    // dollars would be wrong). Inheriting the owner's 'local-cli' would
    // therefore give the demo an UNCAPPED line to the owner's subscription.
    const prefs = demoProfilePreferences(ownerPreferences)
    expect(prefs.provider).toEqual({
      active: 'openrouter',
      localCli: 'claude',
      localServerBaseUrl: '',
      localServerModel: '',
      localServerEmbeddingModel: '',
    })
  })

  it('turns every Gmail grant off, as a second lock behind demoSendGate', () => {
    const prefs = demoProfilePreferences(ownerPreferences) as { gmail_permissions: Record<string, { enabled: boolean }> }
    expect(prefs.gmail_permissions.send.enabled).toBe(false)
    expect(prefs.gmail_permissions.readShared.enabled).toBe(false)
    expect(prefs.gmail_permissions.monitor.enabled).toBe(false)
  })

  it('never arms anything automatic', () => {
    const prefs = demoProfilePreferences(ownerPreferences, {
      outreach: { autoSend: true, dailyCap: 3 },
      autopilot: { autoSubmit: true, enabled: true },
    })
    expect(prefs.outreach).toEqual({ autoSend: false, dailyCap: 3 })
    expect(prefs.autopilot).toEqual({ autoSubmit: false, enabled: true })
  })

  it('is an ALLOWLIST: no other owner preference reaches the demo', () => {
    // A denylist would leak every preference key someone adds later. Absence of
    // these is the assertion — targeting, digests, mailbox sync cursors and the
    // owner's contact details are all personal state.
    const prefs = demoProfilePreferences(ownerPreferences)
    expect(prefs.targeting).toBeUndefined()
    expect(prefs.digest).toBeUndefined()
    expect(prefs.gmail_sync).toBeUndefined()
    expect(prefs.contact).toBeUndefined()
  })

  it('cannot be loosened by a caller’s seed — the forced blocks always win', () => {
    const prefs = demoProfilePreferences(ownerPreferences, {
      budget: { periodStart: '2026-08', spentUsd: 0, monthlyUsd: 1000 },
      provider: { active: 'local-server', localCli: 'claude', localServerBaseUrl: 'http://169.254.169.254', localServerModel: 'x' },
      gmail_permissions: { send: { enabled: true, grantedAt: null, revokedAt: null, migratedFrom: null } },
    })
    expect(prefs.budget).toEqual(demoBudget())
    expect((prefs.provider as { active: string }).active).toBe('openrouter')
    expect((prefs.gmail_permissions as { send: { enabled: boolean } }).send.enabled).toBe(false)
  })

  it('survives a missing or junk owner preferences blob', () => {
    for (const input of [null, undefined, {}]) {
      const prefs = demoProfilePreferences(input)
      expect(prefs.budget).toEqual(demoBudget())
      expect(prefs.api_keys).toBeUndefined()
    }
  })

  it('keeps the demo’s seeded workspace values that are not guardrails', () => {
    const prefs = demoProfilePreferences(null, { model: 'anthropic/claude-haiku-4.5' })
    expect(prefs.model).toBe('anthropic/claude-haiku-4.5')
  })
})

describe('demoBudget composes with the REAL spend.ts', () => {
  it('reads back as a $1 cap through spend.ts’s own reader', async () => {
    // Cross-file invariant: this module writes the block, spend.ts interprets
    // it. If either side renames a field, the cap silently becomes
    // DEFAULT_MONTHLY_USD ($10) and nothing else would notice.
    const admin = fakeAdmin({ [DEMO_ID]: demoProfilePreferences(null) })
    const state = await getSpendState(admin, DEMO_ID)
    expect(state.capUsd).toBe(DEMO_MONTHLY_USD)
    expect(state.spentUsd).toBe(0)
  })

  it('an empty periodStart resets the ledger rather than inheriting one', async () => {
    const admin = fakeAdmin({ [DEMO_ID]: demoProfilePreferences({ budget: { periodStart: '2026-08', spentUsd: 9.9, monthlyUsd: 10 } }) })
    const state = await getSpendState(admin, DEMO_ID)
    expect(state.spentUsd).toBe(0)
    expect(state.capUsd).toBe(DEMO_MONTHLY_USD)
  })

  it('refuses the demo at $1 while the owner is nowhere near their own cap', async () => {
    const ownerBudget = { periodStart: '', spentUsd: 0, monthlyUsd: 10 }
    const rows: Record<string, Record<string, unknown>> = {
      [OWNER_ID]: { budget: ownerBudget },
      [DEMO_ID]: demoProfilePreferences(null),
    }
    const admin = fakeAdmin(rows)

    // $1 of opus exactly (200k prompt tokens at $5/M).
    expect(estimateCostUsd('anthropic/claude-opus-4.8', 200_000, 0)).toBe(1)
    await recordSpend(admin, DEMO_ID, 'anthropic/claude-opus-4.8', 200_000, 0)

    await expect(assertWithinBudget(admin, DEMO_ID)).rejects.toBeInstanceOf(BudgetCapError)
    await expect(assertWithinBudget(admin, OWNER_ID)).resolves.toBeUndefined()

    // THE CLAIM, IN ONE ASSERTION: the owner's ledger did not move at all.
    expect(rows[OWNER_ID].budget).toEqual(ownerBudget)
  })
})

describe('demoSafeApiKeys — a demo can never draw on the OWNER’s allowance', () => {
  it('leaves a non-demo caller byte-identical', () => {
    // The owner's own paths must be unchanged by this file existing.
    const keys: DecryptedApiKeys = { openrouter: 'sk-or-owner', userId: OWNER_ID }
    expect(demoSafeApiKeys(keys, ownerProfile())).toBe(keys)
  })

  it('re-attributes borrowed keys to the demo, and says so loudly', async () => {
    // The natural way to make a demo "just work" is to load the OWNER's keys,
    // which stamps userId = ownerId. Every call would then check the owner's
    // cap and bill the owner's ledger — a leaked code would burn their month.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const borrowed: DecryptedApiKeys = { openrouter: 'sk-or-owner', userId: OWNER_ID }
    const safe = demoSafeApiKeys(borrowed, demoProfile())

    expect(safe.userId).toBe(DEMO_ID)
    expect(safe.openrouter).toBe('sk-or-owner') // the key still works
    expect(borrowed.userId).toBe(OWNER_ID) // input not mutated
    expect(spy).toHaveBeenCalledTimes(1)
    expect(String(spy.mock.calls[0][0])).toMatch(/re-attributing spend/)

    // End to end through the real spend.ts: the charge lands on the demo.
    const ownerBudget = { periodStart: '', spentUsd: 0, monthlyUsd: 10 }
    const rows: Record<string, Record<string, unknown>> = {
      [OWNER_ID]: { budget: ownerBudget },
      [DEMO_ID]: demoProfilePreferences(null),
    }
    const admin = fakeAdmin(rows)
    await recordSpend(admin, safe.userId!, 'anthropic/claude-haiku-4.5', 100_000, 10_000)
    expect(rows[OWNER_ID].budget).toEqual(ownerBudget)
    expect((rows[DEMO_ID].budget as { spentUsd: number }).spentUsd).toBeGreaterThan(0)
  })

  it('SUPPLIES a missing userId, because an absent one means NO CAP AT ALL', () => {
    // lib/harness/llm.ts: `metered = provider === 'openrouter' &&
    // Boolean(apiKeys.userId)`. Unattributed keys reach a model with no ceiling.
    const safe = demoSafeApiKeys({ openrouter: 'sk-or-x' }, demoProfile())
    expect(safe.userId).toBe(DEMO_ID)
  })

  it('forces a demo back onto the metered provider, at CALL time', () => {
    // Every feature works for a demo — including Settings. A demo that switches
    // itself to a local backend would escape the cap entirely, so pinning at
    // provisioning time is not enough; it has to hold on every call.
    for (const active of ['local-cli', 'local-server'] as const) {
      const safe = demoSafeApiKeys(
        {
          openrouter: 'sk-or-x',
          userId: DEMO_ID,
          provider: { active, localCli: 'codex', localServerBaseUrl: 'http://169.254.169.254', localServerModel: 'x' },
        },
        demoProfile()
      )
      expect(safe.provider?.active).toBe('openrouter')
      // Also clears an attacker-chosen outbound URL.
      expect(safe.provider?.localServerBaseUrl).toBe('')
    }
  })

  it('leaves an already-correct openrouter demo alone', () => {
    const safe = demoSafeApiKeys(
      {
        openrouter: 'sk-or-x',
        userId: DEMO_ID,
        provider: { active: 'openrouter', localCli: 'gemini', localServerBaseUrl: '', localServerModel: '' },
      },
      demoProfile()
    )
    expect(safe.provider).toEqual({
      active: 'openrouter',
      localCli: 'gemini',
      localServerBaseUrl: '',
      localServerModel: '',
    })
  })

  it('does not log when nothing was wrong', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    demoSafeApiKeys({ openrouter: 'sk-or-x', userId: DEMO_ID }, demoProfile())
    demoSafeApiKeys({ openrouter: 'sk-or-x' }, demoProfile())
    expect(spy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// The settings that ARE the guardrail
// ---------------------------------------------------------------------------
// The $1 cap and the provisioned model key are not preferences a demo happens
// to have — they are the two values every other spend guardrail reads. The
// product ships editors for both (app/api/settings/budget PUT,
// app/api/settings/keys POST/DELETE), and before demoSettingsGate a demo raised
// its own ceiling to $1000 with one request against the product's own API.
//
// Two layers, and this block holds both to the SAME answer: the application
// gate that runs before the write, and the mapping of the database trigger's
// refusal (supabase/migrations/20260803000003) for the paths the gate never
// sees. A client must not be able to tell which one caught it.

/** Resolved from this file, not process.cwd(): vitest may be started anywhere. */
const HERE = path.dirname(fileURLToPath(import.meta.url))
const LOCKDOWN_SQL = readFileSync(
  path.resolve(HERE, '../../../../supabase/migrations/20260803000003_demo_profile_lockdown.sql'),
  'utf8'
)

/**
 * A PostgREST error shaped like the one the lockdown trigger produces.
 *
 * NEVER use this for the sweep over the migration's own raises. Hardcoding
 * '42501' there is exactly the bug described on parseLockdownRaises below: it
 * assumes the answer to the question being asked.
 */
function lockdownError(message: string) {
  return { code: '42501', message }
}

/** The body of enforce_demo_profile_lockdown(), which is what raises refusals. */
const LOCKDOWN_BODY = (() => {
  // Scoped to this one function on purpose: the file also contains a
  // precondition raise (a migration failure, not a refusal) and
  // forbid_demo_access_code_issue's (which surfaces on app/api/access-codes, a
  // route with its own message).
  const start = LOCKDOWN_SQL.indexOf('create or replace function public.enforce_demo_profile_lockdown()')
  if (start < 0) throw new Error('the lockdown trigger function is not in the migration')
  const open = LOCKDOWN_SQL.indexOf('as $$', start)
  return LOCKDOWN_SQL.slice(open, LOCKDOWN_SQL.indexOf('$$;', open))
})()

/**
 * SQLSTATE for the Postgres condition names this migration uses.
 *
 * Only what is needed; an errcode this table does not know fails the sweep
 * loudly rather than being guessed at.
 */
const SQLSTATE_BY_CONDITION_NAME: Record<string, string> = {
  insufficient_privilege: '42501',
  undefined_table: '42P01',
  raise_exception: 'P0001',
}

/**
 * What plpgsql uses when `raise exception` carries no `using errcode` at all.
 * https://www.postgresql.org/docs/current/plpgsql-errors-and-messages.html —
 * the default condition is `raise_exception`, i.e. P0001.
 */
const PLPGSQL_DEFAULT_SQLSTATE = 'P0001'

interface LockdownRaise {
  message: string
  /** The condition name written after `using errcode =`, or null if absent. */
  errcode: string | null
  /** What PostgREST would put in error.code for that raise. */
  sqlstate: string
}

/**
 * Every `raise exception` in a chunk of plpgsql, WITH THE ERRCODE IT ACTUALLY
 * CARRIES.
 *
 * WHY THE ERRCODE IS READ RATHER THAN ASSUMED. demoLockdownGate requires
 * `code === '42501'` before it will even look at the message. The previous
 * version of this sweep extracted the messages alone and handed each to a local
 * helper that hardcoded '42501' — so a future guard written without
 * `using errcode = 'insufficient_privilege'` would raise plpgsql's P0001
 * default, the mapping would silently stop firing, that refusal would reach the
 * user as an unexplained 500, and THIS TEST WOULD STAY GREEN. Reading the
 * errcode out of the SQL next to each raise is what makes the sweep able to
 * fail; the mutation test below proves it does.
 *
 * A raise whose errcode this cannot parse (a format string with parameters, a
 * condition name not in the table above) reports the default or an UNMAPPED
 * marker, both of which fail the sweep. That is the safe direction: it forces
 * whoever changed the SQL to look here, rather than quietly widening what
 * passes.
 */
function parseLockdownRaises(sql: string): LockdownRaise[] {
  const pattern = /raise\s+exception\s+'([^']+)'(?:\s*using\s+errcode\s*=\s*'([^']+)')?/gi
  return [...sql.matchAll(pattern)].map((match) => {
    const errcode = match[2] ?? null
    return { message: match[1], errcode, sqlstate: toSqlstate(errcode) }
  })
}

function toSqlstate(errcode: string | null): string {
  if (errcode === null) return PLPGSQL_DEFAULT_SQLSTATE
  // `using errcode = '42501'` is also legal — a literal five-character SQLSTATE.
  if (/^[0-9A-Z]{5}$/.test(errcode)) return errcode
  return SQLSTATE_BY_CONDITION_NAME[errcode] ?? `UNMAPPED(${errcode})`
}

/**
 * THE SWEEP, as a function — every refusal the given plpgsql can raise must be
 * one demoLockdownGate recognises, at the errcode the SQL actually gives it.
 *
 * It is a function so the mutation tests below can run THIS code over a
 * deliberately broken migration rather than re-deriving the assertion. A
 * mutation test that reproduces the check it is meant to be proving only
 * demonstrates that the reproduction works: the real sweep could later be
 * weakened — narrowed to the raises that already carry 42501, say — and the
 * reproduction would keep passing while the sweep stopped being able to fail.
 */
function sweepLockdownRaises(sql: string): void {
  const raises = parseLockdownRaises(sql)

  // Two different ways the extraction can quietly check nothing. A floor, so a
  // regex that matched none of them cannot pass an empty loop…
  expect(raises.length).toBeGreaterThanOrEqual(10)
  // …and an exact count, so a raise written in a shape parseLockdownRaises does
  // not understand (`raise exception using message = ...`, a message carrying a
  // doubled quote) is a failure here rather than a refusal nothing looked at.
  expect(
    raises.length,
    'a `raise exception` in the trigger was not extracted — parseLockdownRaises does not understand ' +
      'its shape, so whatever it refuses is going unchecked by this sweep'
  ).toBe((sql.match(/raise\s+exception/gi) ?? []).length)

  for (const raise of raises) {
    expect(
      raise.sqlstate,
      `raise '${raise.message}' uses errcode '${raise.errcode}', which this test cannot map to a ` +
        'SQLSTATE — add it to SQLSTATE_BY_CONDITION_NAME and check demoLockdownGate still matches'
    ).not.toMatch(/^UNMAPPED/)

    expect(
      demoLockdownGate({ code: raise.sqlstate, message: raise.message })?.code,
      `raise '${raise.message}' (errcode ${raise.errcode ?? 'ABSENT → plpgsql default'}, ` +
        `SQLSTATE ${raise.sqlstate}) is not recognised as a demo refusal, so it would reach the ` +
        'user as a 500'
    ).toBe('demo-settings-locked')
  }
}

describe('demoSettingsGate — a demo cannot edit its own cap or its own key', () => {
  it('refuses a live demo, and says what is fixed and why', () => {
    const gate = demoSettingsGate(demoProfile(), at(1))
    expect(gate.allowed).toBe(false)
    expect(gate.code).toBe('demo-settings-locked')
    // The message has to survive being shown to a stranger who has done nothing
    // wrong: it names the limit, the reason, and does not blame them.
    expect(gate.message).toMatch(new RegExp(`\\$${DEMO_MONTHLY_USD}`))
    expect(gate.message).toMatch(/neither can be changed from inside the demo/i)
  })

  it('never blocks the owner — their own Settings are untouched by this file', () => {
    expect(demoSettingsGate(ownerProfile(), at(1000))).toEqual({ allowed: true })
  })

  it('reports an expired demo as expired, not as a settings problem', () => {
    expect(demoSettingsGate(demoProfile(), at(73)).code).toBe('demo-expired')
  })

  it('fails CLOSED when the profile could not be read', () => {
    // The state a deployment that has not applied the access-codes migration is
    // in: the select fails whole on `is_demo`, the route hands us nothing, and
    // we cannot prove the caller is not a demo. Refusing costs a real user a
    // retry; allowing hands a stranger the cap editor.
    for (const missing of [null, undefined]) {
      const gate = demoSettingsGate(missing, at(1))
      expect(gate.allowed).toBe(false)
      expect(gate.code).toBe('profile-unavailable')
    }
  })

  it('no demo state anywhere may edit these settings', () => {
    // Same exhaustive sweep as the send rule: if someone adds a branch and
    // forgets this one, it fails regardless of which branch they forgot.
    const editable = [
      demoProfile(),
      demoProfile({ demo_expires_at: null }),
      demoProfile({ demo_expires_at: 'nope' }),
      demoProfile({ is_demo: false, demo_expires_at: EXPIRES_AT.toISOString() }),
      demoProfile({ is_demo: null }),
    ].filter((profile) => demoSettingsGate(profile, at(1)).allowed)
    expect(editable).toEqual([])
  })
})

describe('demoLockdownGate — the database’s refusal, in the application’s words', () => {
  it('THE POINT: both layers hand back the identical gate', () => {
    // A client must not be able to tell whether the application refused or the
    // trigger did — same code, same reason, same sentence, and therefore the
    // same 403 body from the routes, which render the gate rather than writing
    // their own copy.
    expect(demoLockdownGate(lockdownError('demo profiles cannot raise their AI budget cap'))).toEqual(
      demoSettingsGate(demoProfile(), at(1))
    )
  })

  it('recognises EVERY refusal the lockdown trigger can raise, AT THE ERRCODE IT CARRIES', () => {
    // Cross-file invariant, in TWO parts, because demoLockdownGate needs both
    // to fire: the SQLSTATE must be 42501 and the message must be the
    // trigger's own wording. So a migration that rephrased a raise — OR one
    // that forgot `using errcode = 'insufficient_privilege'` — would turn a
    // deliberate 403 back into an unexplained 500. Read the SQL and check all
    // of them, not a sample, and take each raise's errcode FROM THE SQL rather
    // than assuming the one the module wants.
    sweepLockdownRaises(LOCKDOWN_BODY)
  })

  it('MUTATION TEST: a raise that forgets its errcode fails the sweep above', () => {
    // The sweep is a security assertion, so it has to be shown capable of
    // failing — the version it replaced could not, and a test that stays green
    // when the property is removed is worse than no test. Rather than describe
    // the mutation in a comment, perform it: strip `using errcode` off one real
    // raise and put the result back through the sweep ITSELF.
    const target = "raise exception 'demo profiles cannot change API keys'"
    const mutated = LOCKDOWN_BODY.replace(
      new RegExp(`${target}\\s*using\\s+errcode\\s*=\\s*'[^']+'`),
      target
    )
    expect(mutated, 'the mutation did not apply — this test is checking nothing').not.toBe(LOCKDOWN_BODY)

    const raise = parseLockdownRaises(mutated).find((r) => r.message.endsWith('change API keys'))
    expect(raise).toBeDefined()
    expect(raise!.errcode).toBeNull()
    expect(raise!.sqlstate).toBe(PLPGSQL_DEFAULT_SQLSTATE)

    // That is what would reach production: the gate does not fire, so the
    // route's `if (lockdown)` branch is skipped and a deliberate refusal is
    // answered as a server fault…
    expect(demoLockdownGate({ code: raise!.sqlstate, message: raise!.message })).toBeNull()
    // …and the sweep catches it. Not a re-derivation of the sweep — the sweep.
    expect(() => sweepLockdownRaises(mutated)).toThrow(/is not recognised as a demo refusal/)
  })

  it('MUTATION TEST: a raise that is REWORDED fails the sweep too', () => {
    // demoLockdownGate needs BOTH halves, so both halves need a mutation that
    // proves the sweep can fail. Here the errcode is untouched and only the
    // sentence changes — which is the likelier accident, since rewording a
    // user-visible string does not look like touching a security boundary.
    const mutated = LOCKDOWN_BODY.replace(
      "raise exception 'demo profiles cannot change API keys'",
      "raise exception 'API keys are frozen for shared demo sessions'"
    )
    expect(mutated, 'the mutation did not apply — this test is checking nothing').not.toBe(LOCKDOWN_BODY)

    expect(() => sweepLockdownRaises(mutated)).toThrow(/is not recognised as a demo refusal/)
  })

  it('MUTATION TEST: a raise the extractor cannot READ fails the sweep, rather than being skipped', () => {
    // The failure mode neither mutation above reaches: a raise written in a
    // form parseLockdownRaises does not match disappears from the loop
    // entirely, and a loop over the raises it happened to understand passes
    // while saying nothing about the one it missed. `raise exception using
    // message = '...'` is valid plpgsql and is exactly that shape.
    const mutated = LOCKDOWN_BODY.replace(
      /raise\s+exception\s+'demo profiles cannot change API keys'\s*using\s+errcode\s*=\s*'[^']+'/,
      "raise exception using errcode = 'insufficient_privilege', message = 'demo profiles cannot change API keys'"
    )
    expect(mutated, 'the mutation did not apply — this test is checking nothing').not.toBe(LOCKDOWN_BODY)
    expect(parseLockdownRaises(mutated)).toHaveLength(parseLockdownRaises(LOCKDOWN_BODY).length - 1)

    expect(() => sweepLockdownRaises(mutated)).toThrow(/was not extracted/)
  })

  it('every raise in the trigger really does carry insufficient_privilege today', () => {
    // The sweep above would also pass if a raise used some OTHER condition name
    // that happens to be SQLSTATE 42501. This pins the actual state of the
    // migration, so the diff that changes it is deliberate.
    const errcodes = new Set(parseLockdownRaises(LOCKDOWN_BODY).map((r) => r.errcode))
    expect([...errcodes]).toEqual(['insufficient_privilege'])
  })

  it('is null for anything that is not the lockdown', () => {
    // 42501 is also plain "permission denied for table" / an RLS violation.
    // Answering those with a demo message would tell the OWNER they are a demo,
    // which is a lie this module is not entitled to tell — so they stay
    // whatever they already were, and the route reports them as it always has.
    expect(demoLockdownGate(lockdownError('permission denied for table profiles'))).toBeNull()
    expect(demoLockdownGate({ code: '23505', message: 'demo profiles cannot change is_demo' })).toBeNull()
    expect(demoLockdownGate({ code: 'PGRST301', message: 'JWT expired' })).toBeNull()
    expect(demoLockdownGate({ message: 'demo profiles cannot change API keys' })).toBeNull()
    expect(demoLockdownGate(null)).toBeNull()
    expect(demoLockdownGate(undefined)).toBeNull()
  })
})

describe('the settings routes actually call these gates', () => {
  // guardrails.ts shipped once as a well-tested module with zero callers, and
  // every rule in it was correct while none of it did anything. These two
  // assertions are the difference between "the policy exists" and "the policy
  // runs" — the same claim lib/access/demo-chokepoints.test.ts makes for the
  // model and mail paths. Source is read with comment lines stripped, so a
  // route cannot satisfy them by TALKING about a guard.
  function routeSource(relative: string): string {
    const src = readFileSync(path.resolve(HERE, '../../', relative), 'utf8')
    return src
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim()
        return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
      })
      .join('\n')
  }

  for (const route of ['app/api/settings/budget/route.ts', 'app/api/settings/keys/route.ts']) {
    it(`${route} refuses a demo at BOTH layers`, () => {
      // IMPORTS ARE STRIPPED BEFORE MATCHING.
      //
      // An adversarial review proved this test was a FALSE NEGATIVE: deleting
      // the entire pre-write refusal from budget/route.ts left the whole
      // lib/access suite green, because `import { demoSettingsGate } ...`
      // satisfied /\bdemoSettingsGate\b/ on its own. A security test that
      // passes when the security property is removed is worse than no test, so
      // the identifier must now appear as a CALL in the body.
      const src = routeSource(route).replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"]\s*$/gm, '')

      // Before the write…
      expect(src, 'demoSettingsGate must be CALLED, not merely imported').toMatch(
        /\bdemoSettingsGate\s*\(/
      )
      // …and the refusal must actually be returned, not computed and dropped.
      expect(src).toMatch(/demoRefusalResponse\s*\(|!\s*gate\.allowed/)
      // …and after the write, for a refusal only the database saw.
      expect(src, 'demoLockdownGate must be CALLED').toMatch(/\bdemoLockdownGate\s*\(/)

      // The gate can only answer if the route reads the columns it needs —
      // directly, or through readProfileForDemoGuards(), which names them and
      // additionally tolerates a schema that predates the access-codes
      // migration. Selecting them directly took every AI feature down when the
      // columns were absent, so the helper is the stronger form here.
      const readsDemoFacts =
        (src.includes('is_demo') && src.includes('demo_expires_at')) ||
        src.includes('readProfileForDemoGuards')
      expect(readsDemoFacts, 'the route must read the demo facts somehow').toBe(true)
    })
  }
})
