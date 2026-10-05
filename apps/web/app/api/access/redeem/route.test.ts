// What this file is really testing: the ORDERING that fences the service key.
//
// POST /api/access/redeem is the only unauthenticated route in the app that can
// create an auth user. The property that must never regress is that nothing is
// created, and no session is issued, unless Postgres (redeem_access_code) said
// the code is redeemable. Several tests below assert on what was NOT called,
// which is unusual and deliberate.
//
// The decision itself, the row lock and the limiter's arithmetic are proven
// against a real database in lib/access/access-codes.db.test.ts. Here the three
// functions are answered by a fake, so what is tested is the ROUTE: same-origin,
// the limiter's fail-closed behaviour, identical refusals, who may provision,
// and that the plaintext code goes nowhere.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { createRedeemFake } from '@/lib/test-support/redeem-fake'
import { accessCodeLookupHashes } from '@/lib/access/codes'

const fake = createRedeemFake()
const { createUser, generateLink, getUserById, verifyOtp, seedDemoWorkspace } = fake.mocks

vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => fake.admin }))
vi.mock('@/lib/access/seed-demo', () => ({
  seedDemoWorkspace: (...args: unknown[]) => seedDemoWorkspace(...args),
}))
vi.mock('next/headers', () => ({
  cookies: () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}))
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { verifyOtp: (...a: unknown[]) => verifyOtp(...a), signOut: async () => ({ error: null }) } }),
}))

import { POST } from './route'

/** A well-formed code: 12 characters, all from the code alphabet. */
const GOOD_CODE = 'P7QK-3M9X-TCR2'
const UUID = '11111111-2222-4333-8444-555555555555'
const DEMO_ID = 'demo-user-1'
const HOUR = 3_600_000
const EXPIRES = new Date(Date.now() + 48 * HOUR).toISOString()

