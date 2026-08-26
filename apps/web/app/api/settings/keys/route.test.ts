// The HTTP surface of the API-key vault.
//
// WHY THIS FILE EXISTS
//   A demo workspace is provisioned server-side with exactly ONE credential —
//   the owner's OpenRouter key, narrowed by DEMO_API_KEY_ALLOWLIST — so that
//   scoring, tailoring and drafting work for real while every model call is
//   metered against the demo's own $1 ledger. POST here would let a demo swap in
//   key material of its own (making the owner's workspace an outbound channel to
//   a provider account they never authorised) and DELETE would let it clear the
//   key, forcing whatever fallback path exists next.
//
//   lib/access/guardrails.test.ts proves the POLICY and greps this route's
//   source to prove the gates are called. Neither runs the handler. This file
//   drives POST and DELETE against an in-memory PostgREST fake and asserts on
//   the real Response, because the ways this goes wrong are HTTP-shaped:
//
//     * a demo write that succeeds, or a refusal the Settings UI cannot render
//       (api-keys-tab.tsx shows `result.error` verbatim and nothing else);
//     * a refusal only the DATABASE saw (supabase/migrations/20260803000003
//       freezes the whole api_keys subtree, SQLSTATE 42501) reported as a 500;
//     * THE OWNER UNABLE TO SAVE A KEY AT ALL. This route reads the two demo
//       columns before it writes, and selecting a column that does not exist
//       makes PostgREST fail the WHOLE query. That is not hypothetical: it took
//       every AI feature down once, and because the settings routes had the same
//       select, the owner could not save a key to recover. See
//       readProfileForDemoGuards.
//
// The fake models the schema, not just the rows, so the pre-migration path can
// be exercised honestly. Every response this file produces is swept at the end
// for key material.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { demoSettingsGate } from '@/lib/access/guardrails'
import { isEncrypted } from '@/lib/crypto'

interface DbError {
  code?: string
  message?: string
}

const OWNER_ID = 'owner-user-1'
const DEMO_ID = 'demo-user-1'

/** Obvious placeholders. Never real credentials, and never expected in a body. */
const OWNER_OPENROUTER = 'sk-or-PLACEHOLDER-owner-key-77'
const ATTACKER_OPENAI = 'sk-PLACEHOLDER-attacker-key-77'

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
/** Every response body this file produced, for the sweep in afterAll. */
const responses: string[] = []

/**
 * A profiles read, projected through the columns the table actually HAS.
 *
 * Asking for a column outside the schema returns Postgres 42703
 * (`undefined_column`) with PostgREST's wording, and returns NO DATA — that
 * whole-query failure is the behaviour that matters, because the encrypted keys
 * live in `preferences`, in the same row as `is_demo`.
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

import { DELETE, GET, POST } from './route'

/** 48 hours out, so the demo is LIVE — an expired one is refused for another reason. */
function liveDemoExpiry(): string {
  return new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
}

function ownerRow(preferences: Record<string, unknown> = {}) {
  return { id: OWNER_ID, preferences, is_demo: false, demo_expires_at: null }
}

function demoRow(preferences: Record<string, unknown> = {}) {
  return { id: DEMO_ID, preferences, is_demo: true, demo_expires_at: liveDemoExpiry() }
}

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/settings/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function deleteRequest(provider: string) {
  return new NextRequest(`http://localhost/api/settings/keys?provider=${provider}`, { method: 'DELETE' })
}

/** Read a response AND bank its text for the sweep at the end. */
async function read(response: Response): Promise<Record<string, unknown>> {
  const text = await response.clone().text()
  responses.push(text)
  responses.push(JSON.stringify(Object.fromEntries(response.headers.entries())))
  return (await response.json().catch(() => ({}))) as Record<string, unknown>
}

/**
 * The refusal body, asserted against the gate MODULE rather than string
 * literals copied out of it — so this route and lib/access/guardrails.ts cannot
 * drift apart silently. `toEqual` is exact: an extra field fails.
 */
