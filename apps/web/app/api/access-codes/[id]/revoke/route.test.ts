// POST /api/access-codes/:id/revoke — revoking must end sessions already minted.
//
// Revoking used to set access_codes.revoked_at and nothing else, so a demo that
// had already redeemed kept working (and spending the owner's key) until its 72
// hours ran out. The route now also pulls profiles.demo_expires_at to now() for
// the code's demo user, through the service role. What this file pins:
//   * the demo id comes from the DATABASE row, never the request;
//   * only a profile with is_demo = true can be touched;
//   * an unredeemed code touches no profile;
//   * the already-revoked branch does it too, so a retry finishes the job;
//   * a failed cutoff is a 500, not a silent success.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const OWNER = '11111111-1111-4111-8111-111111111111'
const CODE = '22222222-2222-4222-8222-222222222222'
const DEMO = '33333333-3333-4333-8333-333333333333'

interface Row {
  id: string
  owner_user_id: string
  demo_user_id: string | null
  revoked_at: string | null
  [k: string]: unknown
}

let rows: Row[]
let user: { id: string } | null
let adminError: { message: string } | null
let adminCalls: Array<{ table: string; patch: Record<string, unknown>; filters: Array<[string, unknown]> }>

function ownerQuery(table: string) {
  const filters: Array<[string, unknown, 'eq' | 'is']> = []
  let patch: Record<string, unknown> | null = null
  const matching = () =>
    rows.filter((r) =>
      filters.every(([col, val, kind]) => (kind === 'is' ? (r[col] ?? null) === val : r[col] === val))
    )
  const builder: Record<string, unknown> = {
    update(p: Record<string, unknown>) {
      patch = p
      return builder
    },
    select() {
      return builder
    },
    eq(col: string, val: unknown) {
      filters.push([col, val, 'eq'])
      return builder
    },
    is(col: string, val: unknown) {
      filters.push([col, val, 'is'])
      return builder
    },
    async maybeSingle() {
      expect(table).toBe('access_codes')
      const hit = matching()[0]
      if (!hit) return { data: null, error: null }
      if (patch) Object.assign(hit, patch)
      return { data: { ...hit }, error: null }
    },
  }
  return builder
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    from: (table: string) => ownerQuery(table),
  }),
}))

vi.mock('@/lib/harness/supabase-admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      update: (patch: Record<string, unknown>) => {
        const call = { table, patch, filters: [] as Array<[string, unknown]> }
        adminCalls.push(call)
        const b = {
          eq(col: string, val: unknown) {
            call.filters.push([col, val])
            return call.filters.length < 2 ? b : Promise.resolve({ error: adminError })
          },
        }
        return b
      },
    }),
  }),
}))

import { POST } from './route'

function post(id: string = CODE) {
  return POST(new NextRequest(`http://localhost/api/access-codes/${id}/revoke`, { method: 'POST' }), {
    params: { id },
  })
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: CODE,
    owner_user_id: OWNER,
    demo_user_id: DEMO,
    revoked_at: null,
    label: null,
    code_prefix: 'P7QK',
    created_at: '2026-10-01T00:00:00.000Z',
    expires_at: '2026-10-04T00:00:00.000Z',
    first_redeemed_at: null,
    last_used_at: null,
    redemption_count: 0,
    ...over,
  }
}

beforeEach(() => {
  rows = [row()]
  user = { id: OWNER }
  adminError = null
  adminCalls = []
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('POST /api/access-codes/:id/revoke', () => {
  it('ends the already-minted demo session by pulling demo_expires_at to now', async () => {
    const before = Date.now()
    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json()).alreadyRevoked).toBe(false)

    expect(adminCalls).toHaveLength(1)
    const call = adminCalls[0]
    expect(call.table).toBe('profiles')
    const stamped = Date.parse(call.patch.demo_expires_at as string)
    expect(stamped).toBeGreaterThanOrEqual(before - 1000)
    expect(stamped).toBeLessThanOrEqual(Date.now() + 1000)
    // Only the deadline moves; the demo workspace and its audit trail stay.
    expect(Object.keys(call.patch)).toEqual(['demo_expires_at'])
  })

  it('targets the demo id stored on the row and only a demo profile', async () => {
    await post()
    const filters = Object.fromEntries(adminCalls[0].filters)
    expect(filters.id).toBe(DEMO)
    expect(filters.is_demo).toBe(true)
  })

  it('an unredeemed code touches no profile', async () => {
    rows = [row({ demo_user_id: null })]
    const res = await post()
    expect(res.status).toBe(200)
    expect(adminCalls).toHaveLength(0)
  })

  it('the already-revoked branch ends the session too, without moving revoked_at', async () => {
    rows = [row({ revoked_at: '2026-10-02T00:00:00.000Z' })]
    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json()).alreadyRevoked).toBe(true)
    expect(rows[0].revoked_at).toBe('2026-10-02T00:00:00.000Z')
    expect(adminCalls).toHaveLength(1)
    expect(Object.fromEntries(adminCalls[0].filters).id).toBe(DEMO)
  })

  it("another owner's code is a 404 and never reaches the admin client", async () => {
    rows = [row({ owner_user_id: '44444444-4444-4444-8444-444444444444' })]
    const res = await post()
    expect(res.status).toBe(404)
    expect(adminCalls).toHaveLength(0)
  })

  it('a malformed id is a 404 and never reaches the admin client', async () => {
    const res = await post('not-a-uuid')
    expect(res.status).toBe(404)
    expect(adminCalls).toHaveLength(0)
  })

  it('signed out is a 401 and never reaches the admin client', async () => {
    user = null
    const res = await post()
    expect(res.status).toBe(401)
    expect(adminCalls).toHaveLength(0)
  })

  it('a failed cutoff is a 500 so the owner retries, and the retry finishes the job', async () => {
    adminError = { message: 'boom' }
    const first = await post()
    expect(first.status).toBe(500)
    // revoked_at is already set, so the retry takes the already-revoked branch.
    expect(rows[0].revoked_at).not.toBeNull()

    adminError = null
    const retry = await post()
    expect(retry.status).toBe(200)
    expect((await retry.json()).alreadyRevoked).toBe(true)
    expect(adminCalls).toHaveLength(2)
  })
})
