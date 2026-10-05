// POST /api/access-codes: who may mint an access code, and from where.
//
// THE THING THIS ROUTE HAS TO GET RIGHT: a code is a bearer credential that
// creates a real workspace and burns real model spend. Signed-in users cannot
// write access_codes at all any more (migration 20261006002001), so minting is the
// service-role function mint_access_code, called here only after the caller is
// same-origin, authenticated and a real owner. A demo profile satisfies
// `owner_user_id = auth.uid()` for its own row, so without a refusal a visitor
// handed one 72-hour code could mint more and spawn workspace after workspace of
// real model spend from a single invitation.
//
// It is refused twice, on purpose, and this file checks both:
//   1. here, before minting, by reading the caller's profile (failing closed
//      when it cannot be read);
//   2. in the database, where mint_access_code raises 42501 for a demo owner,
//      which is what still holds if a profile becomes a demo between (1) and the
//      mint, or if some future caller forgets (1) entirely.
//
// The second refusal arrives as SQLSTATE 42501, and a backstop that surfaces as a
// 500 is a backstop nobody can act on. So the database's "no" and the
// application's "no" must be the SAME answer to the caller.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

let reads: string[] = []
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []

let state: {
  user: { id: string } | null
  profile: Record<string, unknown> | null
  profileError: { message: string } | null
  /** What each mint_access_code call answers, consumed in order. */
  mintResults: Array<{ data?: unknown; error?: { code?: string; message: string } | null }>
  allowance: { data?: unknown; error?: { message: string } | null }
}

const ROW = {
  id: 'code-row-1',
  label: null,
  code_prefix: 'P7QK',
  code_hash: 'h1:never-shown',
  demo_user_id: null,
  created_at: '2026-08-03T09:00:00.000Z',
  expires_at: '2026-08-06T09:00:00.000Z',
  revoked_at: null,
  first_redeemed_at: null,
  last_used_at: null,
  redemption_count: 0,
}

/** The owner's cookie-scoped client: identity and (read-only) profile and code reads. */
const supabase = {
  auth: { getUser: async () => ({ data: { user: state.user }, error: null }) },
  from: (table: string) => {
    const chain: Record<string, unknown> = {}
    Object.assign(chain, {
      select: () => {
        reads.push(table)
        return chain
      },
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: state.profile, error: state.profileError }),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(res, rej),
    })
    return chain
  },
}

const admin = {
  rpc: async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args })
    if (fn === 'demo_allowance_state') return { data: null, error: null, ...state.allowance }
    const next = state.mintResults.shift() ?? { data: [ROW], error: null }
    return { data: null, error: null, ...next }
  },
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabase }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => admin }))

import { GET, POST } from './route'

