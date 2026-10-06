// Redemption hardening: the failures that are INVISIBLE when they happen.
//
// route.test.ts pins the ordering that fences the service key. This file pins
// the class of bug where the endpoint keeps returning 200 while the feature is
// quietly broken:
//
//   * signing someone into a DIFFERENT auth user than the code recorded, which
//     costs the owner the entire audit trail they asked for (resolveDemoContext
//     finds the code BY demo_user_id) without anything looking wrong;
//   * answering "which auth user owns this demo mailbox" from anywhere but
//     GoTrue. The route used to answer it from public.profiles, whose email
//     column every signed-in user may write to any string and which carries no
//     unique constraint, so a stranger who learned a code's demo address could
//     point that address at themselves and be handed the workspace, the owner's
//     model key and the code's audit trail. auth.users is the record the visitor
//     has no way to write, so it is the only one allowed to answer;
//   * failing to recover a half-created workspace, or recovering the wrong one.
//
// What moved to Postgres, and is proven there (access-codes.db.test.ts): the
// attempt limiter, the race between concurrent redemptions, the redemption
// counter, which codes are refused and why, and revocation.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { createRedeemFake } from '@/lib/test-support/redeem-fake'

const fake = createRedeemFake()
const { createUser, generateLink, getUserById, verifyOtp, signOut, seedDemoWorkspace } = fake.mocks

vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => fake.admin }))
vi.mock('@/lib/access/seed-demo', () => ({
  seedDemoWorkspace: (...args: unknown[]) => seedDemoWorkspace(...args),
}))
vi.mock('next/headers', () => ({
  cookies: () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}))
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      verifyOtp: (...a: unknown[]) => verifyOtp(...a),
      signOut: (...a: unknown[]) => signOut(...a),
    },
  }),
}))

import { POST } from './route'

const GOOD_CODE = 'P7QK-3M9X-TCR2'
const UUID = '11111111-2222-4333-8444-555555555555'
const DEMO_ID = 'demo-user-1'
const OTHER_ID = 'demo-user-2'
const HOUR = 3_600_000
const EXPIRES = new Date(Date.now() + 48 * HOUR).toISOString()

/** Derived here exactly as the route derives it, from the code's ROW ID and never
 *  from the code, so the two cannot drift apart without a test noticing. */
const LOCAL_PART = `demo-${UUID.replace(/-/g, '').slice(0, 16)}`
const DEMO_EMAIL = `${LOCAL_PART}@demo.cello.invalid`
/** The same local part under a DIFFERENT domain: what DEMO_EMAIL_DOMAIN having
 *  changed since a code's first redemption leaves on the recorded auth user. */
const STALE_EMAIL = `${LOCAL_PART}@demo.cello.example`

function post(body: unknown) {
  return new NextRequest('http://localhost/api/access/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.9', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify(body),
  })
}

const PROVISION = { status: 'provision', code_id: UUID, owner_user_id: 'owner-1', expires_at: EXPIRES }
const EXISTING = { status: 'existing', code_id: UUID, owner_user_id: 'owner-1', demo_user_id: DEMO_ID, expires_at: EXPIRES }

/** Every time the route asked public.profiles WHO a mailbox belongs to. Must always
 *  be empty: a select on profiles filtered by email IS the question only
 *  auth.users may answer, whatever is done with the rows afterwards. */
function profileEmailLookups() {
  return fake.queries.filter((q) => q.table === 'profiles' && q.op === 'select' && q.filters.some((f) => f.column === 'email'))
}

let errors: string[] = []

