// The HTTP surface of the credential vault.
//
// lib/apply/vault.test.ts proves the module cannot return secret material.
// This file proves the ROUTES cannot either — because that is where a password
// would actually reach a browser, and because the two failure modes that matter
// here are HTTP-shaped rather than module-shaped:
//
//   * a response body, or a response HEADER, carrying the secret back out;
//   * a deployment that cannot encrypt answering "created" instead of refusing,
//     which would leave the user believing a password was safely stored.
//
// Every response produced by every test is collected and scanned at the end, so
// a new route that leaks on a path nobody wrote a test for still fails here.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// vi.hoisted runs BEFORE the imports below, which is the only way to have
// API_ENCRYPTION_KEY in place before lib/crypto.ts snapshots its key at import
// time. Setting it in beforeEach would be too late and every test would run
// against the browser-derivable fallback.
const { STRONG_KEY, ORIGINAL_KEY, ORIGINAL_URL } = vi.hoisted(() => {
  const originalKey = process.env.API_ENCRYPTION_KEY
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = 'b'.repeat(64)
  process.env.API_ENCRYPTION_KEY = key
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example-project.supabase.co'
  return { STRONG_KEY: key, ORIGINAL_KEY: originalKey, ORIGINAL_URL: originalUrl }
})

/** An obvious placeholder, never a real credential. */
const SECRET = 'PLACEHOLDER-not-a-real-password-77'

interface Row {
  id: string
  user_id: string
  host: string
  provider: string | null
  label: string
  username: string
  encrypted_secret: string
  created_at: string
  updated_at: string
  last_used_at: string | null
}

let rows: Row[]
let user: { id: string } | null
let profile: Record<string, unknown> | null
let nextId: number

/** Everything this file ever sent to a client, for the sweep at the end. */
const responses: string[] = []

function makeClient() {
  function build(table: string, op: 'select' | 'upsert' | 'delete', payload?: Record<string, unknown>) {
    const filters: Array<[string, unknown]> = []
    const matches = () =>
      rows.filter((row) =>
        filters.every(([col, value]) => (row as unknown as Record<string, unknown>)[col] === value)
      )

    function result(): { data: unknown; error: null } {
      if (table === 'profiles') return { data: profile, error: null }
      if (op === 'upsert') {
        const next = payload as unknown as Omit<Row, 'id' | 'created_at' | 'updated_at' | 'last_used_at'>
        const now = new Date().toISOString()
        const created: Row = {
          id: `0000000${nextId++}-0000-4000-8000-000000000000`.slice(-36),
          created_at: now,
          updated_at: now,
          last_used_at: null,
          ...next,
        }
        rows.push(created)
        return { data: created, error: null }
      }
      if (op === 'delete') {
        const removed = matches()
        rows = rows.filter((row) => !removed.includes(row))
        return { data: removed.map((row) => ({ id: row.id })), error: null }
      }
      return { data: matches(), error: null }
    }

    const self: Record<string, unknown> = {}
    Object.assign(self, {
      select: () => self,
      eq: (col: string, value: unknown) => {
        filters.push([col, value])
        return self
      },
      order: () => self,
      limit: () => self,
      single: async () => {
        const { data, error } = result()
        return { data: Array.isArray(data) ? (data[0] ?? null) : data, error }
      },
      maybeSingle: async () => {
        const { data, error } = result()
        return { data: Array.isArray(data) ? (data[0] ?? null) : data, error }
      },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject),
    })
    return self
  }

  return {
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    from: (table: string) => ({
      select: () => build(table, 'select'),
      upsert: (payload: Record<string, unknown>) => build(table, 'upsert', payload),
      delete: () => build(table, 'delete'),
    }),
  }
}

const supabase = makeClient()
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabase }))

import { GET, POST } from './route'
import { DELETE } from './[id]/route'

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/apply-credentials', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function deleteRequest() {
  return new NextRequest('http://localhost/api/apply-credentials/x', { method: 'DELETE' })
}

/** Read a response AND bank its full text (body + headers) for the final sweep. */
async function read(response: Response): Promise<Record<string, unknown>> {
  const text = await response.clone().text()
  responses.push(text)
  responses.push(JSON.stringify(Object.fromEntries(response.headers.entries())))
  return (await response.json().catch(() => ({}))) as Record<string, unknown>
}

const VALID = {
  host: 'https://acme.wd5.myworkdayjobs.com/en-US/careers',
  label: 'Acme careers',
  username: 'student@example.edu',
  secret: SECRET,
}

