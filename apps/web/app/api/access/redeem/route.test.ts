// What this file is really testing: the ORDERING that fences the service key.
//
// POST /api/access/redeem is the only unauthenticated route in the app that can
// create an auth user. Everything else about the endpoint is replaceable; the
// property that must never regress is that nothing is created, and no session
// is issued, unless a code was found by hash and passed accessCodeUsability().
// Several tests below assert on what was NOT called, which is unusual and
// deliberate.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const createUser = vi.fn()
const generateLink = vi.fn()
// GoTrue is the ONLY source allowed to answer "which auth user owns this demo
// mailbox" — the route resolves identity by the id the code recorded rather
// than by an email recomputed from DEMO_EMAIL_DOMAIN, so the mock needs it.
const getUserById = vi.fn()
const verifyOtp = vi.fn()
const seedDemoWorkspace = vi.fn()

/** Every write the route attempted, in order, so a test can assert both what
 *  reached the database and — for the plaintext code — what never did. */
let writes: Array<{ table: string; op: 'update' | 'insert'; payload: unknown }> = []

/** Row returned for the code lookup. null means "no such code". */
let codeRow: Record<string, unknown> | null = null
/** Row returned for any profiles lookup — the owner's, and the recovery path's. */
let profileRow: Record<string, unknown> | null = null
/** Rows returned by the conditional claim; [] means someone else won the race. */
let claimResult: Array<{ id: string }> = [{ id: 'code-1' }]

function queryResult(data: unknown) {
  const chain: Record<string, unknown> = {}
  const self = () => chain
  Object.assign(chain, {
    select: self,
    eq: self,
    is: self,
    order: self,
    limit: self,
    maybeSingle: async () => ({ data: Array.isArray(data) ? (data[0] ?? null) : data, error: null }),
    // Awaiting the chain directly is how the route runs its updates/inserts.
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve({ data, error: null }).then(resolve, reject),
  })
  return chain
}

const admin = {
  from(table: string) {
    return {
      select: () => queryResult(table === 'profiles' ? profileRow : codeRow),
      update: (payload: unknown) => {
        writes.push({ table, op: 'update', payload })
        return queryResult(table === 'access_codes' ? claimResult : null)
      },
      insert: (payload: unknown) => {
        writes.push({ table, op: 'insert', payload })
        return queryResult(null)
      },
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
  createServerClient: () => ({ auth: { verifyOtp: (...a: unknown[]) => verifyOtp(...a) } }),
}))

import { POST } from './route'
import { _resetRedeemRateLimitState, _REDEEM_LIMITS } from '../rate-limit'

/** A well-formed code: 12 characters, all from the code alphabet. */
const GOOD_CODE = 'P7QK-3M9X-TCR2'
const UUID = '11111111-2222-4333-8444-555555555555'

const HOUR = 3_600_000