function post(body: unknown, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }) {
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

const PROVISION = { status: 'provision', code_id: UUID, owner_user_id: 'owner-1', expires_at: EXPIRES }
const EXISTING = { status: 'existing', code_id: UUID, owner_user_id: 'owner-1', demo_user_id: DEMO_ID, expires_at: EXPIRES }

beforeEach(() => {
  vi.clearAllMocks()
  fake.clear()
  fake.state.limiter = true
  fake.state.redeem = { status: 'refused' }
  fake.state.finish = true
  fake.state.profilesById = {
    [DEMO_ID]: { id: DEMO_ID, preferences: {} },
    'owner-1': { id: 'owner-1', preferences: OWNER_PREFERENCES },
  }
  createUser.mockResolvedValue({ data: { user: { id: DEMO_ID } }, error: null })
  // The recorded demo_user_id and the mailbox GoTrue holds for it must AGREE, or
  // the route refuses: that agreement keeps the audit trail attributable.
  getUserById.mockResolvedValue({
    data: { user: { id: DEMO_ID, email: 'demo-1111111122224333@demo.cello.invalid' } },
    error: null,
  })
  generateLink.mockResolvedValue({ data: { properties: { hashed_token: 'token-hash-abc' } }, error: null })
  verifyOtp.mockResolvedValue({ data: {}, error: null })
  seedDemoWorkspace.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

const redeemCalls = () => fake.rpcCalls.filter((c) => c.fn === 'redeem_access_code')

describe('POST /api/access/redeem: same-origin', () => {
  it('refuses a cross-site POST with the refusal body, before counting or reading anything', async () => {
    fake.state.redeem = PROVISION
    for (const headers of [
      { 'sec-fetch-site': 'cross-site' },
      { origin: 'https://evil.example', host: 'localhost' },
      {}, // no origin signal at all
    ]) {
      const response = await POST(post({ code: GOOD_CODE }, headers))
      expect(response.status).toBe(403)
      expect((await response.json()).ok).toBe(false)
    }
    expect(fake.rpcCalls).toEqual([])
    expect(createUser).not.toHaveBeenCalled()
    expect(fake.queries).toEqual([])
  })
})

describe('POST /api/access/redeem: the limiter', () => {
  it('answers 429 when Postgres says the client or the global cap is hit, before the body is read', async () => {
    fake.state.limiter = false
    const response = await POST(post({ code: GOOD_CODE }))
    expect(response.status).toBe(429)
    expect(redeemCalls()).toEqual([])
    expect(createUser).not.toHaveBeenCalled()
  })

  it('FAILS CLOSED with the ordinary server-error copy when the limiter cannot count', async () => {
    fake.state.limiter = 'error'
    fake.state.redeem = PROVISION
    const response = await POST(post({ code: GOOD_CODE }))
    expect(response.status).toBe(503)
    expect((await response.json()).error).toBe('Something went wrong on our end. Try again in a moment.')
    expect(redeemCalls()).toEqual([])
    expect(createUser).not.toHaveBeenCalled()
  })

  it('sends only the hashed client key to Postgres, never the address', async () => {
    await POST(post({ code: GOOD_CODE }))
    const attempt = fake.rpcCalls.find((c) => c.fn === 'note_redeem_attempt')!
    expect(attempt.args.p_client).toMatch(/^[0-9a-f]{32}$/)
    expect(JSON.stringify(fake.rpcCalls)).not.toContain('203.0.113.9')
  })
})

describe('POST /api/access/redeem: refusals', () => {
  it('rejects a malformed code without reaching the redemption function or creating anything', async () => {
    const response = await POST(post({ code: 'not-a-code' }))
    expect(response.status).toBe(401)
    expect(redeemCalls()).toEqual([])
    expect(createUser).not.toHaveBeenCalled()
    expect(fake.writes()).toEqual([])
  })

  it('rejects a missing body the same way', async () => {
    const response = await POST(post('this is not json'))
    expect(response.status).toBe(401)
    expect(createUser).not.toHaveBeenCalled()
  })

  it('says byte-for-byte the same thing for an unknown, expired, revoked and used code', async () => {
    const outcomes: Array<Record<string, unknown>> = [
      { status: 'refused' },
      { status: 'refused', code_id: UUID, reason: 'expired' },
      { status: 'refused', code_id: UUID, reason: 'revoked' },
      { status: 'refused', code_id: UUID, reason: 'used' },
    ]
    const responses: Array<{ status: number; text: string }> = []
    for (const outcome of outcomes) {
      fake.state.redeem = outcome
      const res = await POST(post({ code: GOOD_CODE }))
      responses.push({ status: res.status, text: await res.text() })
    }
    // The whole point: nothing in the response distinguishes "this code exists"
    // from "it does not", or why it is dead. Anything else is an oracle.
    expect(new Set(responses.map((r) => `${r.status} ${r.text}`)).size).toBe(1)
    expect(responses[0].status).toBe(401)
    expect(JSON.parse(responses[0].text).ok).toBe(false)
    expect(responses[0].text).not.toMatch(/expired|revoked|used/i)
  })

  it('creates nothing for any refusal, but records the denied attempt with its reason for codes that exist', async () => {
    fake.state.redeem = { status: 'refused', code_id: UUID, reason: 'revoked' }
    await POST(post({ code: GOOD_CODE }))

    expect(createUser).not.toHaveBeenCalled()
    expect(seedDemoWorkspace).not.toHaveBeenCalled()
    expect(verifyOtp).not.toHaveBeenCalled()
    const events = fake.writes().filter((q) => q.table === 'access_code_events')
    expect(events).toHaveLength(1)
    expect(events[0].payload).toMatchObject({ kind: 'denied', code_id: UUID })
    expect(JSON.stringify(events[0].payload)).toContain('revoked')
  })

  it('an unknown code costs the same round trips as a dead one: a decoy read stands in for the audit insert', async () => {
    fake.state.redeem = { status: 'refused' }
    await POST(post({ code: GOOD_CODE }))
    const unknown = fake.queries.length
    expect(fake.writes()).toEqual([])
    expect(fake.queries[0].table).toBe('access_code_events')

    fake.clear()
    fake.state.redeem = { status: 'refused', code_id: UUID, reason: 'expired' }
    await POST(post({ code: GOOD_CODE }))
    expect(fake.queries.length).toBe(unknown)
  })

  it('answers 503 and creates nothing while another request holds the provisioning lease', async () => {
    fake.state.redeem = { status: 'busy' }
    const response = await POST(post({ code: GOOD_CODE }))
    expect(response.status).toBe(503)
    expect(createUser).not.toHaveBeenCalled()
    expect(verifyOtp).not.toHaveBeenCalled()
  })

  it('answers a server error when the redemption function fails or says something unexpected', async () => {
    fake.state.redeem = 'error'
    expect((await POST(post({ code: GOOD_CODE }))).status).toBe(500)
    fake.state.redeem = { status: 'provision' } // no code id: unusable
    expect((await POST(post({ code: GOOD_CODE }))).status).toBe(500)
    fake.state.redeem = { status: 'nonsense', code_id: UUID }
    expect((await POST(post({ code: GOOD_CODE }))).status).toBe(500)
    expect(createUser).not.toHaveBeenCalled()
  })
})

describe('POST /api/access/redeem: first redemption', () => {
  beforeEach(() => {
    fake.state.redeem = PROVISION
  })

  it('creates the demo user, seeds it, records it on the code, and signs the browser in', async () => {
    const response = await POST(post({ code: GOOD_CODE }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ ok: true, redirect: '/dashboard', expiresAt: EXPIRES })
    expect(createUser).toHaveBeenCalledTimes(1)
    expect(seedDemoWorkspace).toHaveBeenCalledWith(fake.admin, DEMO_ID)
    expect(fake.rpcCalls.find((c) => c.fn === 'finish_access_code_provisioning')!.args).toEqual({
      p_code_id: UUID,
      p_demo_user_id: DEMO_ID,
    })
    // Signed in via a server-minted one-time token, never a password.
    expect(createUser.mock.calls[0][0]).not.toHaveProperty('password')
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'token-hash-abc', type: 'magiclink' })
  })

  it('looks the code up by its keyed hash AND the legacy hash, never the plaintext', async () => {
    await POST(post({ code: GOOD_CODE }))
    const call = redeemCalls()[0]
    expect(call.args).toEqual({ p_hashes: accessCodeLookupHashes(GOOD_CODE) })
    expect((call.args.p_hashes as string[])[0]).toMatch(/^h1:[0-9a-f]{64}$/)
  })

  it('gives the demo user a mailbox that cannot exist, so no mail can ever reach it', async () => {
    await POST(post({ code: GOOD_CODE }))
    const email = createUser.mock.calls[0][0].email as string
    expect(email.endsWith('.invalid')).toBe(true)
    expect(email).toContain(UUID.replace(/-/g, '').slice(0, 16))
  })

  it('marks the profile as a demo workspace with the code’s own expiry', async () => {
    await POST(post({ code: GOOD_CODE }))
    const profileWrite = fake.writes().find((q) => q.table === 'profiles' && q.payload?.is_demo === true)
    expect(profileWrite?.payload).toEqual({ is_demo: true, demo_expires_at: EXPIRES })
  })

  it('carries the owner’s model key across but nothing else about the owner', async () => {
    await POST(post({ code: GOOD_CODE }))
    const prefsWrite = fake.writes().find((q) => q.table === 'profiles' && q.payload?.preferences !== undefined)
    const prefs = (prefsWrite!.payload as { preferences: Record<string, unknown> }).preferences

    expect(prefs.api_keys).toEqual(OWNER_PREFERENCES.api_keys)
    expect(prefs.targeting).toBeUndefined()
    // Fenced: a $1 cap and no spend counters (the ledger holds those), no Gmail
    // grants, nothing armed to send.
    expect(prefs.budget).toEqual({ monthlyUsd: 1 })
    expect(prefs.gmail_permissions).not.toMatchObject({ send: true })
    expect(prefs.outreach).toMatchObject({ autoSend: false })
  })

  it('records the redemption in the audit trail (the count was taken inside Postgres)', async () => {
    await POST(post({ code: GOOD_CODE }))
    const events = fake.writes().filter((q) => q.table === 'access_code_events')
    expect(events).toHaveLength(1)
    expect(events[0].payload).toMatchObject({ kind: 'redeemed', action: 'code.redeem' })
    // No code-row bookkeeping from the route: the function owns it.
    expect(fake.writes().filter((q) => q.table === 'access_codes')).toEqual([])
  })

  it('refuses the session if seeding fails, and releases the lease so the next attempt can provision', async () => {
    seedDemoWorkspace.mockRejectedValue(new Error('seed exploded'))
    const response = await POST(post({ code: GOOD_CODE }))

    expect(response.status).toBe(500)
    expect(verifyOtp).not.toHaveBeenCalled()
    expect(fake.rpcCalls.some((c) => c.fn === 'finish_access_code_provisioning')).toBe(false)
    const release = fake.writes().find((q) => q.table === 'access_codes')
    expect(release?.payload).toEqual({ provisioning_until: null })
    expect(release?.filters).toContainEqual({ op: 'eq', column: 'id', value: UUID })
    // Only ever a code nobody has finished: it never clears a recorded demo.
    expect(release?.filters).toContainEqual({ op: 'is', column: 'demo_user_id', value: null })
  })

  it('refuses when the code stopped being redeemable during provisioning (finish says no)', async () => {
    fake.state.finish = false
    const response = await POST(post({ code: GOOD_CODE }))
    expect(response.status).toBe(500)
    expect(verifyOtp).not.toHaveBeenCalled()
  })
})

describe('POST /api/access/redeem: repeat redemption', () => {
  it('reuses the existing workspace instead of creating or seeding another', async () => {
    fake.state.redeem = EXISTING
    const response = await POST(post({ code: GOOD_CODE }))

    expect(response.status).toBe(200)
    expect(createUser).not.toHaveBeenCalled()
    expect(seedDemoWorkspace).not.toHaveBeenCalled()
    expect(fake.rpcCalls.some((c) => c.fn === 'finish_access_code_provisioning')).toBe(false)
    expect(verifyOtp).toHaveBeenCalled()
  })
})

describe('POST /api/access/redeem: the plaintext code', () => {
  it('never reaches the database, any log line or the response', async () => {
    const logged: string[] = []
    for (const level of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')))
    }
    // A success, a refusal and a failure: every path that logs.
    const outcomes = [PROVISION, EXISTING, { status: 'refused', code_id: UUID, reason: 'expired' }, 'error' as const]
    const responses: string[] = []
    for (const outcome of outcomes) {
      fake.state.redeem = outcome
      responses.push(await (await POST(post({ code: GOOD_CODE }))).text())
    }
    const serialized = JSON.stringify({ queries: fake.queries, responses, logged })
    const forms = [GOOD_CODE, GOOD_CODE.replace(/-/g, ''), GOOD_CODE.toLowerCase()]
    for (const form of forms) expect(serialized).not.toContain(form)
    // The hashes go to the redemption function (that is its input) and nowhere else.
    expect(JSON.stringify(fake.rpcCalls.filter((c) => c.fn !== 'redeem_access_code'))).not.toContain('h1:')
  })

  it('the route source never hands the typed code to a log, an audit row or a response', () => {
    const src = readFileSync(path.join(process.cwd(), 'app/api/access/redeem/route.ts'), 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n')
    const uses = src.match(/[^\n]*\btyped\b[^\n]*/g) ?? []
    // Declared, assigned from the body, shape-checked and hashed: nothing else.
    for (const line of uses) {
      expect(line).toMatch(/let typed|typed = |looksLikeAccessCode\(typed\)|accessCodeLookupHashes\(typed\)/)
    }
    expect(src).not.toMatch(/console\.\w+\([^)]*typed/)
    expect(src).not.toMatch(/recordAccessEvent\([^)]*typed/)
  })
})
