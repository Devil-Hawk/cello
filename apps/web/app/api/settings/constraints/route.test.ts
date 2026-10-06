// GET and PUT /api/settings/constraints. The regression that matters: PUT is a
// read-modify-write of profiles.preferences, so saving dealbreakers must never
// wipe the saved API keys or any other preference. Saving also marks the
// person's roles for another look so the new facts apply.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = {
  user: { id: 'u1' } as { id: string } | null,
  preferences: { api_keys: { openrouter: 'ENCRYPTED' }, digest: { enabled: true }, targeting: { countries: ['US'], excludedCompanies: ['acme'] } } as Record<string, unknown>,
  written: null as Record<string, unknown> | null,
  readError: false,
  writeError: false,
}
const adminUpdates: { table: string; patch: unknown; col: string; value: unknown }[] = []

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user }, error: null }) },
    from: () => {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = () => chain
      chain.maybeSingle = async () => (state.readError ? { data: null, error: { message: 'boom' } } : { data: { preferences: state.preferences }, error: null })
      chain.update = (patch: Record<string, unknown>) => {
        state.written = patch
        return { eq: async () => (state.writeError ? { error: { message: 'write failed' } } : { error: null }) }
      }
      return chain
    },
  }),
}))
vi.mock('@/lib/harness/supabase-admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      update: (patch: unknown) => ({
        eq: async (col: string, value: unknown) => {
          adminUpdates.push({ table, patch, col, value })
          return { error: null }
        },
      }),
    }),
  }),
}))

import { GET, PUT } from './route'

const BODY = {
  blockedCountries: ['de'],
  onlyCountries: ['us', 'US'],
  onsiteCities: ['Seattle'],
  needsSponsorship: false,
  salaryFloorUsd: 190000,
  remoteOnly: false,
  excludedCompanies: ['Coinbase'],
  refusedSeniority: ['manager', 'manager'],
  excludedTitleWords: ['Crypto'],
}
const put = (body: unknown) => PUT(new NextRequest('http://localhost/api/settings/constraints', { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' } }))

beforeEach(() => {
  state.user = { id: 'u1' }
  state.written = null
  state.readError = false
  state.writeError = false
  adminUpdates.length = 0
})

describe('GET /api/settings/constraints', () => {
  it('returns what the person stated, with the older targeting lists folded in, and 401 when signed out', async () => {
    const res = await GET()
    const { constraints } = await res.json()
    expect(constraints.onlyCountries).toEqual(['US'])
    expect(constraints.excludedCompanies).toEqual(['acme'])
    state.user = null
    expect((await GET()).status).toBe(401)
  })
})

describe('PUT /api/settings/constraints', () => {
  it('keeps the saved API keys and every other preference when it writes (the read-modify-write regression)', async () => {
    const res = await put(BODY)
    expect(res.status).toBe(200)
    const written = (state.written as { preferences: Record<string, unknown> }).preferences
    expect(written.api_keys).toEqual({ openrouter: 'ENCRYPTED' })
    expect(written.digest).toEqual({ enabled: true })
    expect(written.targeting).toEqual({ countries: ['US'], excludedCompanies: ['acme'] })
  })

  it('stores what was typed, tidied: upper-case countries, lower-case words, no duplicates', async () => {
    await put(BODY)
    const written = (state.written as { preferences: { constraints: Record<string, unknown> } }).preferences.constraints
    expect(written).toEqual({
      blockedCountries: ['DE'],
      onlyCountries: ['US'],
      onsiteCities: ['seattle'],
      needsSponsorship: false,
      salaryFloorUsd: 190000,
      remoteOnly: false,
      excludedCompanies: ['coinbase'],
      refusedSeniority: ['manager'],
      excludedTitleWords: ['crypto'],
    })
  })

  it('marks the person\'s roles for another look so the new facts apply', async () => {
    await put(BODY)
    expect(adminUpdates).toEqual([{ table: 'person_roles', patch: { checked_at: null }, col: 'user_id', value: 'u1' }])
  })

  it('refuses a body that is not a set of dealbreakers, and writes nothing', async () => {
    for (const bad of [{ ...BODY, salaryFloorUsd: -5 }, { ...BODY, onlyCountries: ['USA'] }, { ...BODY, refusedSeniority: ['wizard'] }, { ...BODY, remoteOnly: 'yes' }, {}, 'not json']) {
      const res = await put(bad)
      expect(res.status, JSON.stringify(bad)).toBe(400)
      expect(typeof (await res.json()).error).toBe('string')
    }
    expect(state.written).toBeNull()
    expect(adminUpdates).toHaveLength(0)
  })

  it('is 401 signed out, and a 500 with a plain message when the profile cannot be read or written', async () => {
    state.user = null
    expect((await put(BODY)).status).toBe(401)
    state.user = { id: 'u1' }
    state.readError = true
    expect((await put(BODY)).status).toBe(500)
    state.readError = false
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    state.writeError = true
    const res = await put(BODY)
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('write failed')
  })
})