beforeEach(() => {
  rows = []
  nextId = 1
  user = { id: 'owner-1' }
  profile = { id: 'owner-1', is_demo: false, demo_expires_at: null }
  process.env.API_ENCRYPTION_KEY = STRONG_KEY
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterAll(() => {
  // Vitest reuses a worker across test FILES, so process.env is shared with
  // whatever runs next. Put it back before asserting anything, or a failure
  // here would also leave the environment rewritten for someone else's suite.
  if (ORIGINAL_KEY === undefined) delete process.env.API_ENCRYPTION_KEY
  else process.env.API_ENCRYPTION_KEY = ORIGINAL_KEY
  if (ORIGINAL_URL === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
  else process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGINAL_URL

  // The sweep. Covers every response body and header this file produced,
  // including the ones no assertion looked at directly.
  expect(responses.length).toBeGreaterThan(0)
  for (const text of responses) {
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain(STRONG_KEY)
  }
})

describe('POST /api/apply-credentials', () => {
  it('stores the password and returns a summary with no secret in it', async () => {
    const response = await POST(postRequest(VALID))
    expect(response.status).toBe(201)

    const payload = await read(response)
    const credential = payload.credential as Record<string, unknown>
    expect(credential.host).toBe('acme.wd5.myworkdayjobs.com')
    expect(credential.username).toBe('student@example.edu')
    expect('secret' in credential).toBe(false)
    expect('encrypted_secret' in credential).toBe(false)

    // What actually landed in the column is ciphertext, not the password.
    expect(rows).toHaveLength(1)
    expect(rows[0].encrypted_secret).not.toContain(SECRET)

    // Nothing on this surface may be cached: bodies describe which employers
    // this person holds accounts with.
    expect(response.headers.get('Cache-Control')).toContain('no-store')
  })

  it('refuses with 503 — and stores nothing — when the deployment cannot encrypt', async () => {
    // THE CASE THIS WHOLE FEATURE TURNS ON. lib/crypto.ts would happily
    // "encrypt" here using a key derived from NEXT_PUBLIC_SUPABASE_URL, which
    // ships to every browser. A 201 in this state is the worst possible answer:
    // the user is told their password is stored safely when it is not.
    delete process.env.API_ENCRYPTION_KEY

    const response = await POST(postRequest(VALID))
    expect(response.status).toBe(503)

    const payload = await read(response)
    expect(payload.code).toBe('encryption-unavailable')
    expect(String(payload.error)).toContain('API_ENCRYPTION_KEY')
    expect(rows).toHaveLength(0)
  })

  it('refuses a demo workspace', async () => {
    profile = { id: 'owner-1', is_demo: true, demo_expires_at: '2999-01-01T00:00:00.000Z' }
    const response = await POST(postRequest(VALID))
    expect(response.status).toBe(403)
    expect((await read(response)).code).toBe('demo-forbidden')
    expect(rows).toHaveLength(0)
  })

  it('rejects an unusable board address without echoing the password back', async () => {
    const response = await POST(postRequest({ ...VALID, host: 'nope' }))
    expect(response.status).toBe(400)
    const payload = await read(response)
    expect(String(payload.error)).not.toContain(SECRET)
    expect(rows).toHaveLength(0)
  })

  it('requires a session', async () => {
    user = null
    const response = await POST(postRequest(VALID))
    expect(response.status).toBe(401)
    await read(response)
    expect(rows).toHaveLength(0)
  })

  it('rejects a body that is not JSON', async () => {
    const request = new NextRequest('http://localhost/api/apply-credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    const response = await POST(request)
    expect(response.status).toBe(400)
    await read(response)
  })
})

describe('GET /api/apply-credentials', () => {
  it('lists sign-ins with no secret material and reports encryption readiness', async () => {
    await read(await POST(postRequest(VALID)))

    const response = await GET()
    expect(response.status).toBe(200)
    const payload = await read(response)

    const credentials = payload.credentials as Array<Record<string, unknown>>
    expect(credentials).toHaveLength(1)
    expect('secret' in credentials[0]).toBe(false)
    expect('encrypted_secret' in credentials[0]).toBe(false)
    // Not even the ciphertext leaves the server — a browser has no use for it,
    // and an offline target is an offline target.
    expect(JSON.stringify(payload)).not.toContain(rows[0].encrypted_secret)

    expect(payload.encryption).toEqual({ ready: true })
    expect(response.headers.get('Cache-Control')).toContain('no-store')
  })

  it('tells the card encryption is unavailable, so the form can refuse before anyone types', async () => {
    delete process.env.API_ENCRYPTION_KEY
    const payload = await read(await GET())
    expect(payload.encryption).toMatchObject({ ready: false, reason: 'missing-key' })
    expect(String((payload.encryption as Record<string, unknown>).message)).toContain(
      'API_ENCRYPTION_KEY'
    )
  })

  it('requires a session', async () => {
    user = null
    const response = await GET()
    expect(response.status).toBe(401)
    await read(response)
  })
})

describe('DELETE /api/apply-credentials/:id', () => {
  it('removes a stored sign-in', async () => {
    const created = await read(await POST(postRequest(VALID)))
    const id = (created.credential as Record<string, unknown>).id as string

    const response = await DELETE(deleteRequest(), { params: { id } })
    expect(response.status).toBe(200)
    await read(response)
    expect(rows).toHaveLength(0)
  })

  it('answers 404 for an unknown id and for a malformed one alike', async () => {
    const unknown = await DELETE(deleteRequest(), {
      params: { id: '00000099-0000-4000-8000-000000000000' },
    })
    expect(unknown.status).toBe(404)
    await read(unknown)

    // A malformed id must not become a 500 from a failed uuid cast — and the
    // answer must be identical, so this route never confirms an id exists.
    const malformed = await DELETE(deleteRequest(), { params: { id: 'not-a-uuid' } })
    expect(malformed.status).toBe(404)
    await read(malformed)
  })

  it('works even when the deployment can no longer encrypt', async () => {
    // Deleting is the only way a password leaves this system. A missing key is
    // exactly when someone most wants to empty the vault, so it must not be a
    // trap.
    const created = await read(await POST(postRequest(VALID)))
    const id = (created.credential as Record<string, unknown>).id as string

    delete process.env.API_ENCRYPTION_KEY
    const response = await DELETE(deleteRequest(), { params: { id } })
    expect(response.status).toBe(200)
    await read(response)
    expect(rows).toHaveLength(0)
  })
})