beforeEach(() => {
  vi.clearAllMocks()
  fake.clear()
  errors = []
  fake.state.limiter = true
  fake.state.redeem = EXISTING
  fake.state.finish = true
  fake.state.profilesById = { [DEMO_ID]: { id: DEMO_ID, preferences: {} }, 'owner-1': { preferences: {} } }
  createUser.mockResolvedValue({ data: { user: { id: DEMO_ID } }, error: null })
  generateLink.mockResolvedValue({ data: { properties: { hashed_token: 'token-hash-abc' } }, error: null })
  // The route resolves identity from GoTrue by the id the code recorded, and
  // refuses unless that user's mailbox is the one derived from the code id.
  getUserById.mockResolvedValue({ data: { user: { id: DEMO_ID, email: DEMO_EMAIL } }, error: null })
  verifyOtp.mockResolvedValue({ data: {}, error: null })
  signOut.mockResolvedValue({ error: null })
  seedDemoWorkspace.mockResolvedValue(undefined)
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '))
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// (1) The session must belong to the user the code recorded
// ---------------------------------------------------------------------------

describe('the mailbox signed in with must be the user the code recorded', () => {
  it('signs in on a repeat redemption when the address and the recorded id agree', async () => {
    const response = await POST(post({ code: GOOD_CODE }))

    expect(response.status).toBe(200)
    expect(verifyOtp).toHaveBeenCalledTimes(1)
    // Asked about the id the CODE recorded, the one handle in this exchange no
    // visitor can influence, and asked of GoTrue.
    expect(getUserById).toHaveBeenCalledWith(DEMO_ID)
    expect(generateLink.mock.calls[0][0].email).toBe(DEMO_EMAIL)
    expect(profileEmailLookups()).toEqual([])
  })

  it('REFUSES when the address resolves to a different user than the code recorded', async () => {
    // What DEMO_EMAIL_DOMAIN changing looks like from here: the code's recorded
    // auth user still holds the OLD address, so signing in by the derived
    // address would land the visitor in a fresh, empty workspace while the code
    // still pointed at the original: a 200 that silently ends the audit trail.
    getUserById.mockResolvedValue({ data: { user: { id: DEMO_ID, email: STALE_EMAIL } }, error: null })

    const response = await POST(post({ code: GOOD_CODE }))

    expect(response.status).toBe(500)
    // Refused BEFORE a token exists, let alone a cookie.
    expect(generateLink).not.toHaveBeenCalled()
    expect(verifyOtp).not.toHaveBeenCalled()
    expect(errors.join('\n')).toMatch(/DEMO_EMAIL_DOMAIN/)
  })

  it('refuses when GoTrue holds no such user for the id the code recorded', async () => {
    getUserById.mockResolvedValue({ data: { user: null }, error: null })

    const response = await POST(post({ code: GOOD_CODE }))

    expect(response.status).toBe(500)
    expect(generateLink).not.toHaveBeenCalled()
    expect(verifyOtp).not.toHaveBeenCalled()
    // Actionable without leaking the mailbox: the id is the handle an operator needs.
    expect(errors.join('\n')).toContain(DEMO_ID)
  })

  it('refuses when the recorded user has no address on file', async () => {
    getUserById.mockResolvedValue({ data: { user: { id: DEMO_ID, email: null } }, error: null })
    expect((await POST(post({ code: GOOD_CODE }))).status).toBe(500)
    expect(verifyOtp).not.toHaveBeenCalled()
  })

  it('refuses when GoTrue cannot answer at all, rather than proceeding', async () => {
    // When the authority does not give a usable answer, refuse rather than pick
    // or assume. A fail-open here would sign the visitor in on an unverified
    // address, which is the whole bug.
    getUserById.mockResolvedValue({ data: null, error: { message: 'auth admin unavailable' } })

    const response = await POST(post({ code: GOOD_CODE }))

    expect(response.status).toBe(500)
    expect(generateLink).not.toHaveBeenCalled()
    expect(verifyOtp).not.toHaveBeenCalled()
    expect(errors.join('\n')).toMatch(/auth admin unavailable/)
  })

  it('takes the cookie back if the session resolves to the wrong user after all', async () => {
    // The divergence the earlier checks CANNOT see: GoTrue agrees about the
    // recorded user's address, and the link still gets spent on somebody else.
    // The only identity check that fires after a Set-Cookie exists, which is why
    // refusing is not enough by itself.
    verifyOtp.mockResolvedValue({ data: { user: { id: OTHER_ID } }, error: null })

    const response = await POST(post({ code: GOOD_CODE }))

    expect(response.status).toBe(500)
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('accepts a session the SDK confirms is the right user', async () => {
    verifyOtp.mockResolvedValue({ data: { user: { id: DEMO_ID } }, error: null })
    expect((await POST(post({ code: GOOD_CODE }))).status).toBe(200)
    expect(signOut).not.toHaveBeenCalled()
  })

  // WHY THESE DRIVE REFUSALS AND NOT THE HAPPY PATH. An assertion about what a
  // log line may not contain only bites on a path that writes one, so every
  // refusal that has an address in SCOPE when it builds its message is driven
  // here, and each is required to have logged something before it is required
  // to have logged no address.
  const REFUSALS_WITH_AN_ADDRESS_IN_SCOPE: Array<{ name: string; arrange: () => void }> = [
    {
      name: 'the recorded user holds a different address',
      arrange: () => getUserById.mockResolvedValue({ data: { user: { id: DEMO_ID, email: STALE_EMAIL } }, error: null }),
    },
    {
      name: 'the recorded user holds no address at all',
      arrange: () => getUserById.mockResolvedValue({ data: { user: { id: DEMO_ID, email: null } }, error: null }),
    },
  ]

  for (const refusal of REFUSALS_WITH_AN_ADDRESS_IN_SCOPE) {
    it(`never puts either address in a log line when ${refusal.name}`, async () => {
      refusal.arrange()

      const response = await POST(post({ code: GOOD_CODE }))
      const logged = errors.join('\n')

      expect(response.status).toBe(500)
      // GUARD AGAINST THE VACUOUS PASS: the empty string satisfies the rest.
      expect(logged).not.toBe('')
      expect(logged).toContain(DEMO_ID)
      // Matching '@' rather than the two constants catches a THIRD address too.
      expect(logged).not.toMatch(/@/)
    })
  }

  it('never asks public.profiles who owns the demo address', async () => {
    // The structural version of everything above: any signed-in stranger can
    // claim a code's demo address on their own profiles row, so a route that
    // resolved identity there would hand them the workspace. Both paths that
    // need an identity are exercised: the recorded-id one and the recovery one.
    await POST(post({ code: GOOD_CODE }))

    fake.state.redeem = PROVISION
    createUser.mockResolvedValue({ data: null, error: { message: 'User already registered' } })
    generateLink.mockResolvedValue({
      data: { user: { id: DEMO_ID }, properties: { hashed_token: 'token-hash-abc' } },
      error: null,
    })
    await POST(post({ code: GOOD_CODE }))

    expect(profileEmailLookups()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// (2) Recovering a half-created workspace
// ---------------------------------------------------------------------------

describe('recovering the user a crashed attempt left behind', () => {
  beforeEach(() => {
    fake.state.redeem = PROVISION
    // "already registered": the only recoverable createUser failure.
    createUser.mockResolvedValue({ data: null, error: { message: 'User already registered' } })
  })

  it('recovers the user GoTrue names for the mailbox', async () => {
    // generateLink answers "who is already registered at this address?": its
    // response names the user the token was minted for. It is the same call the
    // sign-in makes a moment later, so recovery cannot drift from the identity
    // that ends up mattering, which a separate profiles lookup could.
    generateLink.mockResolvedValue({
      data: { user: { id: DEMO_ID }, properties: { hashed_token: 'token-hash-abc' } },
      error: null,
    })

    const response = await POST(post({ code: GOOD_CODE }))

    expect(response.status).toBe(200)
    expect(seedDemoWorkspace).toHaveBeenCalledWith(fake.admin, DEMO_ID)
    expect(generateLink.mock.calls[0][0]).toMatchObject({ type: 'magiclink', email: DEMO_EMAIL })
    expect(profileEmailLookups()).toEqual([])
  })

  it('refuses, loudly, rather than proceeding on an id GoTrue never gave', async () => {
    generateLink.mockResolvedValue({ data: null, error: { message: 'link minting refused' } })

    const response = await POST(post({ code: GOOD_CODE }))

    expect(response.status).toBe(500)
    expect(seedDemoWorkspace).not.toHaveBeenCalled()
    expect(verifyOtp).not.toHaveBeenCalled()
    // The reported failure is createUser's, which is the useful one.
    expect(errors.join('\n')).toMatch(/User already registered/)
    expect(createUser).toHaveBeenCalledTimes(1)
    expect(profileEmailLookups()).toEqual([])
  })

  it('still reports the original failure when there is nothing to recover', async () => {
    generateLink.mockResolvedValue({ data: { properties: { hashed_token: 'token-hash-abc' } }, error: null })

    const response = await POST(post({ code: GOOD_CODE }))

    expect(response.status).toBe(500)
    expect(errors.join('\n')).toMatch(/User already registered/)
    expect(verifyOtp).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// (3) A retried first redemption never refills the allowance
// ---------------------------------------------------------------------------

describe('a retried first redemption does not refill the demo’s allowance', () => {
  function preferencesWrite(): Record<string, unknown> | undefined {
    const write = fake.queries.find((q) => q.table === 'profiles' && q.op === 'update' && q.payload?.preferences !== undefined)
    return write?.payload?.preferences as Record<string, unknown> | undefined
  }

  it('writes no spend counters, so there is nothing on the profile to reset', async () => {
    fake.state.redeem = PROVISION
    fake.state.profilesById[DEMO_ID] = {
      id: DEMO_ID,
      preferences: { budget: { periodStart: '2026-10', spentUsd: 0.9, monthlyUsd: 1 } },
    }

    await POST(post({ code: GOOD_CODE }))

    expect(preferencesWrite()?.budget).toEqual({ monthlyUsd: 1 })
  })

  it('keeps a cap that was already lowered on the row', async () => {
    fake.state.redeem = PROVISION
    fake.state.profilesById[DEMO_ID] = { id: DEMO_ID, preferences: { budget: { monthlyUsd: 0.25 } } }
    await POST(post({ code: GOOD_CODE }))
    expect(preferencesWrite()?.budget).toEqual({ monthlyUsd: 0.25 })
  })
})
