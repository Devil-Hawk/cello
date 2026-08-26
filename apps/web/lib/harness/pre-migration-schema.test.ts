// A schema that predates the access-codes migration must not disable the product.
//
// WHAT HAPPENED
//   The demo guards need profiles.is_demo and profiles.demo_expires_at, so the
//   key loaders started selecting them. Neither column exists until migration
//   20260803000003 runs — and PostgREST fails the WHOLE select when a named
//   column is absent. Because api_keys live in that same row, the result was
//   total: a live audit of a build of this tree returned
//     {"hasKey":false,"canRunLlm":false,"keyProvider":null}
//   for a user whose key was plainly present, with
//     column profiles.is_demo does not exist
//   in the server log, while two older builds returned hasKey:true.
//
//   It also deadlocked. The settings routes select the same columns, so the
//   owner could not save an API key or a budget either — and the documented
//   remedy ("give the account a key before issuing codes") was unreachable.
//
// THE DISTINCTION THIS FILE PROTECTS
//   applyDemoKeyGuards fails CLOSED on an unreadable profile, and that is right:
//   a missing ROW proves nothing, so refusing is honest. A missing COLUMN is a
//   different fact with a stronger conclusion — profiles.is_demo only exists
//   once the migration has run, and a demo user can only be created by a
//   redemption that writes it. No column means NO DEMO CAN EXIST, so treating
//   the caller as an ordinary owner is provably correct rather than a
//   relaxation.
//
//   Collapsing those two cases into one branch is what turned a safety property
//   into an outage. These tests keep them apart.

import { describe, expect, it, vi } from 'vitest'
import { readProfileForDemoGuards } from './keys'

/** Minimal stand-in for the supabase-js query builder chain. */
function fakeDb(handler: (columns: string) => { data: unknown; error: unknown }) {
  const calls: string[] = []
  const db = {
    from: () => ({
      select: (columns: string) => {
        calls.push(columns)
        return {
          eq: () => ({ maybeSingle: async () => handler(columns) }),
        }
      },
    }),
  }
  return { db, calls }
}

const MISSING_COLUMN = {
  code: '42703',
  message: 'column profiles.is_demo does not exist',
}

describe('readProfileForDemoGuards — a pre-migration schema', () => {
  it('retries without the demo columns and still returns the preferences', async () => {
    const { db, calls } = fakeDb((columns) =>
      columns.includes('is_demo')
        ? { data: null, error: MISSING_COLUMN }
        : { data: { id: 'u1', preferences: { api_keys: { openrouter: 'enc:abc' } } }, error: null }
    )

    const { row, error } = await readProfileForDemoGuards(db, 'u1')

    expect(error).toBeNull()
    // The whole point: the key survives a schema that lacks the demo columns.
    expect((row?.preferences as Record<string, unknown>)?.api_keys).toEqual({ openrouter: 'enc:abc' })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('is_demo')
    expect(calls[1]).not.toContain('is_demo')
  })

  it('marks the row so the guards can tell "no column" from "unreadable value"', async () => {
    const { db } = fakeDb((columns) =>
      columns.includes('is_demo')
        ? { data: null, error: MISSING_COLUMN }
        : { data: { id: 'u1', preferences: {} }, error: null }
    )
    const { row } = await readProfileForDemoGuards(db, 'u1')
    expect(row?.demoColumnsAbsent).toBe(true)
    // Deliberately absent rather than null — null would mean "column exists,
    // value unreadable", which must keep failing closed.
    expect(row?.is_demo).toBeUndefined()
  })

  it('recognises the PostgREST schema-cache code and a bare message too', async () => {
    for (const err of [
      { code: 'PGRST204', message: 'schema cache' },
      { code: undefined, message: "column profiles.demo_expires_at does not exist" },
    ]) {
      const { db, calls } = fakeDb((columns) =>
        columns.includes('is_demo')
          ? { data: null, error: err }
          : { data: { id: 'u1', preferences: {} }, error: null }
      )
      const { row, error } = await readProfileForDemoGuards(db, 'u1')
      expect(error, JSON.stringify(err)).toBeNull()
      expect(row?.demoColumnsAbsent, JSON.stringify(err)).toBe(true)
      expect(calls).toHaveLength(2)
    }
  })
})

describe('readProfileForDemoGuards — everything else still fails as before', () => {
  it('does NOT retry on an unrelated error, and surfaces it', async () => {
    const boom = { code: '42501', message: 'permission denied for table profiles' }
    const { db, calls } = fakeDb(() => ({ data: null, error: boom }))

    const { error } = await readProfileForDemoGuards(db, 'u1')

    expect(error).toEqual(boom)
    // One attempt only: a permission error is not a schema-drift signal, and
    // retrying would hide it.
    expect(calls).toHaveLength(1)
  })

  it('returns a null row when the profile genuinely does not exist', async () => {
    const { db } = fakeDb(() => ({ data: null, error: null }))
    const { row, error } = await readProfileForDemoGuards(db, 'nobody')
    expect(row).toBeNull()
    expect(error).toBeNull()
  })

  it('passes the demo columns through untouched when the schema HAS them', async () => {
    const { db, calls } = fakeDb(() => ({
      data: { id: 'u1', preferences: {}, is_demo: true, demo_expires_at: '2026-08-06T00:00:00Z' },
      error: null,
    }))
    const { row } = await readProfileForDemoGuards(db, 'u1')
    expect(row?.is_demo).toBe(true)
    expect(row?.demo_expires_at).toBe('2026-08-06T00:00:00Z')
    expect(row?.demoColumnsAbsent).toBeUndefined()
    expect(calls).toHaveLength(1) // no wasted round trip on the happy path
  })

  it('supports extra columns a caller needs, in both attempts', async () => {
    const { db, calls } = fakeDb((columns) =>
      columns.includes('is_demo')
        ? { data: null, error: MISSING_COLUMN }
        : { data: { id: 'u1', preferences: {}, full_name: 'A' }, error: null }
    )
    await readProfileForDemoGuards(db, 'u1', 'full_name')
    expect(calls[0]).toContain('full_name')
    expect(calls[1]).toContain('full_name')
  })
})

describe('the loaders and routes that must never hard-require the demo columns', () => {
  // A source-level check, in the style of spend-chokepoints.test.ts: the failure
  // this guards against is invisible in any single file, because each select
  // looks perfectly reasonable on its own.
  const FILES = [
    'lib/apikeys.ts',
    'lib/outreach/config.ts',
    'app/api/settings/budget/route.ts',
    'app/api/settings/keys/route.ts',
    'app/api/outreach/send/route.ts',
    'app/api/digest/send/route.ts',
  ]

  it.each(FILES)('%s reads the profile through the tolerant helper', async (file) => {
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const src = readFileSync(path.resolve(process.cwd(), file), 'utf8')

    const hardSelect = /\.select\(\s*['"`][^'"`]*is_demo[^'"`]*['"`]\s*\)/.test(src)
    expect(
      hardSelect,
      `${file} selects is_demo directly. When that column is absent PostgREST fails the WHOLE ` +
        `select, and because api_keys live in the same row this disables every AI feature — and, ` +
        `in the settings routes, removes the only way to fix it. Use readProfileForDemoGuards().`
    ).toBe(false)
    expect(src).toContain('readProfileForDemoGuards')
  })
})