function post(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/access/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.9', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

/** What the owner has configured. Only api_keys may ever cross to the demo. */
const OWNER_PREFERENCES = {
  api_keys: { openrouter: 'enc:owner-key' },
  targeting: { titles: ['Staff Engineer'] },
  gmail_permissions: { send: true },
  outreach: { autoSend: true },
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

beforeEach(() => {
  vi.clearAllMocks()
  _resetRedeemRateLimitState()
  writes = []
  codeRow = null
  profileRow = { id: 'demo-user-1', preferences: OWNER_PREFERENCES }
  claimResult = [{ id: 'code-1' }]
  createUser.mockResolvedValue({ data: { user: { id: 'demo-user-1' } }, error: null })
  // The recorded demo_user_id and the mailbox GoTrue holds for it must AGREE,
  // or the route refuses — that agreement is what keeps the audit trail
  // attributable, so the happy-path mock has to model it.
  getUserById.mockResolvedValue({
    data: { user: { id: 'demo-user-1', email: 'demo-1111111122224333@demo.cello.invalid' } },
    error: null,
  })
  generateLink.mockResolvedValue({
    data: { properties: { hashed_token: 'token-hash-abc' } },
    error: null,
  })
  verifyOtp.mockResolvedValue({ data: {}, error: null })
  seedDemoWorkspace.mockResolvedValue(undefined)
})

describe('POST /api/access/redeem — refusals', () => {
  it('rejects a malformed code without touching the database or creating anything', async () => {
    const response = await POST(post({ code: 'not-a-code' }))

    expect(response.status).toBe(401)
    expect(createUser).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  it('rejects a missing body the same way', async () => {
    const response = await POST(post('this is not json'))

    expect(response.status).toBe(401)
    expect(createUser).not.toHaveBeenCalled()
  })

  it('says exactly the same thing for an unknown code as for an expired one', async () => {
    codeRow = null
    const unknown = await POST(post({ code: GOOD_CODE }))
    const unknownBody = await unknown.json()

    _resetRedeemRateLimitState()
    codeRow = liveCode({ expires_at: new Date(Date.now() - HOUR).toISOString() })
    const expired = await POST(post({ code: GOOD_CODE }))
    const expiredBody = await expired.json()

    // The whole point: nothing in the response distinguishes "this code exists"
    // from "it does not". Anything else is an enumeration oracle.
    expect(expired.status).toBe(unknown.status)
    expect(expiredBody).toEqual(unknownBody)
    expect(expiredBody.ok).toBe(false)
  })

  it('creates nothing for an expired code, but does record the denied attempt', async () => {
    codeRow = liveCode({ expires_at: new Date(Date.now() - HOUR).toISOString() })

    const response = await POST(post({ code: GOOD_CODE }))

    expect(response.status).toBe(401)
    expect(createUser).not.toHaveBeenCalled()
    expect(seedDemoWorkspace).not.toHaveBeenCalled()
    expect(verifyOtp).not.toHaveBeenCalled()

    const events = writes.filter(w => w.table === 'access_code_events')
    expect(events).toHaveLength(1)
    expect(events[0].payload).toMatchObject({ kind: 'denied', code_id: UUID })
  })

  it('creates nothing for a revoked code', async () => {
    codeRow = liveCode({ revoked_at: new Date(Date.now() - HOUR).toISOString() })

    const response = await POST(post({ code: GOOD_CODE }))

    expect(response.status).toBe(401)
    expect(createUser).not.toHaveBeenCalled()
    expect(verifyOtp).not.toHaveBeenCalled()
  })

  it('creates nothing when the stored expiry is unreadable — the fail-closed case', async () => {
    codeRow = liveCode({ expires_at: 'not a timestamp' })

    const response = await POST(post({ code: GOOD_CODE }))

    expect(response.status).toBe(401)
    expect(createUser).not.toHaveBeenCalled()
  })

  it('throttles by client before it reads the body or hits the database', async () => {
    codeRow = null
    for (let i = 0; i < _REDEEM_LIMITS.MAX_PER_CLIENT; i++) {
      await POST(post({ code: GOOD_CODE }))
    }

    const response = await POST(post({ code: GOOD_CODE }))
    expect(response.status).toBe(429)
    expect(createUser).not.toHaveBeenCalled()
  })
})

describe('POST /api/access/redeem — first redemption', () => {
  beforeEach(() => {
    codeRow = liveCode()
  })

  it('creates the demo user, seeds it, claims the code, and signs the browser in', async () => {
    const response = await POST(post({ code: GOOD_CODE }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ ok: true, redirect: '/dashboard' })

    expect(createUser).toHaveBeenCalledTimes(1)
    expect(seedDemoWorkspace).toHaveBeenCalledWith(admin, 'demo-user-1')

    // Signed in via a server-minted one-time token, never a password.
    expect(createUser.mock.calls[0][0]).not.toHaveProperty('password')
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'token-hash-abc', type: 'magiclink' })
  })

  it('gives the demo user a mailbox that cannot exist, so no mail can ever reach it', async () => {
    await POST(post({ code: GOOD_CODE }))

    const email = createUser.mock.calls[0][0].email as string
    // RFC 2606 reserves .invalid; a demo account therefore has no password AND
    // no reachable mailbox, which is what makes the code the only way in.
    expect(email.endsWith('.invalid')).toBe(true)
    // Derived from the code's row id, never from the code itself.
    expect(email).toContain(UUID.replace(/-/g, '').slice(0, 16))
  })

  it('marks the profile as a demo workspace with the code’s own expiry', async () => {
    await POST(post({ code: GOOD_CODE }))

    const profileWrite = writes.find(w => w.table === 'profiles' && w.op === 'update')
    expect(profileWrite?.payload).toEqual({
      is_demo: true,
      demo_expires_at: codeRow!.expires_at,
    })
  })

  it('carries the owner’s model key across but nothing else about the owner', async () => {
    await POST(post({ code: GOOD_CODE }))

    const prefsWrite = writes.find(
      w => w.table === 'profiles' && (w.payload as Record<string, unknown>).preferences !== undefined
    )
    const prefs = (prefsWrite!.payload as { preferences: Record<string, unknown> }).preferences

    // The one thing that crosses: without a model key nothing in this product
    // works, and there would be no demo to give.
    expect(prefs.api_keys).toEqual(OWNER_PREFERENCES.api_keys)

    // Everything else is the owner's own configuration and stays behind — an
    // allowlist, so a preference added tomorrow does not leak by default.
    expect(prefs.targeting).toBeUndefined()

    // And the demo lands fenced: its own small ledger, no Gmail grants, nothing
    // armed to send. (The rules themselves are lib/access/guardrails.ts's; this
    // asserts the redemption path actually applies them.)
    expect(prefs.budget).toMatchObject({ spentUsd: 0 })
    expect(prefs.gmail_permissions).not.toMatchObject({ send: true })
    expect(prefs.outreach).toMatchObject({ autoSend: false })
  })

  it('records the redemption on the code row and in the audit trail', async () => {
    await POST(post({ code: GOOD_CODE }))

    const bookkeeping = writes.find(
      w => w.table === 'access_codes' && (w.payload as Record<string, unknown>).redemption_count !== undefined
    )
    expect(bookkeeping?.payload).toMatchObject({ redemption_count: 1 })
    expect((bookkeeping?.payload as Record<string, unknown>).first_redeemed_at).toBeTruthy()

    const events = writes.filter(w => w.table === 'access_code_events')
    expect(events).toHaveLength(1)
    expect(events[0].payload).toMatchObject({ kind: 'redeemed', action: 'code.redeem' })
  })

  it('does not seed twice when a concurrent redemption claimed the code first', async () => {
    claimResult = [] // the conditional update matched nothing: someone else won

    const response = await POST(post({ code: GOOD_CODE }))

    expect(response.status).toBe(200)
    expect(seedDemoWorkspace).not.toHaveBeenCalled()
  })

  it('refuses the session if seeding fails rather than landing anyone on an empty demo', async () => {
    seedDemoWorkspace.mockRejectedValue(new Error('seed exploded'))

    const response = await POST(post({ code: GOOD_CODE }))

    expect(response.status).toBe(500)
    expect(verifyOtp).not.toHaveBeenCalled()
  })
})

describe('POST /api/access/redeem — repeat redemption', () => {
  it('reuses the existing workspace instead of creating or seeding another', async () => {
    codeRow = liveCode({ demo_user_id: 'demo-user-1', redemption_count: 4, first_redeemed_at: 'earlier' })

    const response = await POST(post({ code: GOOD_CODE }))

    expect(response.status).toBe(200)
    expect(createUser).not.toHaveBeenCalled()
    expect(seedDemoWorkspace).not.toHaveBeenCalled()
    expect(verifyOtp).toHaveBeenCalled()

    const bookkeeping = writes.find(
      w => w.table === 'access_codes' && (w.payload as Record<string, unknown>).redemption_count !== undefined
    )
    expect(bookkeeping?.payload).toMatchObject({
      redemption_count: 5,
      // Not overwritten — first_redeemed_at means the FIRST one.
      first_redeemed_at: 'earlier',
    })
  })
})

describe('POST /api/access/redeem — the plaintext code', () => {
  it('never reaches the database and never comes back in the response', async () => {
    codeRow = liveCode()

    const response = await POST(post({ code: GOOD_CODE }))
    const serialized = JSON.stringify({ writes, body: await response.json() })

    // Both the typed form and the normalized form. If either ever appears in a
    // write payload or a response body, the code has stopped being a secret.
    expect(serialized).not.toContain(GOOD_CODE)
    expect(serialized).not.toContain(GOOD_CODE.replace(/-/g, ''))
  })
})
