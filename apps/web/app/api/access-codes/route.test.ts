// POST /api/access-codes — who may mint an access code.
//
// THE THING THIS ROUTE HAS TO GET RIGHT: a code is a bearer credential that
// creates a real workspace and burns real model spend. RLS scopes the table by
// `owner_user_id = auth.uid()`, which a DEMO profile satisfies for its own row —
// so nothing in the database's policies stops a visitor who was handed one
// 72-hour code from minting more of them and handing those out. Chaining like
// that turns a single invitation into an unbounded number of workspaces on the
// owner's key.
//
// It is refused twice, on purpose, and this file checks both:
//   1. here, before the insert, by reading the caller's profile (and failing
//      closed when it cannot be read);
//   2. in the database, by 20260803000003_demo_profile_lockdown.sql's
//      forbid_demo_access_code_issue() trigger, which is what still holds if a
//      profile becomes a demo between (1) and the insert, or if some future
//      caller forgets (1) entirely.
//
// The second refusal arrives as SQLSTATE 42501, and a backstop that surfaces as
// a 500 is a backstop nobody can act on: it reads as "our bug, try again", and
// the client retries. So the test that matters most here is that the database's
// "no" and the application's "no" are the SAME answer to the caller.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

interface Query {
  table: string
  op: 'select' | 'insert'
  payload?: Record<string, unknown>
}

let queries: Query[] = []

let state: {
  user: { id: string } | null
  profile: Record<string, unknown> | null
  profileError: { message: string } | null
  liveCount: number
  /** Error returned by each insert attempt, consumed in order. */
  insertErrors: Array<{ code?: string; message: string } | null>
}

const ROW = {
  id: 'code-row-1',
  label: null,
  code_prefix: 'P7QK',
  created_at: '2026-08-03T09:00:00.000Z',
  expires_at: '2026-08-06T09:00:00.000Z',
  revoked_at: null,
  first_redeemed_at: null,
  last_used_at: null,
  redemption_count: 0,
}

function chain(query: Query): Record<string, unknown> {
  const self: Record<string, unknown> = {}
  const passthrough = () => self
  Object.assign(self, {
    select: passthrough,
    eq: passthrough,
    is: passthrough,
    gt: passthrough,
    order: passthrough,
    limit: passthrough,
    maybeSingle: async () => ({ data: state.profile, error: state.profileError }),
    single: async () => {
      const error = state.insertErrors.shift() ?? null
      return { data: error ? null : ROW, error }
    },
    // The live-code count is `head: true`, so the builder is awaited directly.
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve({ data: null, count: state.liveCount, error: null }).then(res, rej),
  })
  return self
}

function record(table: string, op: Query['op'], payload?: Record<string, unknown>) {
  const query: Query = { table, op, payload }
  queries.push(query)
  return chain(query)
}

const supabase = {
  auth: { getUser: async () => ({ data: { user: state.user }, error: null }) },
  from: (table: string) => ({
    select: (...args: unknown[]) => {
      const built = record(table, 'select')
      return (built as { select: (...a: unknown[]) => unknown }).select(...args)
    },
    insert: (payload: Record<string, unknown>) => record(table, 'insert', payload),
  }),
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabase }))

import { POST } from './route'

function post(body: unknown = {}) {
  return new NextRequest('http://localhost/api/access-codes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function inserts(): Query[] {
  return queries.filter((q) => q.op === 'insert')
}

beforeEach(() => {
  queries = []
  state = {
    user: { id: 'owner-1' },
    profile: { is_demo: false, demo_expires_at: null },
    profileError: null,
    liveCount: 0,
    insertErrors: [],
  }
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('POST /api/access-codes — the owner', () => {
  it('issues a code and returns the plaintext exactly once', async () => {
    const response = await POST(post({ label: 'Acme walkthrough' }))
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(typeof body.code).toBe('string')
    expect(body.code.length).toBeGreaterThan(0)

    // Only the hash is ever persisted; the plaintext exists in this response
    // and nowhere else.
    const written = inserts()[0].payload as Record<string, unknown>
    expect(written.code_hash).not.toBe(body.code)
    expect(JSON.stringify(written)).not.toContain(body.code.replace(/-/g, ''))
  })
})

describe('POST /api/access-codes — a demo caller cannot chain', () => {
  it('is refused by the application check, before any insert', async () => {
    state.profile = { is_demo: true, demo_expires_at: '2026-08-06T09:00:00.000Z' }

    const response = await POST(post())

    expect(response.status).toBe(403)
    expect((await response.json()).error).toBe('Demo workspaces cannot issue access codes.')
    // The check is the boundary, so nothing may reach the table at all.
    expect(inserts()).toEqual([])
  })

  it('is refused on the demo_expires_at signal alone, if the flag was dropped', async () => {
    // isDemoProfile ORs the two signals: a row carrying a demo deadline is a
    // demo even if a partial update cleared the flag.
    state.profile = { is_demo: false, demo_expires_at: '2026-08-06T09:00:00.000Z' }

    expect((await POST(post())).status).toBe(403)
    expect(inserts()).toEqual([])
  })

  it('FAILS CLOSED when the profile cannot be read', async () => {
    state.profile = null
    state.profileError = { message: 'connection reset' }

    expect((await POST(post())).status).toBe(403)
    expect(inserts()).toEqual([])
  })

  it('turns the DATABASE trigger’s refusal into the same clean 403', async () => {
    // The backstop: the application check passed (a profile that was not a demo
    // when we read it) and forbid_demo_access_code_issue() refused the insert
    // with SQLSTATE 42501. A 500 here would read as our bug and invite a retry.
    state.insertErrors = [{ code: '42501', message: 'demo profiles cannot issue access codes' }]

    const response = await POST(post())

    expect(response.status).toBe(403)
    expect((await response.json()).error).toBe('Demo workspaces cannot issue access codes.')
  })

  it('does not retry a trigger refusal — it is a decision, not a collision', async () => {
    state.insertErrors = [
      { code: '42501', message: 'demo profiles cannot issue access codes' },
      { code: '42501', message: 'demo profiles cannot issue access codes' },
    ]

    await POST(post())

    expect(inserts()).toHaveLength(1)
  })

  it('still retries a code_hash collision, which IS a collision', async () => {
    // The two error paths must stay distinguishable: 23505 is bad luck and
    // deserves another draw, 42501 is a policy and deserves an answer.
    state.insertErrors = [{ code: '23505', message: 'duplicate key value' }, null]

    const response = await POST(post())

    expect(response.status).toBe(201)
    expect(inserts()).toHaveLength(2)
  })

  it('reports anything else as a 500, unchanged', async () => {
    state.insertErrors = [{ code: '08006', message: 'connection failure' }]

    expect((await POST(post())).status).toBe(500)
  })
})

describe('POST /api/access-codes — the live-code cap', () => {
  it('refuses once the owner already holds the maximum', async () => {
    state.liveCount = 25

    const response = await POST(post())

    expect(response.status).toBe(409)
    expect(inserts()).toEqual([])
  })
})

describe('POST /api/access-codes — signed out', () => {
  it('is unauthorized, and never reads a profile', async () => {
    state.user = null

    expect((await POST(post())).status).toBe(401)
    expect(queries).toEqual([])
  })
})
