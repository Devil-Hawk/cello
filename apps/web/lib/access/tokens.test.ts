// Unit coverage for lib/access/tokens.ts — the machine-surface credential.
//
// The thing that actually matters here, same as codes.ts: the plaintext is
// never persisted (only its hash), expiry/revocation are evaluated at
// VALIDATION time against stored state rather than swept by a job, and every
// refusal fails closed rather than open.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  TOKEN_PREFIX,
  createToken,
  generateToken,
  hashToken,
  looksLikeToken,
  revokeToken,
  validateToken,
} from './tokens'

describe('generateToken', () => {
  it('is prefixed and drawn from the unambiguous alphabet', () => {
    const token = generateToken()
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true)
    expect(token).toMatch(/^cello_pat_[A-Z2-9]{32}$/)
    // 0/O, 1/I/L, U excluded — same alphabet as demo codes, same reason.
    expect(token.slice(TOKEN_PREFIX.length)).not.toMatch(/[OIL01U]/)
  })

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateToken()))
    expect(seen.size).toBe(500)
  })
})

describe('hashToken', () => {
  it('is stable for the same input and differs for different ones', () => {
    const a = hashToken('cello_pat_ABCD')
    expect(hashToken('cello_pat_ABCD')).toBe(a)
    expect(hashToken('cello_pat_ABCE')).not.toBe(a)
  })

  it('is a 64-char hex string (SHA-256)', () => {
    expect(hashToken('anything')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('looksLikeToken', () => {
  it('accepts a well-formed token and rejects everything else', () => {
    expect(looksLikeToken(generateToken())).toBe(true)
    expect(looksLikeToken('')).toBe(false)
    expect(looksLikeToken('cello_pat_tooshort')).toBe(false)
    expect(looksLikeToken('sk-not-ours-at-all')).toBe(false)
    expect(looksLikeToken('cello_pat_' + 'I'.repeat(32))).toBe(false) // ambiguous chars
  })
})

// --- A fake AdminClient, just enough of the query builder surface tokens.ts
// uses, mirroring the chain() shape app/api/access-codes/route.test.ts uses
// for the same reason: no real Supabase client in a unit test run. ---

interface FakeRow {
  id: string
  user_id: string
  name: string
  scopes: string[]
  token_hash: string
  expires_at: string | null
  revoked_at: string | null
  last_used_at: string | null
  created_at: string
}

let rows: FakeRow[]
let insertedPayloads: Record<string, unknown>[]

/** FakeRow has no index signature (its keys are specific columns), so a
 *  dynamic `row[col]` lookup — needed because the mock's `.eq(col, value)`
 *  takes the column name as a runtime string — goes through `unknown` first. */
function field(row: FakeRow, col: string): unknown {
  return (row as unknown as Record<string, unknown>)[col]
}

function makeAdmin() {
  return {
    from: (table: string) => {
      expect(table).toBe('api_tokens')
      return {
        insert: (payload: Record<string, unknown>) => {
          insertedPayloads.push(payload)
          const row: FakeRow = {
            id: `row-${rows.length + 1}`,
            user_id: payload.user_id as string,
            name: payload.name as string,
            scopes: payload.scopes as string[],
            token_hash: payload.token_hash as string,
            expires_at: (payload.expires_at as string | null) ?? null,
            revoked_at: null,
            last_used_at: null,
            created_at: '2026-08-19T00:00:00.000Z',
          }
          rows.push(row)
          return {
            select: () => ({
              single: async () => ({ data: row, error: null }),
            }),
          }
        },
        select: () => ({
          eq: (col: string, value: string) => ({
            maybeSingle: async () => {
              const row = rows.find((r) => field(r, col) === value) ?? null
              return { data: row, error: null }
            },
            eq: (col2: string, value2: string) => ({
              is: (col3: string, _val: null) => ({
                select: () => ({
                  maybeSingle: async () => {
                    const row = rows.find(
                      (r) =>
                        field(r, col) === value &&
                        field(r, col2) === value2 &&
                        field(r, col3) === null
                    )
                    return { data: row ? { id: row.id } : null, error: null }
                  },
                }),
              }),
            }),
          }),
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: (col: string, value: string) => ({
            eq: (col2: string, value2: string) => ({
              is: (col3: string, _val: null) => ({
                select: () => ({
                  maybeSingle: async () => {
                    const row = rows.find(
                      (r) =>
                        field(r, col) === value &&
                        field(r, col2) === value2 &&
                        field(r, col3) === null
                    )
                    if (row) Object.assign(row, patch)
                    return { data: row ? { id: row.id } : null, error: null }
                  },
                }),
              }),
            }),
            // touchLastUsed's shape: .update(...).eq('id', id)
            then: (res: (v: unknown) => unknown) => {
              const row = rows.find((r) => field(r, col) === value)
              if (row) Object.assign(row, patch)
              return Promise.resolve({ error: null }).then(res)
            },
          }),
        }),
      }
    },
  } as unknown as Parameters<typeof createToken>[0]
}

beforeEach(() => {
  rows = []
  insertedPayloads = []
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('createToken', () => {
  it('never sends the plaintext to the store — only its hash', async () => {
    const admin = makeAdmin()
    const issued = await createToken(admin, { userId: 'u1', name: 'laptop', scopes: ['mcp'] })

    expect(insertedPayloads).toHaveLength(1)
    const payload = insertedPayloads[0]
    expect(payload.token_hash).toBe(hashToken(issued.token))
    // Grep assertion: the raw payload sent to the database must not contain
    // the plaintext anywhere — not under `token`, not embedded in another
    // field.
    expect(JSON.stringify(payload)).not.toContain(issued.token)
  })

  it('returns the plaintext exactly once, in the create response', async () => {
    const admin = makeAdmin()
    const issued = await createToken(admin, { userId: 'u1', name: 'laptop', scopes: ['mcp'] })
    expect(issued.token.startsWith(TOKEN_PREFIX)).toBe(true)
    expect(issued.name).toBe('laptop')
    expect(issued.scopes).toEqual(['mcp'])
  })
})

describe('validateToken', () => {
  it('accepts a live token and returns its owner + scopes', async () => {
    const admin = makeAdmin()
    const issued = await createToken(admin, { userId: 'u1', name: 'laptop', scopes: ['mcp', 'a2a'] })

    const result = await validateToken(admin, issued.token)
    expect(result).toEqual({ ok: true, userId: 'u1', scopes: ['mcp', 'a2a'] })
  })

  it('refuses a garbage bearer without touching the database', async () => {
    const admin = makeAdmin()
    const result = await validateToken(admin, 'not-a-token-at-all')
    expect(result).toEqual({ ok: false, reason: 'unknown' })
  })

  it('refuses an unrecognized (well-formed but unknown) token', async () => {
    const admin = makeAdmin()
    const result = await validateToken(admin, generateToken())
    expect(result).toEqual({ ok: false, reason: 'unknown' })
  })

  it('refuses a revoked token, distinguishing it from unknown', async () => {
    const admin = makeAdmin()
    const issued = await createToken(admin, { userId: 'u1', name: 'laptop', scopes: ['mcp'] })
    const revoked = await revokeToken(admin, 'u1', issued.id)
    expect(revoked).toBe(true)

    const result = await validateToken(admin, issued.token)
    expect(result).toEqual({ ok: false, reason: 'revoked' })
  })

  it('refuses an expired token — every comparison against a lapsed timestamp fails closed', async () => {
    const admin = makeAdmin()
    const issued = await createToken(admin, {
      userId: 'u1',
      name: 'laptop',
      scopes: ['mcp'],
      expiresAt: new Date(Date.now() - 1000),
    })
    const result = await validateToken(admin, issued.token)
    expect(result).toEqual({ ok: false, reason: 'expired' })
  })

  it('accepts a token with a future expiry', async () => {
    const admin = makeAdmin()
    const issued = await createToken(admin, {
      userId: 'u1',
      name: 'laptop',
      scopes: ['mcp'],
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    })
    const result = await validateToken(admin, issued.token)
    expect(result.ok).toBe(true)
  })
})

describe('revokeToken', () => {
  it('is scoped to the owner — another user cannot revoke your token', async () => {
    const admin = makeAdmin()
    const issued = await createToken(admin, { userId: 'u1', name: 'laptop', scopes: ['mcp'] })
    const revoked = await revokeToken(admin, 'someone-else', issued.id)
    expect(revoked).toBe(false)

    const result = await validateToken(admin, issued.token)
    expect(result.ok).toBe(true) // untouched
  })

  it('is idempotent-safe: revoking twice returns false the second time', async () => {
    const admin = makeAdmin()
    const issued = await createToken(admin, { userId: 'u1', name: 'laptop', scopes: ['mcp'] })
    expect(await revokeToken(admin, 'u1', issued.id)).toBe(true)
    expect(await revokeToken(admin, 'u1', issued.id)).toBe(false)
  })
})