function post(body: unknown = {}, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }) {
  return new NextRequest('http://localhost/api/access-codes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

const mints = () => rpcCalls.filter((c) => c.fn === 'mint_access_code')

beforeEach(() => {
  reads = []
  rpcCalls = []
  state = {
    user: { id: 'owner-1' },
    profile: { is_demo: false, demo_expires_at: null },
    profileError: null,
    mintResults: [],
    allowance: { data: { used_usd: 1.2, cap_usd: 5 } },
  }
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('POST /api/access-codes: the owner', () => {
  it('issues a code and returns the plaintext exactly once', async () => {
    const response = await POST(post({ label: 'Acme walkthrough' }))
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(typeof body.code).toBe('string')
    expect(body.code.length).toBeGreaterThan(0)
    // The summary carries no hash and no demo user.
    expect(JSON.stringify(body.summary)).not.toContain('h1:')
    expect(JSON.stringify(body.summary)).not.toContain('demo_user_id')

    // Only the KEYED hash is ever persisted; the plaintext exists in this
    // response and nowhere else.
    const args = mints()[0].args
    expect(args.p_code_hash).toMatch(/^h1:[0-9a-f]{64}$/)
    expect(args.p_owner_id).toBe('owner-1')
    expect(args.p_label).toBe('Acme walkthrough')
    expect(JSON.stringify(rpcCalls)).not.toContain(body.code.replace(/-/g, ''))
  })
})

describe('POST /api/access-codes: same-origin', () => {
  it('refuses a cross-site request before reading a session or minting', async () => {
    for (const headers of <Record<string, string>[]>[{ 'sec-fetch-site': 'cross-site' }, { origin: 'https://evil.example', host: 'localhost' }, {}]) {
      const response = await POST(post({}, headers))
      expect(response.status).toBe(403)
      expect((await response.json()).error).toMatch(/didn't come from Cello/)
    }
    expect(rpcCalls).toEqual([])
    expect(reads).toEqual([])
  })
})

describe('POST /api/access-codes: a demo caller cannot chain', () => {
  it('is refused by the application check, before any mint', async () => {
    state.profile = { is_demo: true, demo_expires_at: '2026-08-06T09:00:00.000Z' }

    const response = await POST(post())

    expect(response.status).toBe(403)
    expect((await response.json()).error).toBe('Demo workspaces cannot issue access codes.')
    expect(mints()).toEqual([])
  })

  it('is refused on the demo_expires_at signal alone, if the flag was dropped', async () => {
    state.profile = { is_demo: false, demo_expires_at: '2026-08-06T09:00:00.000Z' }
    expect((await POST(post())).status).toBe(403)
    expect(mints()).toEqual([])
  })

  it('FAILS CLOSED when the profile cannot be read', async () => {
    state.profile = null
    state.profileError = { message: 'connection reset' }
    expect((await POST(post())).status).toBe(403)
    expect(mints()).toEqual([])
  })

  it('turns the DATABASE refusal into the same clean 403', async () => {
    // The application check passed (a profile that was not a demo when we read
    // it) and mint_access_code refused with SQLSTATE 42501. A 500 here would read
    // as our bug and invite a retry.
    state.mintResults = [{ error: { code: '42501', message: 'demo profiles cannot issue access codes' } }]

    const response = await POST(post())

    expect(response.status).toBe(403)
    expect((await response.json()).error).toBe('Demo workspaces cannot issue access codes.')
  })

  it('does not retry a refusal: it is a decision, not a collision', async () => {
    state.mintResults = [
      { error: { code: '42501', message: 'demo profiles cannot issue access codes' } },
      { error: { code: '42501', message: 'demo profiles cannot issue access codes' } },
    ]
    await POST(post())
    expect(mints()).toHaveLength(1)
  })

  it('still retries a code_hash collision, which IS a collision', async () => {
    state.mintResults = [{ error: { code: '23505', message: 'duplicate key value' } }, { data: [ROW] }]
    const response = await POST(post())
    expect(response.status).toBe(201)
    expect(mints()).toHaveLength(2)
    // A fresh code each time.
    expect(mints()[0].args.p_code_hash).not.toBe(mints()[1].args.p_code_hash)
  })

  it('reports anything else as a 500, unchanged', async () => {
    state.mintResults = [{ error: { code: '08006', message: 'connection failure' } }]
    expect((await POST(post())).status).toBe(500)
  })
})

describe('POST /api/access-codes: the caps are the database’s', () => {
  it('maps the live-code cap to a 409 that names the limit', async () => {
    state.mintResults = [{ error: { code: '23514', message: 'access code limit reached: 25 live codes' } }]
    const response = await POST(post())
    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/25 live codes/)
  })

  it('maps the daily cap to its own 409', async () => {
    state.mintResults = [{ error: { code: '23514', message: 'access code limit reached: 100 codes in 24 hours' } }]
    const response = await POST(post())
    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/last day/)
  })
})

describe('POST /api/access-codes: signed out', () => {
  it('is unauthorized, and never reads a profile or mints', async () => {
    state.user = null
    expect((await POST(post())).status).toBe(401)
    expect(reads).toEqual([])
    expect(rpcCalls).toEqual([])
  })
})

describe('GET /api/access-codes: the demo allowance', () => {
  it('reports what this owner’s demos spent this month against the shared pool', async () => {
    const response = await GET()
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.demoAllowance).toEqual({ usedUsd: 1.2, capUsd: 5 })
    expect(rpcCalls.find((c) => c.fn === 'demo_allowance_state')!.args).toEqual({ p_owner_id: 'owner-1' })
  })

  it('omits it rather than reporting zero when it cannot be read', async () => {
    state.allowance = { error: { message: 'down' } }
    const body = await (await GET()).json()
    expect(body.demoAllowance).toBeNull()
    expect(body.codes).toEqual([])
  })
})
