// The HTTP surface of the AI spend cap.
//
// WHY THIS FILE EXISTS
//   PUT /api/settings/budget is the product's own editor for the ONE number
//   every other spend guardrail reads. For a demo workspace that number is
//   DEMO_MONTHLY_USD ($1), and it is what makes handing a stranger a real,
//   working account affordable — so an unguarded PUT here raises a shared code's
//   ceiling to this route's MAX_MONTHLY_USD ($1000) in a single request.
//
//   lib/access/guardrails.test.ts proves the POLICY is right and greps this
//   route's source to prove the gates are called. Neither of those runs the
//   handler. This file does: it drives PUT against an in-memory PostgREST fake
//   and asserts on the actual Response, because the three ways this can be
//   wrong are all HTTP-shaped —
//
//     * a demo write that succeeds (or is refused with a body the UI cannot
//       render);
//     * a refusal only the DATABASE saw (supabase/migrations/20260803000003's
//       trigger, SQLSTATE 42501) reported as a 500, i.e. a deliberate policy
//       decision surfacing as "something broke";
//     * THE OWNER LOSING THEIR OWN SETTINGS. This route reads the two demo
//       columns before it writes, and selecting a column that does not exist
//       makes PostgREST fail the WHOLE query — which took every AI feature down
//       once already (see readProfileForDemoGuards). A guardrail that bricks the
//       owner is not a guardrail.
//
// The fake models the schema, not just the rows: a select naming a column the
// table does not have comes back as PostgREST's 42703, which is the only way to
// exercise the pre-migration path honestly.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { DEMO_MONTHLY_USD, demoSettingsGate } from '@/lib/access/guardrails'
import { DEFAULT_MONTHLY_USD } from '@/lib/harness/spend'

interface DbError {
  code?: string
  message?: string
}

const OWNER_ID = 'owner-user-1'
const DEMO_ID = 'demo-user-1'

/** Every column the access-codes migration leaves on `profiles`. */
const MIGRATED_SCHEMA = ['id', 'preferences', 'is_demo', 'demo_expires_at']
/** …and the same table BEFORE that migration was applied. */
const PRE_MIGRATION_SCHEMA = ['id', 'preferences']

let user: { id: string } | null
let row: Record<string, unknown> | null
let schema: Set<string>
/** Forced on every select — for a read that fails for some OTHER reason. */
let selectFailure: DbError | null
/** Forced on the update — for the lockdown trigger's own refusal. */
let writeFailure: DbError | null
/** Every `select(...)` argument the route issued, in order. */
let selects: string[]
/** Every patch that actually reached the table. Empty means nothing was written. */
let writes: Record<string, unknown>[]

/**
 * A profiles read, projected through the columns the table actually HAS.
 *
 * Asking for a column outside the schema returns Postgres 42703
 * (`undefined_column`) with PostgREST's wording, and returns NO DATA — that
 * whole-query failure is the behaviour that matters here, because `preferences`
 * rides in the same row as `is_demo`.
 */
function readColumns(columns: string) {
  selects.push(columns)
  if (selectFailure) return { data: null, error: selectFailure }

  const requested = columns
    .split(',')
    .map((column) => column.trim())
    .filter(Boolean)
  const missing = requested.find((column) => !schema.has(column))
  if (missing) {
    return { data: null, error: { code: '42703', message: `column profiles.${missing} does not exist` } }
  }

  if (!row) return { data: null, error: null }
  const projected: Record<string, unknown> = {}
  for (const column of requested) projected[column] = row[column] ?? null
  return { data: projected, error: null }
}

const supabase = {
  auth: { getUser: async () => ({ data: { user }, error: null }) },
  from(_table: string) {
    return {
      select(columns: string) {
        const result = readColumns(columns)
        const builder = {
          eq: () => builder,
          maybeSingle: async () => result,
          single: async () => result,
        }
        return builder
      },
      update(patch: Record<string, unknown>) {
        return {
          eq: async () => {
            if (writeFailure) return { data: null, error: writeFailure }
            writes.push(patch)
            row = { ...(row ?? {}), ...patch }
            return { data: null, error: null }
          },
        }
      },
    }
  },
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabase }))

