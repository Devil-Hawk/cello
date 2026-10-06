// POST /api/access-codes/:id/revoke: revoking must end sessions already minted.
//
// Revoking used to set access_codes.revoked_at and nothing else, so a demo that
// had already redeemed kept working (and spending the owner's key) until its 72
// hours ran out. The route now calls revoke_access_code, which in ONE transaction
// revokes the code and pulls the demo profile's deadline to now(), then bans the
// demo's auth user so its refresh tokens die too. What this file pins:
//   * the demo id comes from the DATABASE's answer, never the request;
//   * a cross-site request, a demo caller, a signed-out caller and another
//     owner's code never reach the revocation or the ban;
//   * the already-revoked branch bans too, so a retry finishes the job;
//   * a failed ban is a 500, not a silent success.
// The transaction itself (revoked_at, the profile deadline, ownership) is proven
// against a real database in lib/access/access-codes.db.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const OWNER = '11111111-1111-4111-8111-111111111111'
const CODE = '22222222-2222-4222-8222-222222222222'
const DEMO = '33333333-3333-4333-8333-333333333333'

let user: { id: string } | null
let profile: Record<string, unknown> | null
let revokeResult: { data?: unknown; error?: { message: string } | null }
let banError: { message: string } | null
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>
let bans: Array<{ id: string; attrs: Record<string, unknown> }>

const ROW = {
  id: CODE,
  label: null,
  code_prefix: 'P7QK',
  created_at: '2026-10-01T00:00:00.000Z',
  expires_at: '2026-10-04T00:00:00.000Z',
  revoked_at: '2026-10-02T00:00:00.000Z',
  first_redeemed_at: null,
  last_used_at: null,
  redemption_count: 0,
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    from: () => {
      const b: Record<string, unknown> = {}
      Object.assign(b, {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({ data: profile ?? ROW, error: null }),
      })
      return b
    },
  }),
}))

vi.mock('@/lib/harness/supabase-admin', () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args })
      return { data: null, error: null, ...revokeResult }
    },
    auth: {
      admin: {
        updateUserById: async (id: string, attrs: Record<string, unknown>) => {
          bans.push({ id, attrs })
          return { data: null, error: banError }
        },
      },
    },
  }),
}))

import { POST } from './route'

function post(id: string = CODE, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }) {
  return POST(new NextRequest(`http://localhost/api/access-codes/${id}/revoke`, { method: 'POST', headers }), {
    params: { id },
  })
}

beforeEach(() => {
  user = { id: OWNER }
  // The profile read and the code re-read share one fake: an owner's profile has
  // no demo signal; the re-read returns ROW because `profile` is cleared there.
  profile = { is_demo: false, demo_expires_at: null, ...ROW }
  revokeResult = { data: { found: true, revoked: true, demo_user_id: DEMO } }
  banError = null
  rpcCalls = []
  bans = []
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('POST /api/access-codes/:id/revoke', () => {
  it('revokes through the function with the owner id from the session, then bans the demo user', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json()).alreadyRevoked).toBe(false)

    expect(rpcCalls).toEqual([{ fn: 'revoke_access_code', args: { p_code_id: CODE, p_owner_id: OWNER } }])
    // The demo id is the one the DATABASE answered with, banned permanently.
    expect(bans).toEqual([{ id: DEMO, attrs: { ban_duration: '87600h' } }])
  })

  it('an unredeemed code bans nobody', async () => {
    revokeResult = { data: { found: true, revoked: true, demo_user_id: null } }
    const res = await post()
    expect(res.status).toBe(200)
    expect(bans).toEqual([])
  })

  it('the already-revoked branch bans too, so a retry finishes the job', async () => {
    revokeResult = { data: { found: true, revoked: false, demo_user_id: DEMO } }
    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json()).alreadyRevoked).toBe(true)
    expect(bans).toHaveLength(1)
  })

  it("another owner's or a missing code is a 404 and bans nobody", async () => {
    revokeResult = { data: { found: false, revoked: false, demo_user_id: null } }
    const res = await post()
    expect(res.status).toBe(404)
    expect(bans).toEqual([])
  })

  it('a malformed id is a 404 and never reaches the database', async () => {
    const res = await post('not-a-uuid')
    expect(res.status).toBe(404)
    expect(rpcCalls).toEqual([])
  })

  it('signed out is a 401 and never reaches the database', async () => {
    user = null
    const res = await post()
    expect(res.status).toBe(401)
    expect(rpcCalls).toEqual([])
  })

  it('a cross-site request is refused before anything else', async () => {
    for (const headers of <Record<string, string>[]>[{ 'sec-fetch-site': 'cross-site' }, {}]) {
      const res = await post(CODE, headers)
      expect(res.status).toBe(403)
      expect((await res.json()).error).toMatch(/didn't come from Cello/)
    }
    expect(rpcCalls).toEqual([])
    expect(bans).toEqual([])
  })

  it('a demo caller cannot revoke', async () => {
    profile = { is_demo: true, demo_expires_at: '2026-10-04T00:00:00.000Z' }
    expect((await post()).status).toBe(403)
    expect(rpcCalls).toEqual([])
  })

  it('a failed revocation is a 500 and bans nobody', async () => {
    revokeResult = { error: { message: 'boom' } }
    expect((await post()).status).toBe(500)
    expect(bans).toEqual([])
  })

  it('a failed ban is a 500 so the owner retries, and the retry takes the already-revoked path', async () => {
    banError = { message: 'auth admin down' }
    expect((await post()).status).toBe(500)

    banError = null
    revokeResult = { data: { found: true, revoked: false, demo_user_id: DEMO } }
    const retry = await post()
    expect(retry.status).toBe(200)
    expect((await retry.json()).alreadyRevoked).toBe(true)
    expect(bans).toHaveLength(2)
  })
})
