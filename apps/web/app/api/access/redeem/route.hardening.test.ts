// Redemption hardening — the failures that are INVISIBLE when they happen.
//
// route.test.ts already pins the ordering that fences the service key: nothing
// is created unless a code was found by hash and passed accessCodeUsability().
// This file pins a different class of bug, the one thing these all share being
// that the endpoint keeps returning 200 while the feature is quietly broken:
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
//   * failing to recover a half-created workspace, or recovering the wrong one;
//   * a read-modify-write redemption counter that loses concurrent redemptions;
//   * a refusal whose RESPONSE TIME says whether the code exists;
//   * re-provisioning a workspace that has already spent money and handing it a
//     fresh allowance.
//
// The fake below is a small PostgREST: it records every query with its filters,
// so a test can assert not just the answer but HOW it was asked — which is the
// only way to test a compare-and-swap or a constant-time refusal.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const createUser = vi.fn()
const generateLink = vi.fn()
// GoTrue is the ONLY source allowed to answer "which auth user owns this demo
// mailbox" — the route resolves identity by the id the code recorded rather
// than by an email recomputed from DEMO_EMAIL_DOMAIN, so the mock needs it.
const getUserById = vi.fn()
const verifyOtp = vi.fn()
const signOut = vi.fn()
const seedDemoWorkspace = vi.fn()

interface Filter {
  op: string
  column: string
  value: unknown
}

interface Query {
  table: string
  op: 'select' | 'update' | 'insert'
  columns?: string
  payload?: Record<string, unknown>
  filters: Filter[]
}

/** Every query the route issued, in order. */
let queries: Query[] = []

/** What the fake answers with. Each test sets only what it cares about. */
let state: {
  codeRow: Record<string, unknown> | null
  /** Rows returned for `profiles.eq('id', …)`, keyed by id. */
  profilesById: Record<string, Record<string, unknown>>
  /** Rows the conditional claim matched; [] means someone else won. */
  claimResult: Array<{ id: string }>
  /**
   * What the `select('demo_user_id')` re-read reports after a LOST claim — i.e.
   * which user the winner recorded. Distinct from codeRow on purpose: the row
   * was unclaimed when this redemption read it, and claimed by the time it
   * looked again, which is the only way to exercise the race-loser branch.
   */
  codeAfterRace: { demo_user_id: string | null } | null
  /** Rows each redemption_count compare-and-swap matches, consumed in order. */
  casResults: Array<Array<{ id: string }>>
  /** What a re-read of the code row reports after a lost CAS. */
  countAfterRace: { redemption_count: number; first_redeemed_at: string | null } | null
}

function filtered(query: Query, column: string): Filter | undefined {
  return query.filters.find((f) => f.column === column)
}

/**
 * Every time the route asked public.profiles WHO a mailbox belongs to.
 *
 * Must always be empty: a select on profiles filtered by email IS the question
 * only auth.users may answer, whatever is done with the rows afterwards.
 */
function profileEmailLookups(): Query[] {
  return queries.filter((q) => q.table === 'profiles' && q.op === 'select' && Boolean(filtered(q, 'email')))
}

function resolve(query: Query): { data: unknown; error: unknown } {
  if (query.table === 'access_code_events') {
    // Both the audit insert and refuseUnknownCode's decoy read.
    return { data: [], error: null }
  }

  if (query.table === 'profiles') {
    if (query.op !== 'select') return { data: null, error: null }
    // DELIBERATELY NOT AN ANSWER. Identity may only come from GoTrue now, so
    // the fake refuses to play the part public.profiles used to play; the
    // attempt is caught by profileEmailLookups() rather than left to decide
    // anything here.
    if (filtered(query, 'email')) return { data: [], error: null }
    const id = filtered(query, 'id')?.value as string | undefined
    return { data: (id && state.profilesById[id]) || null, error: null }
  }

  // access_codes
  if (query.op === 'select') {
    // Three reads, told apart by their column lists: the bookkeeping re-read
    // asks for exactly these two, the lost-claim re-read asks for demo_user_id
    // alone, and the code lookup asks for a much wider set containing both.
    if (state.countAfterRace && query.columns === 'redemption_count, first_redeemed_at') {
      return { data: state.countAfterRace, error: null }
    }
    if (state.codeAfterRace && query.columns === 'demo_user_id') {
      return { data: state.codeAfterRace, error: null }
    }
    return { data: state.codeRow, error: null }
  }
  if (query.op === 'update') {
    // The claim and the release both write demo_user_id; everything else on
    // this table is the redemption counter.
    if (query.payload && 'demo_user_id' in query.payload) {
      return { data: state.claimResult, error: null }
    }
    return { data: state.casResults.shift() ?? [{ id: 'code-1' }], error: null }
  }
  return { data: null, error: null }
}

