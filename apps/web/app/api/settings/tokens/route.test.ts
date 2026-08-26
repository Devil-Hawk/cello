// GET/POST/DELETE /api/settings/tokens — the machine-surface credential route.
//
// THE THREE THINGS THIS FILE HAS TO PROVE (brief step 4):
//   1. A demo session cannot mint a token — refused BEFORE the write, failing
//      closed when the profile cannot even be read, same posture
//      app/api/access-codes/route.test.ts proves for demo codes.
//   2. The plaintext appears in the CREATE response and nowhere else — GET
//      never returns it, matching what lib/access/tokens.ts's createToken
//      already guarantees at the storage layer (tokens.test.ts covers that
//      half; this file covers the route's half of the same contract).
//   3. Ordinary validation (name, scopes) refuses before anything is written.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

interface State {
  user: { id: string } | null
  profile: Record<string, unknown> | null
  profileError: { message: string } | null
  rows: Array<Record<string, unknown>>
}

let state: State

function chain(): Record<string, unknown> {
  const self: Record<string, unknown> = {}
  const passthrough = () => self
  Object.assign(self, {
    select: passthrough,
    eq: passthrough,
    order: passthrough,
    maybeSingle: async () => ({ data: state.profile, error: state.profileError }),
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve({ data: state.rows, error: null }).then(res, rej),
  })
  return self
}

const supabase = {
  auth: { getUser: async () => ({ data: { user: state.user }, error: null }) },
  from: () => chain(),
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabase }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({}) }))

const createTokenMock = vi.fn()
const revokeTokenMock = vi.fn()
vi.mock('@/lib/access/tokens', () => ({
  createToken: (...args: unknown[]) => createTokenMock(...args),
  revokeToken: (...args: unknown[]) => revokeTokenMock(...args),
}))

import { DELETE, GET, POST } from './route'

function post(body: unknown) {
  return new NextRequest('http://localhost/api/settings/tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function del(id: string) {
  return new NextRequest(`http://localhost/api/settings/tokens?id=${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

beforeEach(() => {
  state = {
    user: { id: 'user-1' },
    profile: { is_demo: false, demo_expires_at: null },
    profileError: null,
    rows: [],
  }
  createTokenMock.mockReset()
  revokeTokenMock.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('POST /api/settings/tokens', () => {
  it('refuses an unauthenticated caller', async () => {
    state.user = null
    const res = await POST(post({ name: 'x', scopes: ['mcp'] }))
    expect(res.status).toBe(401)
  })

  it('refuses a demo profile before any write is attempted', async () => {
    state.profile = { is_demo: true, demo_expires_at: '2099-01-01T00:00:00.000Z' }
    const res = await POST(post({ name: 'laptop', scopes: ['mcp'] }))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toMatch(/demo/i)
    expect(createTokenMock).not.toHaveBeenCalled()
  })

  it('fails closed when the profile cannot be read — an unproven "not a demo" is not an issue', async () => {
    state.profile = null
    state.profileError = { message: 'boom' }
    const res = await POST(post({ name: 'laptop', scopes: ['mcp'] }))
    expect(res.status).toBe(403)
    expect(createTokenMock).not.toHaveBeenCalled()
  })

  it('rejects a missing name before calling createToken', async () => {
    const res = await POST(post({ name: '  ', scopes: ['mcp'] }))
    expect(res.status).toBe(400)
    expect(createTokenMock).not.toHaveBeenCalled()
  })

  it('rejects an empty or malformed scope list', async () => {
    let res = await POST(post({ name: 'laptop', scopes: [] }))
    expect(res.status).toBe(400)
    res = await POST(post({ name: 'laptop', scopes: ['Not Lowercase!'] }))
    expect(res.status).toBe(400)
    expect(createTokenMock).not.toHaveBeenCalled()
  })

  it('returns the plaintext token exactly once, in the create response', async () => {
    createTokenMock.mockResolvedValue({
      id: 'tok-1',
      name: 'laptop',
      scopes: ['mcp'],
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      createdAt: '2026-08-19T00:00:00.000Z',
      token: 'cello_pat_PLAINTEXT',
    })
    const res = await POST(post({ name: 'laptop', scopes: ['mcp'] }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.token).toBe('cello_pat_PLAINTEXT')
    // The summary echoed back must never carry the plaintext under another key.
    expect(JSON.stringify(body.summary)).not.toContain('PLAINTEXT')
    expect(body.summary.id).toBe('tok-1')
  })
})

describe('GET /api/settings/tokens', () => {
  it('never returns a plaintext token or a hash', async () => {
    state.rows = [
      {
        id: 'tok-1',
        name: 'laptop',
        scopes: ['mcp'],
        expires_at: null,
        revoked_at: null,
        last_used_at: null,
        created_at: '2026-08-19T00:00:00.000Z',
        token_hash: 'deadbeef', // present on the row if a bug ever selected it
      },
    ]
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.tokens).toHaveLength(1)
    expect(JSON.stringify(body)).not.toMatch(/token_hash|cello_pat_/)
  })

  it('refuses an unauthenticated caller', async () => {
    state.user = null
    const res = await GET()
    expect(res.status).toBe(401)
  })
})

describe('DELETE /api/settings/tokens', () => {
  it('refuses an unauthenticated caller', async () => {
    state.user = null
    const res = await DELETE(del('tok-1'))
    expect(res.status).toBe(401)
  })

  it('requires an id', async () => {
    const res = await DELETE(new NextRequest('http://localhost/api/settings/tokens', { method: 'DELETE' }))
    expect(res.status).toBe(400)
  })

  it('404s when nothing matching was revoked (wrong owner, already revoked, unknown id)', async () => {
    revokeTokenMock.mockResolvedValue(false)
    const res = await DELETE(del('tok-1'))
    expect(res.status).toBe(404)
  })

  it('revokes and answers ok', async () => {
    revokeTokenMock.mockResolvedValue(true)
    const res = await DELETE(del('tok-1'))
    expect(res.status).toBe(200)
    expect(revokeTokenMock).toHaveBeenCalledWith(expect.anything(), 'user-1', 'tok-1')
  })
})