async function expectDemoRefusal(response: Response) {
  expect(response.status).toBe(403)
  const gate = demoSettingsGate({ is_demo: true, demo_expires_at: liveDemoExpiry() })
  const body = await read(response)
  expect(body).toEqual({ error: gate.reason, message: gate.message, demo: 'demo-settings-locked' })

  // api-keys-tab.tsx renders `result.error` and nothing else, so an empty one
  // would leave the user staring at an unchanged form.
  expect(typeof body.error).toBe('string')
  expect((body.error as string).length).toBeGreaterThan(0)
  expect(body.message).toMatch(/neither can be changed from inside the demo/i)
  return body
}

function storedKeys(): Record<string, string> {
  return ((row?.preferences as Record<string, unknown>)?.api_keys ?? {}) as Record<string, string>
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

afterAll(() => {
  // Nothing this route can be made to say may contain key material, including
  // on the paths no assertion looked at directly.
  expect(responses.length).toBeGreaterThan(0)
  for (const text of responses) {
    expect(text).not.toContain(OWNER_OPENROUTER)
    expect(text).not.toContain(ATTACKER_OPENAI)
  }
})

describe('POST /api/settings/keys — a demo cannot swap in key material of its own', () => {
  it('THE POINT: a demo POSTing its own key is refused and the provisioned key stays', async () => {
    user = { id: DEMO_ID }
    row = demoRow({ api_keys: { openrouter: 'enc:provisioned-demo-key' } })

    await expectDemoRefusal(await POST(postRequest({ openai: ATTACKER_OPENAI })))

    // The refusal is not just a status code: nothing reached the table.
    expect(writes).toEqual([])
    expect(storedKeys()).toEqual({ openrouter: 'enc:provisioned-demo-key' })
  })

  it('refuses a demo BEFORE the key format is validated, so it hears the real reason', async () => {
    // A demo sending a malformed key must be told the key is locked, not handed
    // "OpenAI key should start with sk-". This is an ORDER assertion: it fails
    // if the gate is moved below the validation block.
    user = { id: DEMO_ID }
    row = demoRow()

    for (const body of [{ openai: 'not-a-key' }, { anthropic: 'nope' }, { openrouter: 'nope' }, {}]) {
      await expectDemoRefusal(await POST(postRequest(body)))
    }
    expect(writes).toEqual([])
  })

  it('refuses a demo whose is_demo flag was dropped but whose deadline survives', async () => {
    user = { id: DEMO_ID }
    row = { id: DEMO_ID, preferences: {}, is_demo: false, demo_expires_at: liveDemoExpiry() }

    await expectDemoRefusal(await POST(postRequest({ openrouter: OWNER_OPENROUTER })))
    expect(writes).toEqual([])
  })

  it('lets a demo READ which keys are configured — "OpenRouter: configured" is part of the demo', async () => {
    user = { id: DEMO_ID }
    row = demoRow({ api_keys: { openrouter: 'enc:provisioned-demo-key' } })

    const response = await GET()
    expect(response.status).toBe(200)
    expect(await read(response)).toEqual({ hasOpenai: false, hasAnthropic: false, hasOpenrouter: true })
  })
})

describe('DELETE /api/settings/keys — a demo cannot clear the key either', () => {
  it('refuses, and the key survives', async () => {
    user = { id: DEMO_ID }
    row = demoRow({ api_keys: { openrouter: 'enc:provisioned-demo-key' } })

    await expectDemoRefusal(await DELETE(deleteRequest('openrouter')))

    expect(writes).toEqual([])
    expect(storedKeys()).toEqual({ openrouter: 'enc:provisioned-demo-key' })
  })

  it('refuses a demo BEFORE the provider is validated', async () => {
    // Same order rule as POST: "the key is locked", not "invalid provider".
    user = { id: DEMO_ID }
    row = demoRow({ api_keys: { openrouter: 'enc:provisioned-demo-key' } })

    await expectDemoRefusal(await DELETE(deleteRequest('made-up-provider')))
    expect(writes).toEqual([])
  })
})

describe('the OWNER is unaffected', () => {
  it('saves a key, encrypted, and reports which providers are configured', async () => {
    const response = await POST(postRequest({ openrouter: OWNER_OPENROUTER }))
    expect(response.status).toBe(200)
    expect(await read(response)).toEqual({
      success: true,
      hasOpenai: false,
      hasAnthropic: false,
      hasOpenrouter: true,
    })

    expect(writes).toHaveLength(1)
    const saved = storedKeys().openrouter
    expect(saved).not.toBe(OWNER_OPENROUTER)
    expect(saved).not.toContain(OWNER_OPENROUTER)
    expect(isEncrypted(saved)).toBe(true)
  })

  it('does not wipe the rest of preferences, or the other providers', async () => {
    // Read-modify-write: `preferences` also holds budget, targeting and model.
    row = ownerRow({
      api_keys: { anthropic: 'enc:existing-anthropic' },
      budget: { periodStart: '2026-08', spentUsd: 3.5, monthlyUsd: 10 },
      targeting: { titles: ['Staff ML Engineer'] },
    })

    expect((await POST(postRequest({ openrouter: OWNER_OPENROUTER }))).status).toBe(200)
    const preferences = writes[0].preferences as Record<string, unknown>
    expect(preferences.budget).toEqual({ periodStart: '2026-08', spentUsd: 3.5, monthlyUsd: 10 })
    expect(preferences.targeting).toEqual({ titles: ['Staff ML Engineer'] })
    expect((preferences.api_keys as Record<string, string>).anthropic).toBe('enc:existing-anthropic')
  })

  it('deletes one provider and leaves the others alone', async () => {
    row = ownerRow({ api_keys: { openrouter: 'enc:owner-openrouter', anthropic: 'enc:owner-anthropic' } })

    const response = await DELETE(deleteRequest('anthropic'))
    expect(response.status).toBe(200)
    expect(await read(response)).toEqual({ success: true })
    expect(storedKeys()).toEqual({ openrouter: 'enc:owner-openrouter' })
  })

  it('still enforces the key-format and provider checks for the owner', async () => {
    const bad = await POST(postRequest({ openai: 'missing-the-prefix' }))
    expect(bad.status).toBe(400)
    expect((await read(bad)).demo).toBeUndefined()

    const badProvider = await DELETE(deleteRequest('made-up-provider'))
    expect(badProvider.status).toBe(400)
    expect((await read(badProvider)).demo).toBeUndefined()

    expect(writes).toEqual([])
  })

  it('rejects an unauthenticated caller before anything else', async () => {
    user = null
    expect((await POST(postRequest({ openrouter: OWNER_OPENROUTER }))).status).toBe(401)
    expect((await DELETE(deleteRequest('openrouter'))).status).toBe(401)
    expect(writes).toEqual([])
  })
})

describe('a refusal only the DATABASE saw', () => {
  it('maps the lockdown trigger 42501 to the SAME clean 403 on POST, not a 500', async () => {
    // The trigger is the backstop for a demo the gate could not see — flags
    // unreadable, or a deployment running older code. Same event, same answer.
    writeFailure = { code: '42501', message: 'demo profiles cannot change API keys' }

    await expectDemoRefusal(await POST(postRequest({ openrouter: OWNER_OPENROUTER })))
    expect(writes).toEqual([])
  })

  it('maps it on DELETE too', async () => {
    row = ownerRow({ api_keys: { openrouter: 'enc:owner-openrouter' } })
    writeFailure = { code: '42501', message: 'demo profiles cannot change API keys' }

    await expectDemoRefusal(await DELETE(deleteRequest('openrouter')))
    expect(writes).toEqual([])
  })

  it('does NOT claim a demo for a 42501 that is not the lockdown', async () => {
    // 42501 is also a plain grant/RLS denial. Telling the owner their keys are
    // locked because they are a demo would be a lie.
    writeFailure = { code: '42501', message: 'permission denied for table profiles' }

    const response = await POST(postRequest({ openrouter: OWNER_OPENROUTER }))
    expect(response.status).toBe(500)
    const body = await read(response)
    expect(body).toEqual({ error: 'Failed to save API keys' })
    expect(body.demo).toBeUndefined()
  })

  it('reports an ordinary write failure as a 500', async () => {
    writeFailure = { code: '08006', message: 'connection failure' }
    expect((await POST(postRequest({ openrouter: OWNER_OPENROUTER }))).status).toBe(500)
    expect((await DELETE(deleteRequest('openrouter'))).status).toBe(500)
  })
})

describe('the profile read', () => {
  it('THE OUTAGE THAT WAS FIXED: a PRE-MIGRATION schema still lets the owner save a key', async () => {
    // `is_demo` does not exist yet, so selecting it fails the WHOLE query and
    // takes `preferences` — where the keys live — down with it. If this route
    // treated that as "cannot prove you are not a demo", the owner could not
    // save a key, and the only escape would be applying a migration the product
    // gives you no way to reach. A missing COLUMN provably means no demo user
    // can exist; readProfileForDemoGuards is what turns that into a retry.
    schema = new Set(PRE_MIGRATION_SCHEMA)
    row = { id: OWNER_ID, preferences: { budget: { periodStart: '', spentUsd: 0, monthlyUsd: 10 } } }

    const response = await POST(postRequest({ openrouter: OWNER_OPENROUTER }))
    expect(response.status).toBe(200)
    expect((await read(response)).hasOpenrouter).toBe(true)

    // …and it really did land, with the rest of preferences intact.
    expect(writes).toHaveLength(1)
    const preferences = writes[0].preferences as Record<string, unknown>
    expect(preferences.budget).toEqual({ periodStart: '', spentUsd: 0, monthlyUsd: 10 })
    expect(isEncrypted((preferences.api_keys as Record<string, string>).openrouter)).toBe(true)

    // The mechanism, pinned: one select naming the demo columns, then a RETRY
    // without them. A single-select route cannot pass this test.
    expect(selects).toHaveLength(2)
    expect(selects[0]).toContain('is_demo')
    expect(selects[1]).not.toContain('is_demo')
    expect(selects[1]).toContain('preferences')
  })

  it('THE OUTAGE THAT WAS FIXED: …and lets the owner DELETE one too', async () => {
    schema = new Set(PRE_MIGRATION_SCHEMA)
    row = { id: OWNER_ID, preferences: { api_keys: { openrouter: 'enc:owner-openrouter', openai: 'enc:owner-openai' } } }

    expect((await DELETE(deleteRequest('openai'))).status).toBe(200)
    expect(storedKeys()).toEqual({ openrouter: 'enc:owner-openrouter' })
  })

  it('fails CLOSED when the profile ROW is missing, even though the columns exist', async () => {
    // Deliberately the opposite answer from the missing-COLUMN case above. An
    // absent row proves nothing about who is calling; an absent column proves
    // no demo user can exist. Both are the safe reading of their own fact.
    row = null

    const response = await POST(postRequest({ openrouter: OWNER_OPENROUTER }))
    expect(response.status).toBe(403)
    expect((await read(response)).demo).toBe('profile-unavailable')
    expect(writes).toEqual([])
  })

  it('fails CLOSED when the read fails for a reason that is not a missing column', async () => {
    selectFailure = { code: 'PGRST301', message: 'JWT expired' }

    const response = await DELETE(deleteRequest('openrouter'))
    expect(response.status).toBe(403)
    expect((await read(response)).demo).toBe('profile-unavailable')
    expect(writes).toEqual([])
  })

  it('refuses an EXPIRED demo with the expiry reason, not the settings one', async () => {
    user = { id: DEMO_ID }
    row = {
      id: DEMO_ID,
      preferences: { api_keys: { openrouter: 'enc:provisioned-demo-key' } },
      is_demo: true,
      demo_expires_at: new Date(Date.now() - 60_000).toISOString(),
    }

    const response = await POST(postRequest({ openai: ATTACKER_OPENAI }))
    expect(response.status).toBe(403)
    const body = await read(response)
    expect(body.demo).toBe('demo-expired')
    expect(body.message).toMatch(/72 hours/)
    expect(writes).toEqual([])
  })
})