function builder(query: Query) {
  const chain: Record<string, unknown> = {}
  const withFilter = (op: string) => (column: string, value: unknown) => {
    query.filters.push({ op, column, value })
    return chain
  }
  Object.assign(chain, {
    select: (columns?: string) => {
      query.columns = columns
      return chain
    },
    eq: withFilter('eq'),
    is: withFilter('is'),
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => {
      const { data, error } = resolve(query)
      return { data: Array.isArray(data) ? (data[0] ?? null) : data, error }
    },
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(resolve(query)).then(res, rej),
  })
  return chain
}

function record(table: string, op: Query['op'], payload?: Record<string, unknown>) {
  const query: Query = { table, op, payload, filters: [] }
  queries.push(query)
  return builder(query)
}

const admin = {
  from(table: string) {
    return {
      select: (columns?: string) => {
        const chain = record(table, 'select')
        return (chain as { select: (c?: string) => unknown }).select(columns)
      },
      update: (payload: Record<string, unknown>) => record(table, 'update', payload),
      insert: (payload: Record<string, unknown>) => record(table, 'insert', payload),
    }
  },
  auth: { admin: { createUser, generateLink, getUserById } },
}

vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => admin }))
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
import { _resetRedeemRateLimitState } from '../rate-limit'

const GOOD_CODE = 'P7QK-3M9X-TCR2'
const UUID = '11111111-2222-4333-8444-555555555555'
const DEMO_ID = 'demo-user-1'
const OTHER_ID = 'demo-user-2'
const HOUR = 3_600_000

/** Derived here exactly as the route derives it — from the code's ROW ID, never
 *  from the code — so the two cannot drift apart without a test noticing. */
const LOCAL_PART = `demo-${UUID.replace(/-/g, '').slice(0, 16)}`
const DEMO_EMAIL = `${LOCAL_PART}@demo.cello.invalid`
/** The same local part under a DIFFERENT domain: what DEMO_EMAIL_DOMAIN having
 *  changed since a code's first redemption leaves on the recorded auth user. */
const STALE_EMAIL = `${LOCAL_PART}@demo.cello.example`

function post(body: unknown) {
  return new NextRequest('http://localhost/api/access/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.9' },
    body: JSON.stringify(body),
  })
}

function liveCode(overrides: Record<string, unknown> = {}) {
  return {
    id: UUID,
    owner_user_id: 'owner-1',
    demo_user_id: null,
    expires_at: new Date(Date.now() + 48 * HOUR).toISOString(),
    revoked_at: null,
    first_redeemed_at: null,
    redemption_count: 0,
    ...overrides,
  }
}

let errors: string[] = []