import { GET, PUT } from './route'

/** 48 hours out, so the demo is LIVE — an expired one is refused for a different reason. */
function liveDemoExpiry(): string {
  return new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
}

function ownerRow(preferences: Record<string, unknown> = {}) {
  return { id: OWNER_ID, preferences, is_demo: false, demo_expires_at: null }
}

function demoRow(preferences: Record<string, unknown> = {}) {
  return { id: DEMO_ID, preferences, is_demo: true, demo_expires_at: liveDemoExpiry() }
}

function putRequest(body: unknown) {
  return new NextRequest('http://localhost/api/settings/budget', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * The refusal body, asserted against the gate MODULE rather than against string
 * literals copied out of it — so the route and lib/access/guardrails.ts cannot
 * drift apart without this failing, and so a reworded message is a one-file
 * change rather than a two-file one.
 *
 * `toEqual` is exact: an extra field (a leaked profile, a stack trace) fails.
 */
async function expectDemoRefusal(response: Response) {
  expect(response.status).toBe(403)
  const gate = demoSettingsGate({ is_demo: true, demo_expires_at: liveDemoExpiry() })
  const body = await response.json()
  expect(body).toEqual({ error: gate.reason, message: gate.message, demo: 'demo-settings-locked' })

  // What the two surfaces actually render: budget-meter-card.tsx throws
  // `data.error`, so an empty one would show "Couldn't save (HTTP 403)" and
  // tell the user nothing.
  expect(typeof body.error).toBe('string')
  expect(body.error.length).toBeGreaterThan(0)
  expect(body.message).toMatch(/neither can be changed from inside the demo/i)
  return body as Record<string, unknown>
}

beforeEach(() => {
  user = { id: OWNER_ID }
  row = ownerRow()
  schema = new Set(MIGRATED_SCHEMA)
  selectFailure = null
  writeFailure = null
  selects = []
  writes = []
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('PUT /api/settings/budget — a demo cannot raise its own ceiling', () => {
  it('THE POINT: a demo asking for $1000 is refused and its $1 cap is untouched', async () => {
    user = { id: DEMO_ID }
    row = demoRow({ budget: { periodStart: '2026-08', spentUsd: 0.4, monthlyUsd: DEMO_MONTHLY_USD } })

    const response = await PUT(putRequest({ monthlyUsd: 1000 }))
    await expectDemoRefusal(response)

    // The refusal is not just a status code: nothing reached the table.
    expect(writes).toEqual([])
    expect((row!.preferences as { budget: { monthlyUsd: number } }).budget.monthlyUsd).toBe(DEMO_MONTHLY_USD)
  })

  it('refuses a demo BEFORE the body is validated, so it hears the real reason', async () => {
    // A demo that sent nonsense must be told the budget is locked, not handed a
    // 400 about a number it was never allowed to set. This is an ORDER
    // assertion: it fails if the gate is moved below the parse/validate block.
    user = { id: DEMO_ID }
    row = demoRow()

    for (const body of [{ monthlyUsd: 'lots' }, { monthlyUsd: -5 }, {}]) {
      const response = await PUT(putRequest(body))
      await expectDemoRefusal(response)
    }
    expect(writes).toEqual([])
  })

  it('refuses a demo LOWERING its cap too — the app layer is deliberately stricter', async () => {
    // The trigger permits a demo to lower its ceiling; demoSettingsGate refuses
    // every budget write. Rule of the file: when the two layers disagree, the
    // narrower one is the application's.
    user = { id: DEMO_ID }
    row = demoRow({ budget: { periodStart: '', spentUsd: 0, monthlyUsd: DEMO_MONTHLY_USD } })

    await expectDemoRefusal(await PUT(putRequest({ monthlyUsd: DEMO_MONTHLY_USD })))
    expect(writes).toEqual([])
  })

  it('refuses a demo whose is_demo flag was dropped but whose deadline survives', async () => {
    // isDemoProfile ORs the two signals. A partial update that lost the flag
    // must not promote the workspace into an uncapped account.
    user = { id: DEMO_ID }
    row = { id: DEMO_ID, preferences: {}, is_demo: false, demo_expires_at: liveDemoExpiry() }

    await expectDemoRefusal(await PUT(putRequest({ monthlyUsd: 1000 })))
    expect(writes).toEqual([])
  })

  it('lets a demo READ its budget — the "$0.12 of $1.00 used" banner is part of the demo', async () => {
    user = { id: DEMO_ID }
    row = demoRow({ budget: { periodStart: '2026-08', spentUsd: 0.12, monthlyUsd: DEMO_MONTHLY_USD } })

    const response = await GET()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      budget: { monthlyUsd: DEMO_MONTHLY_USD, spentUsd: 0.12, periodStart: '2026-08' },
    })
  })
})

describe('PUT /api/settings/budget — the OWNER is unaffected', () => {
  it('saves the new cap and returns it', async () => {
    row = ownerRow({ budget: { periodStart: '2026-08', spentUsd: 3.5, monthlyUsd: DEFAULT_MONTHLY_USD } })

    const response = await PUT(putRequest({ monthlyUsd: 42 }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      budget: { monthlyUsd: 42, spentUsd: 3.5, periodStart: '2026-08' },
    })

    expect(writes).toHaveLength(1)
    const saved = (writes[0].preferences as { budget: Record<string, unknown> }).budget
    expect(saved).toEqual({ periodStart: '2026-08', spentUsd: 3.5, monthlyUsd: 42 })
  })

  it('does not wipe the rest of preferences — api_keys ride in the same column', async () => {
    // Read-modify-write, not `.update({ preferences: { budget } })`. Getting
    // this wrong deletes the owner's API keys on a budget save.
    row = ownerRow({
      api_keys: { openrouter: 'enc:owner-key' },
      targeting: { titles: ['Staff ML Engineer'] },
      budget: { periodStart: '2026-08', spentUsd: 3.5, monthlyUsd: 10 },
    })

    expect((await PUT(putRequest({ monthlyUsd: 25 }))).status).toBe(200)
    const preferences = writes[0].preferences as Record<string, unknown>
    expect(preferences.api_keys).toEqual({ openrouter: 'enc:owner-key' })
    expect(preferences.targeting).toEqual({ titles: ['Staff ML Engineer'] })
  })

  it('still enforces its own floor and ceiling for the owner', async () => {
    for (const monthlyUsd of [0.5, 1001]) {
      const response = await PUT(putRequest({ monthlyUsd }))
      expect(response.status).toBe(400)
      expect((await response.json()).demo).toBeUndefined()
    }
    expect(writes).toEqual([])
  })

  it('rejects an unauthenticated caller before anything else', async () => {
    user = null
    const response = await PUT(putRequest({ monthlyUsd: 50 }))
    expect(response.status).toBe(401)
    expect(writes).toEqual([])
  })
})

describe('PUT /api/settings/budget — a refusal only the DATABASE saw', () => {
  it('maps the lockdown trigger 42501 to the SAME clean 403, not a 500', async () => {
    // The trigger is the backstop for a demo the gate could not see — flags
    // unreadable, or a deployment running older code. Same event, same answer.
    writeFailure = { code: '42501', message: 'demo profiles cannot raise their AI budget cap' }

    await expectDemoRefusal(await PUT(putRequest({ monthlyUsd: 1000 })))
    expect(writes).toEqual([])
  })

  it('maps every budget refusal the trigger can raise', async () => {
    for (const message of [
      'demo profiles cannot raise their AI budget cap',
      'demo profiles cannot remove their AI budget cap',
      'demo profiles cannot introduce an AI budget cap',
      'demo profiles cannot reset their AI spend ledger',
      'demo profiles cannot change their AI billing period',
    ]) {
      writeFailure = { code: '42501', message }
      const response = await PUT(putRequest({ monthlyUsd: 500 }))
      expect(response.status, message).toBe(403)
      expect((await response.json()).demo, message).toBe('demo-settings-locked')
    }
  })

  it('does NOT claim a demo for a 42501 that is not the lockdown', async () => {
    // 42501 is also a plain grant/RLS denial. Telling the owner their settings
    // are locked because they are a demo would be a lie.
    writeFailure = { code: '42501', message: 'permission denied for table profiles' }

    const response = await PUT(putRequest({ monthlyUsd: 50 }))
    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body).toEqual({ error: 'Failed to save your budget' })
    expect(body.demo).toBeUndefined()
  })

  it('reports an ordinary write failure as a 500', async () => {
    writeFailure = { code: '08006', message: 'connection failure' }
    expect((await PUT(putRequest({ monthlyUsd: 50 }))).status).toBe(500)
  })
})

describe('PUT /api/settings/budget — the profile read', () => {
  it('THE OUTAGE THAT WAS FIXED: a PRE-MIGRATION schema still lets the owner save', async () => {
    // `is_demo` does not exist yet, so selecting it fails the WHOLE query and
    // takes `preferences` down with it. If this route treated that as "cannot
    // prove you are not a demo", the owner could not save a budget — and the
    // only escape would be applying a migration the product gives you no way to
    // reach. A missing COLUMN provably means no demo user can exist, so the
    // owner is allowed through; readProfileForDemoGuards is what makes that so.
    schema = new Set(PRE_MIGRATION_SCHEMA)
    row = { id: OWNER_ID, preferences: { api_keys: { openrouter: 'enc:owner-key' } } }

    const response = await PUT(putRequest({ monthlyUsd: 30 }))
    expect(response.status).toBe(200)
    expect((await response.json()).budget.monthlyUsd).toBe(30)

    // …and it really did land, with the rest of preferences intact.
    expect(writes).toHaveLength(1)
    const preferences = writes[0].preferences as Record<string, unknown>
    expect(preferences.api_keys).toEqual({ openrouter: 'enc:owner-key' })

    // The mechanism, pinned: one select naming the demo columns, then a RETRY
    // without them. A single-select route cannot pass this test.
    expect(selects).toHaveLength(2)
    expect(selects[0]).toContain('is_demo')
    expect(selects[1]).not.toContain('is_demo')
    expect(selects[1]).toContain('preferences')
  })

  it('fails CLOSED when the profile ROW is missing, even though the columns exist', async () => {
    // Deliberately the opposite answer from the missing-COLUMN case above. An
    // absent row proves nothing about who is calling; an absent column proves
    // no demo user can exist. Both are the safe reading of their own fact.
    row = null

    const response = await PUT(putRequest({ monthlyUsd: 1000 }))
    expect(response.status).toBe(403)
    expect((await response.json()).demo).toBe('profile-unavailable')
    expect(writes).toEqual([])
  })

  it('fails CLOSED when the read fails for a reason that is not a missing column', async () => {
    selectFailure = { code: 'PGRST301', message: 'JWT expired' }

    const response = await PUT(putRequest({ monthlyUsd: 1000 }))
    expect(response.status).toBe(403)
    expect((await response.json()).demo).toBe('profile-unavailable')
    expect(writes).toEqual([])
  })

  it('refuses an EXPIRED demo with the expiry reason, not the settings one', async () => {
    user = { id: DEMO_ID }
    row = {
      id: DEMO_ID,
      preferences: {},
      is_demo: true,
      demo_expires_at: new Date(Date.now() - 60_000).toISOString(),
    }

    const response = await PUT(putRequest({ monthlyUsd: 1000 }))
    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body.demo).toBe('demo-expired')
    expect(body.message).toMatch(/72 hours/)
    expect(writes).toEqual([])
  })
})