beforeEach(() => {
  vi.clearAllMocks()
  _resetRedeemRateLimitState()
  queries = []
  errors = []
  state = {
    codeRow: liveCode(),
    profilesById: { [DEMO_ID]: { id: DEMO_ID, preferences: {} }, 'owner-1': { preferences: {} } },
    claimResult: [{ id: 'code-1' }],
    codeAfterRace: null,
    casResults: [],
    countAfterRace: null,
  }
  createUser.mockResolvedValue({ data: { user: { id: DEMO_ID } }, error: null })
  generateLink.mockResolvedValue({
    data: { properties: { hashed_token: 'token-hash-abc' } },
    error: null,
  })
  // The route resolves identity from GoTrue by the id the code recorded, and
  // refuses unless that user's mailbox is the one derived from the code id.
  // Model the agreement here; individual tests override it to force a refusal.
  getUserById.mockResolvedValue({
    data: { user: { id: DEMO_ID, email: DEMO_EMAIL } },
    error: null,
  })
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
    state.codeRow = liveCode({ demo_user_id: DEMO_ID, redemption_count: 3 })

    const response = await POST(post({ code: GOOD_CODE }))

    expect(response.status).toBe(200)
    expect(verifyOtp).toHaveBeenCalledTimes(1)
    // The question was asked about the id the CODE recorded — the one handle in
    // this exchange that no visitor can influence — and asked of GoTrue.
    expect(getUserById).toHaveBeenCalledWith(DEMO_ID)
    // And the session was minted for the address that id actually holds.
    expect(generateLink.mock.calls[0][0].email).toBe(DEMO_EMAIL)
    expect(profileEmailLookups()).toEqual([])
  })

  it('REFUSES when the address resolves to a different user than the code recorded', async () => {
    // What DEMO_EMAIL_DOMAIN changing looks like from here: the code's recorded
    // auth user still holds the OLD address, so the address this redemption
    // derives belongs to somebody else — a fresh, empty user at the new domain.
    // Signing in by the derived address would land the visitor in that empty
    // workspace while the code still pointed at the original, so every later
    // request would be unattributable: a 200 that silently ends the audit trail.
    state.codeRow = liveCode({ demo_user_id: DEMO_ID })
    getUserById.mockResolvedValue({
      data: { user: { id: DEMO_ID, email: STALE_EMAIL } },
      error: null,
    })

    const response = await POST(post({ code: GOOD_CODE }))

    expect(response.status).toBe(500)
    // Refused BEFORE a token exists, let alone a cookie.
    expect(generateLink).not.toHaveBeenCalled()
    expect(verifyOtp).not.toHaveBeenCalled()
    expect(errors.join('\n')).toMatch(/DEMO_EMAIL_DOMAIN/)
  })

  it('refuses when GoTrue holds no such user for the id the code recorded', async () => {
    // A recorded demo_user_id that auth.users does not know is a broken
    // invariant, not an answer — the previous shape of this test asked
    // public.profiles the same question and treated "no row" the same way.
    state.codeRow = liveCode({ demo_user_id: DEMO_ID })
    getUserById.mockResolvedValue({ data: { user: null }, error: null })

    const response = await POST(post({ code: GOOD_CODE }))

    expect(response.status).toBe(500)
    expect(generateLink).not.toHaveBeenCalled()
    expect(verifyOtp).not.toHaveBeenCalled()
    // Actionable without leaking the mailbox: the id is the handle an operator
    // needs to go and look at the row.
    expect(errors.join('\n')).toContain(DEMO_ID)
  })

  it('refuses when the recorded user has no address on file', async () => {
    // "No address" cannot equal the derived one, and must not be allowed to
    // pass by being falsy on both sides of the comparison.
    state.codeRow = liveCode({ demo_user_id: DEMO_ID })
    getUserById.mockResolvedValue({ data: { user: { id: DEMO_ID, email: null } }, error: null })

    const response = await POST(post({ code: GOOD_CODE }))

    expect(response.status).toBe(500)
    expect(verifyOtp).not.toHaveBeenCalled()
  })

  it('refuses when GoTrue cannot answer at all, rather than proceeding', async () => {
    // This replaces "two profiles share the demo address". That ambiguity was a
    // property of public.profiles.email — writable by anyone, no unique
    // constraint — and it is structurally impossible here: identity now comes
    // from a lookup by PRIMARY KEY in auth.users, which returns one user or
    // none. What survives is the property the ambiguity test was really
    // protecting: when the authority does not give a usable answer, refuse
    // rather than pick or assume. A fail-open here would sign the visitor in on
    // an unverified address, which is the whole bug.
    state.codeRow = liveCode({ demo_user_id: DEMO_ID })
    getUserById.mockResolvedValue({ data: null, error: { message: 'auth admin unavailable' } })

    const response = await POST(post({ code: GOOD_CODE }))

    expect(response.status).toBe(500)
    expect(generateLink).not.toHaveBeenCalled()
    expect(verifyOtp).not.toHaveBeenCalled()
    expect(errors.join('\n')).toMatch(/auth admin unavailable/)
  })

  it('refuses when the race winner recorded a different user than the address owns', async () => {
    // The row was UNCLAIMED when this redemption read it and claimed by the
    // time it looked again, so this is the race-loser branch and not the
    // recorded-id one. The winner recorded somebody else, which means the
    // "they created the same auth user we did" assumption — true only while
    // DEMO_EMAIL_DOMAIN never changes — has broken. Signing in on the address
    // we resolved would hand out a session the code cannot be attributed to.
    state.codeRow = liveCode({ demo_user_id: null })
    state.claimResult = [] // someone else claimed it first
    state.codeAfterRace = { demo_user_id: OTHER_ID }

    const response = await POST(post({ code: GOOD_CODE }))

    expect(response.status).toBe(500)
    expect(seedDemoWorkspace).not.toHaveBeenCalled()
    expect(verifyOtp).not.toHaveBeenCalled()
    expect(errors.join('\n')).toMatch(/DEMO_EMAIL_DOMAIN/)
  })

  it('still attributes the race loser to the winner when the two agree', async () => {
    // The other half of that branch, and the reason it cannot simply refuse
    // every lost race: losing the claim is the NORMAL outcome of two people
    // opening the same link at once. The loser must still be signed in — as the
    // winner's user, so the audit trail stays under one id — and must not seed
    // a second time on top of the workspace the winner is building.
    state.codeRow = liveCode({ demo_user_id: null })
    state.claimResult = []
    state.codeAfterRace = { demo_user_id: DEMO_ID }
    verifyOtp.mockResolvedValue({ data: { user: { id: DEMO_ID } }, error: null })

    const response = await POST(post({ code: GOOD_CODE }))

    expect(response.status).toBe(200)
    expect(seedDemoWorkspace).not.toHaveBeenCalled()
    expect(verifyOtp).toHaveBeenCalledTimes(1)
    expect(signOut).not.toHaveBeenCalled()
  })

  it('takes the cookie back if the session resolves to the wrong user after all', async () => {
    // The divergence the earlier checks CANNOT see: GoTrue agrees about the
    // recorded user's address, and the link still gets spent on somebody else.
    // This is the last of the three identity checks and the only one that fires
    // after a Set-Cookie exists, which is why refusing is not enough by itself.
    state.codeRow = liveCode({ demo_user_id: DEMO_ID })
    verifyOtp.mockResolvedValue({ data: { user: { id: OTHER_ID } }, error: null })

    const response = await POST(post({ code: GOOD_CODE }))

    expect(response.status).toBe(500)
    // The cookie was already written by verifyOtp, so refusing is not enough.
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('accepts a session the SDK confirms is the right user', async () => {
    state.codeRow = liveCode({ demo_user_id: DEMO_ID })
    verifyOtp.mockResolvedValue({ data: { user: { id: DEMO_ID } }, error: null })

    expect((await POST(post({ code: GOOD_CODE }))).status).toBe(200)
    expect(signOut).not.toHaveBeenCalled()
  })

  // WHY THESE DRIVE REFUSALS AND NOT THE HAPPY PATH.
  //
  // The previous shape of this test redeemed SUCCESSFULLY and then asserted
  // `errors` contained no '@'. A successful redemption logs nothing at all, so
  // the assertion was matching the empty string and could never fail — it stayed
  // green against a route that did interpolate both addresses into its refusal.
  // An assertion about what a log line may not contain only bites on a path that
  // writes one, so every refusal that has an address in SCOPE when it builds its
  // message is driven below, and each is required to have logged something
  // before it is required to have logged no address.
  //
  // The property: ids and the code id are the handles an operator needs. The
  // demo address is derived from a row id and the other belongs to whoever that
  // user turns out to be, so neither belongs in a log — and a refusal is exactly
  // the moment somebody is tempted to dump them in "to make it debuggable".
  const REFUSALS_WITH_AN_ADDRESS_IN_SCOPE: Array<{
    name: string
    arrange: () => void
    /** An opaque handle the message MUST still carry, so trimming it to nothing
     *  is not a way to pass. */
    mustName: string
  }> = [
    {
      name: 'the recorded user holds a different address',
      arrange: () => {
        state.codeRow = liveCode({ demo_user_id: DEMO_ID })
        getUserById.mockResolvedValue({
          data: { user: { id: DEMO_ID, email: STALE_EMAIL } },
          error: null,
        })
      },
      mustName: DEMO_ID,
    },
    {
      name: 'the recorded user holds no address at all',
      arrange: () => {
        state.codeRow = liveCode({ demo_user_id: DEMO_ID })
        getUserById.mockResolvedValue({
          data: { user: { id: DEMO_ID, email: null } },
          error: null,
        })
      },
      mustName: DEMO_ID,
    },
    {
      name: 'the race winner recorded somebody else',
      arrange: () => {
        state.codeRow = liveCode({ demo_user_id: null })
        state.claimResult = []
        state.codeAfterRace = { demo_user_id: OTHER_ID }
      },
      mustName: UUID,
    },
  ]

  for (const refusal of REFUSALS_WITH_AN_ADDRESS_IN_SCOPE) {
    it(`never puts either address in a log line when ${refusal.name}`, async () => {
      refusal.arrange()

      const response = await POST(post({ code: GOOD_CODE }))
      const logged = errors.join('\n')

      expect(response.status).toBe(500)
      // GUARD AGAINST THE VACUOUS PASS. Without this the two assertions below
      // are satisfied by the empty string, which is precisely how the earlier
      // version of this test stayed green while the route leaked.
      expect(logged).not.toBe('')
      // Actionable: the opaque handle survives...
      expect(logged).toContain(refusal.mustName)
      // ...and the addresses do not. Matching '@' rather than the two constants
      // catches a THIRD address as well — the point is that no mailbox reaches
      // a log here, not that these particular two do not.
      expect(logged).not.toMatch(/@/)
    })
  }

  it('never asks public.profiles who owns the demo address', async () => {
    // THE STRUCTURAL VERSION OF EVERYTHING ABOVE, and the reason the mechanism
    // changed: "Users can update own profile" has no WITH CHECK and no column
    // list, and profiles.email has no unique constraint, so any signed-in
    // stranger can claim a code's demo address on their own row. A route that
    // resolved identity there would hand them the workspace. Both paths that
    // need an identity are exercised: the recorded-id one and the recovery one.
    state.codeRow = liveCode({ demo_user_id: DEMO_ID })
    await POST(post({ code: GOOD_CODE }))

    _resetRedeemRateLimitState()
    state.codeRow = liveCode({ demo_user_id: null })
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
    // "already registered" — the only recoverable createUser failure.
    createUser.mockResolvedValue({ data: null, error: { message: 'User already registered' } })
  })

  it('recovers the user GoTrue names for the mailbox', async () => {
    // The recovery question — "who is already registered at this address?" — is
    // an identity question, so generateLink answers it: its response names the
    // user the token was minted for. That is the same call the sign-in makes a
    // moment later, so recovery cannot drift from the identity that ends up
    // mattering, which a separate profiles lookup could.
    generateLink.mockResolvedValue({
      data: { user: { id: DEMO_ID }, properties: { hashed_token: 'token-hash-abc' } },
      error: null,
    })

    const response = await POST(post({ code: GOOD_CODE }))

    expect(response.status).toBe(200)
    expect(seedDemoWorkspace).toHaveBeenCalledWith(admin, DEMO_ID)
    expect(generateLink.mock.calls[0][0]).toMatchObject({ type: 'magiclink', email: DEMO_EMAIL })
    expect(profileEmailLookups()).toEqual([])
  })

  it('refuses — loudly — rather than proceeding on an id GoTrue never gave', async () => {
    // This replaces "refuses when the address is ambiguous". Ambiguity was a
    // property of the profiles table: two rows could carry one address, and the
    // route had to be stopped from picking. GoTrue returns a single user or an
    // error, so there is nothing left to pick BETWEEN — but the half that
    // mattered survives: a recovery that cannot name a user must refuse, not
    // guess, and must say so loudly enough to diagnose.
    generateLink.mockResolvedValue({ data: null, error: { message: 'link minting refused' } })

    const response = await POST(post({ code: GOOD_CODE }))

    expect(response.status).toBe(500)
    expect(seedDemoWorkspace).not.toHaveBeenCalled()
    expect(verifyOtp).not.toHaveBeenCalled()
    // The reported failure is createUser's, which is the useful one — and no
    // other source of identity was consulted to paper over it.
    expect(errors.join('\n')).toMatch(/User already registered/)
    expect(createUser).toHaveBeenCalledTimes(1)
    expect(profileEmailLookups()).toEqual([])
  })

  it('still reports the original failure when there is nothing to recover', async () => {
    // GoTrue answered, and named nobody: no account to recover, so the
    // redemption fails with the error that actually explains it.
    generateLink.mockResolvedValue({
      data: { properties: { hashed_token: 'token-hash-abc' } },
      error: null,
    })

    const response = await POST(post({ code: GOOD_CODE }))

    expect(response.status).toBe(500)
    expect(errors.join('\n')).toMatch(/User already registered/)
    expect(verifyOtp).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// (3) The redemption counter
// ---------------------------------------------------------------------------

function countWrites(): Query[] {
  return queries.filter(
    (q) => q.table === 'access_codes' && q.op === 'update' && q.payload?.redemption_count !== undefined
  )
}

describe('redemption_count is a compare-and-swap, not a blind write', () => {
  it('guards the write with the value it read', async () => {
    state.codeRow = liveCode({ demo_user_id: DEMO_ID, redemption_count: 4, first_redeemed_at: 'earlier' })

    await POST(post({ code: GOOD_CODE }))

    const writes = countWrites()
    expect(writes).toHaveLength(1)
    expect(writes[0].payload).toMatchObject({ redemption_count: 5, first_redeemed_at: 'earlier' })
    // THE POINT: without this filter two concurrent redemptions both read 4 and
    // both write 5, and the owner's usage number quietly loses one.
    expect(writes[0].filters).toContainEqual({ op: 'eq', column: 'redemption_count', value: 4 })
  })

  it('retries from the value the concurrent redemption left behind', async () => {
    state.codeRow = liveCode({ demo_user_id: DEMO_ID, redemption_count: 4 })
    state.casResults = [[]] // our first swap matched nothing
    state.countAfterRace = { redemption_count: 7, first_redeemed_at: 'earlier' }

    await POST(post({ code: GOOD_CODE }))

    const writes = countWrites()
    expect(writes).toHaveLength(2)
    expect(writes[1].payload).toMatchObject({ redemption_count: 8, first_redeemed_at: 'earlier' })
    expect(writes[1].filters).toContainEqual({ op: 'eq', column: 'redemption_count', value: 7 })
  })

  it('gives up loudly rather than looping or blind-writing', async () => {
    // The swap matched nothing yet the row still reads the same value: the row
    // is gone, or filtered, or the column is not what we think. Retrying would
    // spin forever, and writing anyway is the bug we just removed.
    state.codeRow = liveCode({ demo_user_id: DEMO_ID, redemption_count: 4 })
    state.casResults = [[], [], [], []]
    state.countAfterRace = { redemption_count: 4, first_redeemed_at: null }

    const response = await POST(post({ code: GOOD_CODE }))

    expect(countWrites()).toHaveLength(1)
    expect(errors.join('\n')).toMatch(/made no progress/)
    // An inaccurate summary must never cost someone their demo.
    expect(response.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// (4) The refusal must not time-leak whether the code exists
// ---------------------------------------------------------------------------

describe('a refusal costs the same whether or not the code exists', () => {
  it('spends the same number of database round trips either way', async () => {
    state.codeRow = null
    await POST(post({ code: GOOD_CODE }))
    const unknown = [...queries]

    _resetRedeemRateLimitState()
    queries = []
    state.codeRow = liveCode({ expires_at: new Date(Date.now() - HOUR).toISOString() })
    await POST(post({ code: GOOD_CODE }))
    const dead = [...queries]

    // Padding hides the difference only while both fit inside the floor. Two
    // round trips against one is measurable against a real database, and it
    // answers the single question this endpoint refuses to answer in words.
    expect(unknown).toHaveLength(dead.length)
    expect(unknown).toHaveLength(2)
  })

  it('creates nothing on the unknown path — the decoy is a read', async () => {
    state.codeRow = null

    await POST(post({ code: GOOD_CODE }))

    expect(queries.filter((q) => q.op === 'insert' || q.op === 'update')).toEqual([])
    expect(createUser).not.toHaveBeenCalled()
    // Same table as the audit insert it is standing in for, and an id
    // gen_random_uuid() cannot produce.
    const decoy = queries[1]
    expect(decoy.table).toBe('access_code_events')
    expect(decoy.filters[0].value).toBe('00000000-0000-0000-0000-000000000000')
  })

  it('still records the denied attempt for a code that does exist', async () => {
    // The trail is a promise to the owner; the decoy exists so that keeping it
    // does not cost a timing oracle.
    state.codeRow = liveCode({ revoked_at: new Date(Date.now() - HOUR).toISOString() })

    await POST(post({ code: GOOD_CODE }))

    const events = queries.filter((q) => q.table === 'access_code_events' && q.op === 'insert')
    expect(events).toHaveLength(1)
    expect(events[0].payload).toMatchObject({ kind: 'denied', code_id: UUID })
  })
})

// ---------------------------------------------------------------------------
// (5) Re-provisioning must not refill the allowance
// ---------------------------------------------------------------------------

describe('a retried first redemption does not refill the demo’s allowance', () => {
  function preferencesWrite(): Record<string, unknown> | undefined {
    const write = queries.find(
      (q) => q.table === 'profiles' && q.op === 'update' && q.payload?.preferences !== undefined
    )
    return write?.payload?.preferences as Record<string, unknown> | undefined
  }

  it('carries the spend already on the row into the re-provisioned block', async () => {
    // The reachable path: a first redemption won the claim, provisioned, then
    // failed mid-seed and released the claim. The retry runs provisioning again
    // on a profile that has already spent money.
    const period = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`
    state.profilesById[DEMO_ID] = {
      id: DEMO_ID,
      preferences: { budget: { periodStart: period, spentUsd: 0.9, monthlyUsd: 1 } },
    }

    await POST(post({ code: GOOD_CODE }))

    expect(preferencesWrite()?.budget).toEqual({ periodStart: period, spentUsd: 0.9, monthlyUsd: 1 })
  })

  it('still starts a genuinely fresh workspace at zero', async () => {
    state.profilesById[DEMO_ID] = { id: DEMO_ID, preferences: {} }

    await POST(post({ code: GOOD_CODE }))

    expect(preferencesWrite()?.budget).toMatchObject({ spentUsd: 0, monthlyUsd: 1 })
  })
})

// ---------------------------------------------------------------------------
// Confirming the compensation that was already in place
// ---------------------------------------------------------------------------

describe('a failed seed releases the claim it made', () => {
  it('clears demo_user_id, and only its OWN claim', async () => {
    seedDemoWorkspace.mockRejectedValue(new Error('seed exploded'))

    const response = await POST(post({ code: GOOD_CODE }))

    expect(response.status).toBe(500)

    const release = queries.find(
      (q) => q.table === 'access_codes' && q.op === 'update' && q.payload?.demo_user_id === null
    )
    expect(release).toBeDefined()
    // Guarded on the id WE wrote: a concurrent redemption that re-claimed the
    // code in the meantime must not have its claim torn out from under it.
    expect(release!.filters).toContainEqual({ op: 'eq', column: 'demo_user_id', value: DEMO_ID })
    expect(release!.filters).toContainEqual({ op: 'eq', column: 'id', value: UUID })
  })

  it('leaves the code redeemable again rather than bricked', async () => {
    // The compensation exists so the NEXT attempt can win the claim and seed.
    // Asserting the released state is what makes that more than a comment.
    seedDemoWorkspace.mockRejectedValue(new Error('seed exploded'))

    await POST(post({ code: GOOD_CODE }))

    const release = queries.find(
      (q) => q.table === 'access_codes' && q.op === 'update' && q.payload?.demo_user_id === null
    )
    expect(release!.payload).toEqual({ demo_user_id: null })
  })
})
