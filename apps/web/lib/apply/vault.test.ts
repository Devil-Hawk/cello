// What this file is actually testing.
//
// The vault stores something in a different risk class from everything else in
// this codebase: a person's real board password, frequently reused, effectively
// unrotatable. Five properties have to hold, and each is checked here against
// the real lib/crypto.ts rather than a mock of it — a mocked cipher would make
// every one of these tests pass while the product stored plaintext.
//
//   1. A round trip works: what goes in comes back out, and what lands in the
//      column is genuine ciphertext of the shape the migration's CHECK will
//      accept.
//   2. NO LISTING PATH RETURNS SECRET MATERIAL — not through the summary type,
//      not through a column list, not through a row that happens to carry extra
//      fields.
//   3. A MISSING (OR FAKE) API_ENCRYPTION_KEY REFUSES THE WRITE. lib/crypto.ts
//      silently falls back to a key derived from NEXT_PUBLIC_SUPABASE_URL — a
//      value every browser already has — so a write in that state stores a
//      password in the clear with extra steps. This is the one that matters
//      most, and it is tested three ways: unset, too weak, and the nastiest
//      case, where the variable is set but the process loaded crypto.ts before
//      it existed and is therefore still using the fallback key.
//   4. A demo workspace is refused on every path, and refused before it can
//      touch the table at all.
//   5. NO ERROR PATH — thrown message, serialised error, or log line — CONTAINS
//      THE SECRET. Checked globally: every console call made during the whole
//      file is captured and scanned at the end.
//
// The secret used throughout is an obvious placeholder and is never a real
// credential.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// An obvious placeholder. Deliberately contains characters that survive a
// naive "did this string appear anywhere" scan, and leading/trailing spaces so
// the no-trim rule is exercised.
const SECRET = ' PLACEHOLDER-not-a-real-password-42 '

/** A 64-char hex key — the strong form lib/crypto.ts decodes directly. */
const STRONG_KEY = 'a'.repeat(64)
/** Long enough to pass the length floor, not hex, so it is scrypt-derived. */
const STRONG_PASSPHRASE = 'correct-horse-battery-staple-xyzzy'
const PUBLIC_SUPABASE_URL = 'https://example-project.supabase.co'

/**
 * The CHECK constraint from 20260803000004_apply_credentials.sql, verbatim.
 *
 * Copied so a change to lib/crypto.ts's output shape fails here — in a test
 * naming the reason — instead of at 3am as a Postgres constraint violation on
 * a user trying to save their password.
 */
const CIPHERTEXT_SHAPE = /^[A-Za-z0-9+/]{22}==:[A-Za-z0-9+/]{22}==:[A-Za-z0-9+/=]{4,}$/

// ---------------------------------------------------------------------------
// Everything the process said out loud, for property (5)
// ---------------------------------------------------------------------------

const spoken: string[] = []

function captureConsole() {
  for (const level of ['error', 'warn', 'log', 'info', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      spoken.push(args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' '))
    })
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

// ---------------------------------------------------------------------------
// A fake PostgREST, just deep enough
// ---------------------------------------------------------------------------

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

interface DbError {
  code?: string
  message?: string
  details?: string
  hint?: string
}

interface Issued {
  table: string
  op: 'select' | 'upsert' | 'update' | 'delete'
  columns: string
  payload?: Record<string, unknown>
}

let rows: Row[]
let issued: Issued[]
let profile: Record<string, unknown> | null
let profileError: DbError | null
let failures: Partial<Record<Issued['op'], DbError | null>>
let nextId: number

function resetDb() {
  rows = []
  issued = []
  profile = { id: 'owner-1', is_demo: false, demo_expires_at: null }
  profileError = null
  failures = {}
  nextId = 1
}

function uuid(): string {
  return `0000000${nextId++}-0000-4000-8000-000000000000`.slice(-36).padStart(36, '0')
}

function makeClient() {
  function from(table: string) {
    return {
      select: (columns: string) => build(table, 'select', columns),
      upsert: (payload: Record<string, unknown>) => build(table, 'upsert', '', payload),
      update: (payload: Record<string, unknown>) => build(table, 'update', '', payload),
      delete: () => build(table, 'delete', ''),
    }
  }

  function build(table: string, op: Issued['op'], columns: string, payload?: Record<string, unknown>) {
    const entry: Issued = { table, op, columns, payload }
    issued.push(entry)
    const filters: Array<[string, unknown]> = []

    const matches = () =>
      rows.filter((row) => filters.every(([col, value]) => (row as unknown as Record<string, unknown>)[col] === value))

    function result(): { data: unknown; error: DbError | null } {
      // The profile read has its own failure switch (profileError). `failures`
      // is scoped to apply_credentials so a test can break the credential query
      // WITHOUT also breaking the demo check that runs before it — otherwise
      // every storage failure would be masked by a 'profile-unavailable'.
      if (table === 'profiles') return { data: profile, error: profileError }

      const failure = failures[op] ?? null
      if (failure) return { data: null, error: failure }

      switch (op) {
        case 'select':
          return { data: matches(), error: null }
        case 'upsert': {
          const next = payload as unknown as Omit<Row, 'id' | 'created_at' | 'updated_at' | 'last_used_at'>
          const now = new Date().toISOString()
          const existing = rows.find(
            (row) =>
              row.user_id === next.user_id && row.host === next.host && row.username === next.username
          )
          if (existing) {
            Object.assign(existing, next, { updated_at: now })
            return { data: existing, error: null }
          }
          const created: Row = {
            id: uuid(),
            created_at: now,
            updated_at: now,
            last_used_at: null,
            ...next,
          }
          rows.push(created)
          return { data: created, error: null }
        }
        case 'update': {
          const touched = matches()
          for (const row of touched) Object.assign(row, payload)
          return { data: touched, error: null }
        }
        case 'delete': {
          const removed = matches()
          rows = rows.filter((row) => !removed.includes(row))
          return { data: removed.map((row) => ({ id: row.id })), error: null }
        }
      }
    }

    const self: Record<string, unknown> = {}
    Object.assign(self, {
      select: (columns_: string) => {
        entry.columns = entry.columns || columns_
        return self
      },
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

  return { from } as unknown as import('./vault').VaultClient
}

// ---------------------------------------------------------------------------
// Loading the module under a chosen environment
// ---------------------------------------------------------------------------

type Vault = typeof import('./vault')

/**
 * lib/crypto.ts SNAPSHOTS its key at import time, which is the entire reason
 * property (3) is subtle. Every scenario therefore sets the environment, resets
 * the module registry, and imports fresh — `loadedAfter` exists so one test can
 * reproduce the genuinely dangerous ordering: crypto.ts imported with no key,
 * the variable appearing afterwards.
 */
async function loadVault(options: { key?: string; loadedAfter?: string } = {}): Promise<Vault> {
  vi.resetModules()
  process.env.NEXT_PUBLIC_SUPABASE_URL = PUBLIC_SUPABASE_URL
  if (options.key === undefined) delete process.env.API_ENCRYPTION_KEY
  else process.env.API_ENCRYPTION_KEY = options.key

  const vault = await import('./vault')

  if (options.loadedAfter !== undefined) process.env.API_ENCRYPTION_KEY = options.loadedAfter
  return vault
}

const OWNER = 'owner-1'

function input(overrides: Partial<import('./vault').SaveCredentialInput> = {}) {
  return {
    host: 'https://acme.wd5.myworkdayjobs.com/en-US/careers',
    label: 'Acme careers',
    provider: 'workday',
    username: 'student@example.edu',
    secret: SECRET,
    ...overrides,
  }
}

const originalKey = process.env.API_ENCRYPTION_KEY
const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL

beforeEach(() => {
  resetDb()
  captureConsole()
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(() => {
  if (originalKey === undefined) delete process.env.API_ENCRYPTION_KEY
  else process.env.API_ENCRYPTION_KEY = originalKey
  if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
  else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl
})

// ---------------------------------------------------------------------------
// (1) Round trip, and what actually lands in the column
// ---------------------------------------------------------------------------

describe('round trip', () => {
  it('stores ciphertext and returns the exact secret to the resolve path', async () => {
    const vault = await loadVault({ key: STRONG_KEY })
    const client = makeClient()

    const saved = await vault.saveCredential(client, OWNER, input())
    expect(saved.host).toBe('acme.wd5.myworkdayjobs.com')
    expect(saved.username).toBe('student@example.edu')

    const stored = rows[0].encrypted_secret
    expect(stored).not.toBe(SECRET)
    expect(stored).not.toContain(SECRET.trim())
    // The migration's CHECK constraint would accept this.
    expect(stored).toMatch(CIPHERTEXT_SHAPE)

    const resolved = await vault.resolveCredentialFor(client, OWNER, 'acme.wd5.myworkdayjobs.com')
    // Byte-identical, INCLUDING the leading and trailing spaces: trimming a
    // password produces a credential that silently fails to sign in.
    expect(resolved?.secret).toBe(SECRET)
  })

  it('works with a scrypt-derived passphrase as well as a hex key', async () => {
    const vault = await loadVault({ key: STRONG_PASSPHRASE })
    const client = makeClient()
    await vault.saveCredential(client, OWNER, input())
    const resolved = await vault.resolveCredentialFor(client, OWNER, 'acme.wd5.myworkdayjobs.com')
    expect(resolved?.secret).toBe(SECRET)
  })

  it('re-saving the same account replaces the row rather than adding a second copy', async () => {
    const vault = await loadVault({ key: STRONG_KEY })
    const client = makeClient()
    await vault.saveCredential(client, OWNER, input())
    await vault.saveCredential(client, OWNER, input({ secret: 'PLACEHOLDER-rotated-99' }))

    expect(rows).toHaveLength(1)
    const resolved = await vault.resolveCredentialFor(client, OWNER, 'acme.wd5.myworkdayjobs.com')
    expect(resolved?.secret).toBe('PLACEHOLDER-rotated-99')
  })

  it('stamps last-used when the secret is handed out', async () => {
    const vault = await loadVault({ key: STRONG_KEY })
    const client = makeClient()
    await vault.saveCredential(client, OWNER, input())
    expect(rows[0].last_used_at).toBeNull()

    await vault.resolveCredentialFor(client, OWNER, 'acme.wd5.myworkdayjobs.com')
    expect(rows[0].last_used_at).not.toBeNull()

    // ...and a dry run does not.
    rows[0].last_used_at = null
    await vault.resolveCredentialFor(client, OWNER, 'acme.wd5.myworkdayjobs.com', { markUsed: false })
    expect(rows[0].last_used_at).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// (2) Nothing that lists can leak a secret
// ---------------------------------------------------------------------------

describe('listing never returns secret material', () => {
  it('omits the ciphertext column from the query and the secret from the result', async () => {
    const vault = await loadVault({ key: STRONG_KEY })
    const client = makeClient()
    await vault.saveCredential(client, OWNER, input())

    expect(vault.CREDENTIAL_SUMMARY_COLUMNS).not.toContain('encrypted_secret')
    expect(vault.CREDENTIAL_SUMMARY_COLUMNS).not.toContain('secret')

    issued.length = 0
    const listed = await vault.listCredentials(client, OWNER)

    const selects = issued.filter((q) => q.table === 'apply_credentials' && q.op === 'select')
    expect(selects).toHaveLength(1)
    expect(selects[0].columns).not.toContain('encrypted_secret')

    expect(listed).toHaveLength(1)
    expect(Object.keys(listed[0]).sort()).toEqual([
      'createdAt',
      'host',
      'id',
      'label',
      'lastUsedAt',
      'provider',
      'updatedAt',
      'username',
    ])
    expect(JSON.stringify(listed)).not.toContain(SECRET.trim())
    expect(JSON.stringify(listed)).not.toContain(rows[0].encrypted_secret)
  })

  it('drops secret-bearing fields even when the row carries them', async () => {
    // The row a widened SELECT (or a future column) would produce. toSummary
    // copies field by field precisely so this cannot ride along.
    const vault = await loadVault({ key: STRONG_KEY })
    const client = makeClient()
    await vault.saveCredential(client, OWNER, input())
    ;(rows[0] as unknown as Record<string, unknown>).secret = SECRET

    const listed = await vault.listCredentials(client, OWNER)
    expect(JSON.stringify(listed)).not.toContain(SECRET.trim())
    expect('secret' in listed[0]).toBe(false)
    expect('encrypted_secret' in listed[0]).toBe(false)
  })

  it('never returns the ciphertext from the save response either', async () => {
    const vault = await loadVault({ key: STRONG_KEY })
    const client = makeClient()
    const saved = await vault.saveCredential(client, OWNER, input())
    expect(JSON.stringify(saved)).not.toContain(SECRET.trim())
    expect(JSON.stringify(saved)).not.toContain(rows[0].encrypted_secret)
  })
})

// ---------------------------------------------------------------------------
// (3) Encryption that is not real refuses the write
// ---------------------------------------------------------------------------

describe('refusing to store when encryption is not real', () => {
  it('refuses, and writes nothing, when API_ENCRYPTION_KEY is unset', async () => {
    const vault = await loadVault()
    const client = makeClient()

    expect(vault.encryptionStatus()).toMatchObject({ ready: false, reason: 'missing-key' })

    await expect(vault.saveCredential(client, OWNER, input())).rejects.toMatchObject({
      code: 'encryption-unavailable',
    })

    // The refusal is FIRST: nothing was written, and the table was not even
    // consulted. A weak write is not merely avoided, it is unreachable.
    expect(rows).toHaveLength(0)
    expect(issued.filter((q) => q.table === 'apply_credentials')).toHaveLength(0)

    // And the message tells the operator what to actually do.
    await expect(vault.saveCredential(client, OWNER, input())).rejects.toThrow(/API_ENCRYPTION_KEY/)
  })

  it('refuses a key too short to be a key', async () => {
    const vault = await loadVault({ key: 'devkey' })
    expect(vault.encryptionStatus()).toMatchObject({ ready: false, reason: 'weak-key' })
    await expect(vault.saveCredential(makeClient(), OWNER, input())).rejects.toMatchObject({
      code: 'encryption-unavailable',
    })
    expect(rows).toHaveLength(0)
  })

  it('refuses when the variable is set but the browser-derivable fallback key is the one in use', async () => {
    // THE DANGEROUS CASE. The environment reads back perfectly — an env-var
    // check would say "ready" — but lib/crypto.ts snapshotted the fallback key
    // at import time, so encrypt() is using a key derived from
    // NEXT_PUBLIC_SUPABASE_URL, which ships to every browser.
    const vault = await loadVault({ loadedAfter: STRONG_KEY })
    expect(process.env.API_ENCRYPTION_KEY).toBe(STRONG_KEY)

    const status = vault.encryptionStatus()
    expect(status).toMatchObject({ ready: false, reason: 'browser-derivable-key' })
    expect(status.message).toMatch(/browser/i)

    await expect(vault.saveCredential(makeClient(), OWNER, input())).rejects.toMatchObject({
      code: 'encryption-unavailable',
    })
    expect(rows).toHaveLength(0)
  })

  it('refuses to hand out plaintext on the resolve path too', async () => {
    // A vault whose encryption is not real has nothing trustworthy in it, so
    // reading is refused as well as writing — otherwise a row written while the
    // key was good would still be posted into a login form by a deployment that
    // can no longer be trusted to protect it.
    const good = await loadVault({ key: STRONG_KEY })
    const client = makeClient()
    await good.saveCredential(client, OWNER, input())

    const broken = await loadVault()
    await expect(
      broken.resolveCredentialFor(client, OWNER, 'acme.wd5.myworkdayjobs.com')
    ).rejects.toMatchObject({ code: 'encryption-unavailable' })
  })

  it('still lets the user delete a credential when the key is gone', async () => {
    // A missing key is exactly when someone most wants to empty the vault.
    // Refusing here would turn a misconfiguration into a trap.
    const good = await loadVault({ key: STRONG_KEY })
    const client = makeClient()
    const saved = await good.saveCredential(client, OWNER, input())

    const broken = await loadVault()
    await expect(broken.deleteCredential(client, OWNER, saved.id)).resolves.toBe(true)
    expect(rows).toHaveLength(0)
  })

  it('reports ready only when the configured key is the one actually in use', async () => {
    const vault = await loadVault({ key: STRONG_KEY })
    expect(vault.encryptionStatus()).toEqual({ ready: true })
  })

  it('does not refuse a perfectly real key that arrived with a trailing newline', async () => {
    // A .env file that ends the line with a newline is not a misconfiguration.
    // lib/crypto.ts does not trim, so it scrypt-derives from the value INCLUDING
    // the newline; a check that trimmed first would compute a different key,
    // fail to match, and refuse a deployment whose encryption is fine. Failing
    // closed is the point of this module, but failing closed on a false alarm
    // is just a broken feature.
    const vault = await loadVault({ key: `${STRONG_KEY}\n` })
    expect(vault.encryptionStatus()).toEqual({ ready: true })

    const client = makeClient()
    await vault.saveCredential(client, OWNER, input())
    expect(
      (await vault.resolveCredentialFor(client, OWNER, 'acme.wd5.myworkdayjobs.com'))?.secret
    ).toBe(SECRET)
  })
})

// ---------------------------------------------------------------------------
// (4) Demo workspaces
// ---------------------------------------------------------------------------

describe('demo workspaces are refused', () => {
  const paths: Array<[string, (v: Vault, c: import('./vault').VaultClient) => Promise<unknown>]> = [
    ['saveCredential', (v, c) => v.saveCredential(c, OWNER, input())],
    ['listCredentials', (v, c) => v.listCredentials(c, OWNER)],
    ['resolveCredentialFor', (v, c) => v.resolveCredentialFor(c, OWNER, 'acme.wd5.myworkdayjobs.com')],
    ['deleteCredential', (v, c) => v.deleteCredential(c, OWNER, '00000001-0000-4000-8000-000000000000')],
  ]

  it.each(paths)('%s refuses a flagged demo profile', async (_name, run) => {
    const vault = await loadVault({ key: STRONG_KEY })
    const client = makeClient()
    profile = { id: OWNER, is_demo: true, demo_expires_at: '2999-01-01T00:00:00.000Z' }

    await expect(run(vault, client)).rejects.toMatchObject({ code: 'demo-forbidden' })
    // Refused BEFORE the table was touched.
    expect(issued.filter((q) => q.table === 'apply_credentials')).toHaveLength(0)
  })

  it.each(paths)('%s refuses a profile carrying only a demo deadline', async (_name, run) => {
    // The two-signal test from lib/access/guardrails.ts: a row that shed the
    // flag but kept the deadline is still a demo.
    const vault = await loadVault({ key: STRONG_KEY })
    const client = makeClient()
    profile = { id: OWNER, is_demo: false, demo_expires_at: '2999-01-01T00:00:00.000Z' }

    await expect(run(vault, client)).rejects.toMatchObject({ code: 'demo-forbidden' })
  })

  it.each(paths)('%s fails closed when the profile cannot be read', async (_name, run) => {
    const vault = await loadVault({ key: STRONG_KEY })
    const client = makeClient()
    profile = null
    profileError = { code: '08006', message: 'connection failure' }

    await expect(run(vault, client)).rejects.toMatchObject({ code: 'profile-unavailable' })
    expect(issued.filter((q) => q.table === 'apply_credentials')).toHaveLength(0)
  })

  it('turns the database trigger refusal into the same answer', async () => {
    // 20260803000004's forbid_demo_apply_credentials raises SQLSTATE 42501. A
    // backstop that surfaced as a 500 would read as "our bug, retry" — and the
    // retry would carry the password again.
    const vault = await loadVault({ key: STRONG_KEY })
    const client = makeClient()
    failures.upsert = { code: '42501', message: 'demo workspaces cannot store employer credentials' }

    await expect(vault.saveCredential(client, OWNER, input())).rejects.toMatchObject({
      code: 'demo-forbidden',
    })
  })
})

// ---------------------------------------------------------------------------
// Host matching — the cross-employer mistake
// ---------------------------------------------------------------------------

describe('host matching is exact', () => {
  it('never hands one employer the password for another on the same ATS apex', async () => {
    const vault = await loadVault({ key: STRONG_KEY })
    const client = makeClient()
    await vault.saveCredential(client, OWNER, input())

    // Every Workday customer shares myworkdayjobs.com. A suffix or
    // registrable-domain match here would post Acme's password to Beta.
    expect(await vault.resolveCredentialFor(client, OWNER, 'beta.wd5.myworkdayjobs.com')).toBeNull()
    expect(await vault.resolveCredentialFor(client, OWNER, 'myworkdayjobs.com')).toBeNull()
    expect(await vault.resolveCredentialFor(client, OWNER, 'wd5.myworkdayjobs.com')).toBeNull()
    expect(
      await vault.resolveCredentialFor(client, OWNER, 'acme.wd5.myworkdayjobs.com.evil.test')
    ).toBeNull()
  })

  it('does not fall back to the provider when a host was supplied and missed', async () => {
    const vault = await loadVault({ key: STRONG_KEY })
    const client = makeClient()
    await vault.saveCredential(client, OWNER, input())

    // The identical cross-employer mistake, arriving one step later.
    expect(
      await vault.resolveCredentialFor(client, OWNER, {
        host: 'beta.wd5.myworkdayjobs.com',
        provider: 'workday',
      })
    ).toBeNull()

    // Including when the host is unparseable — it must not silently degrade
    // into a provider lookup.
    expect(
      await vault.resolveCredentialFor(client, OWNER, { host: 'not a host', provider: 'workday' })
    ).toBeNull()
  })

  it('matches a job posting URL against the saved host', async () => {
    const vault = await loadVault({ key: STRONG_KEY })
    const client = makeClient()
    await vault.saveCredential(client, OWNER, input())

    const resolved = await vault.resolveCredentialFor(
      client,
      OWNER,
      'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Remote/Engineer_R-1234'
    )
    expect(resolved?.secret).toBe(SECRET)
  })

  it('treats www as the same site in both directions', async () => {
    const vault = await loadVault({ key: STRONG_KEY })
    const client = makeClient()
    await vault.saveCredential(client, OWNER, input({ host: 'www.acme.com', provider: null }))
    expect(rows[0].host).toBe('acme.com')
    expect((await vault.resolveCredentialFor(client, OWNER, 'https://www.acme.com/jobs'))?.secret).toBe(
      SECRET
    )
  })

  it('refuses a provider-only lookup that spans two employers', async () => {
    const vault = await loadVault({ key: STRONG_KEY })
    const client = makeClient()
    await vault.saveCredential(client, OWNER, input())
    await vault.saveCredential(
      client,
      OWNER,
      input({ host: 'beta.wd5.myworkdayjobs.com', label: 'Beta' })
    )

    // Two employers, no host to choose by: there is no safe answer, so the
    // application becomes a handoff.
    expect(await vault.resolveCredentialFor(client, OWNER, { provider: 'workday' })).toBeNull()
  })

  it('answers a provider-only lookup when only one employer is stored under it', async () => {
    const vault = await loadVault({ key: STRONG_KEY })
    const client = makeClient()
    await vault.saveCredential(client, OWNER, input())
    const resolved = await vault.resolveCredentialFor(client, OWNER, { provider: 'workday' })
    expect(resolved?.host).toBe('acme.wd5.myworkdayjobs.com')
  })

  it('picks the most recently used account when one board holds two', async () => {
    const vault = await loadVault({ key: STRONG_KEY })
    const client = makeClient()
    await vault.saveCredential(client, OWNER, input({ username: 'personal@example.com' }))
    await vault.saveCredential(
      client,
      OWNER,
      input({ username: 'student@example.edu', secret: 'PLACEHOLDER-university-7' })
    )
    rows[1].last_used_at = '2026-08-01T00:00:00.000Z'

    const resolved = await vault.resolveCredentialFor(client, OWNER, 'acme.wd5.myworkdayjobs.com')
    expect(resolved?.username).toBe('student@example.edu')

    // ...and an explicit username still wins.
    const narrowed = await vault.resolveCredentialFor(client, OWNER, {
      host: 'acme.wd5.myworkdayjobs.com',
      username: 'personal@example.com',
    })
    expect(narrowed?.secret).toBe(SECRET)
  })

  it('normalises hosts the same way on the way in and the way out', async () => {
    const vault = await loadVault({ key: STRONG_KEY })
    expect(vault.normalizeHost('  HTTPS://Acme.WD5.MyWorkdayJobs.com/en-US  ')).toBe(
      'acme.wd5.myworkdayjobs.com'
    )
    expect(vault.normalizeHost('acme.com:8443/careers')).toBe('acme.com')
    expect(vault.normalizeHost('acme.com.')).toBe('acme.com')
    expect(vault.normalizeHost('localhost')).toBeNull()
    expect(vault.normalizeHost('')).toBeNull()
    expect(vault.normalizeHost('has space.com')).toBeNull()
    expect(vault.normalizeHost(null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

describe('input handling', () => {
  it('refuses an unusable board address, a missing username and an empty password', async () => {
    const vault = await loadVault({ key: STRONG_KEY })
    const client = makeClient()

    await expect(vault.saveCredential(client, OWNER, input({ host: 'nope' }))).rejects.toMatchObject({
      code: 'invalid-input',
    })
    await expect(vault.saveCredential(client, OWNER, input({ username: '   ' }))).rejects.toMatchObject({
      code: 'invalid-input',
    })
    await expect(vault.saveCredential(client, OWNER, input({ secret: '' }))).rejects.toMatchObject({
      code: 'invalid-input',
    })
    expect(rows).toHaveLength(0)
  })

  it('falls back to the host as the label rather than storing a blank one', async () => {
    const vault = await loadVault({ key: STRONG_KEY })
    const client = makeClient()
    const saved = await vault.saveCredential(client, OWNER, input({ label: '   ' }))
    expect(saved.label).toBe('acme.wd5.myworkdayjobs.com')
  })

  it('deletes only the caller’s own row, and reports a miss without confirming anything', async () => {
    const vault = await loadVault({ key: STRONG_KEY })
    const client = makeClient()
    const saved = await vault.saveCredential(client, OWNER, input())

    await expect(vault.deleteCredential(client, 'someone-else', saved.id)).resolves.toBe(false)
    expect(rows).toHaveLength(1)

    // A malformed id is "not found", not a 500 from a uuid cast.
    await expect(vault.deleteCredential(client, OWNER, 'not-a-uuid')).rejects.toMatchObject({
      code: 'not-found',
    })

    await expect(vault.deleteCredential(client, OWNER, saved.id)).resolves.toBe(true)
    expect(rows).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// (5) Error paths
// ---------------------------------------------------------------------------

describe('error paths never carry the secret', () => {
  it('names the credential by label when the write fails', async () => {
    const vault = await loadVault({ key: STRONG_KEY })
    const client = makeClient()
    // Postgres puts the offending row's column VALUES in `details`/`hint`.
    // Nothing may copy them anywhere.
    failures.upsert = {
      code: '23505',
      message: 'duplicate key value violates unique constraint',
      details: `Failing row contains (…, ${SECRET}, …)`,
      hint: SECRET,
    }

    const error = await vault.saveCredential(client, OWNER, input()).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('Acme careers')
    expectNoSecret((error as Error).message)
    expectNoSecret(safeStringify(error))
  })

  it('names the credential when a stored row will not decrypt', async () => {
    const vault = await loadVault({ key: STRONG_KEY })
    const client = makeClient()
    await vault.saveCredential(client, OWNER, input())
    // Same shape, different key — what a rotated API_ENCRYPTION_KEY looks like.
    rows[0].encrypted_secret = `${'A'.repeat(22)}==:${'B'.repeat(22)}==:QUJDRA==`

    const error = await vault
      .resolveCredentialFor(client, OWNER, 'acme.wd5.myworkdayjobs.com')
      .catch((e: Error) => e)
    expect(error).toMatchObject({ code: 'decrypt-failed' })
    expect((error as Error).message).toContain('Acme careers')
    expectNoSecret((error as Error).message)
  })

  it('surfaces a read failure without quoting anything from the row', async () => {
    const vault = await loadVault({ key: STRONG_KEY })
    const client = makeClient()
    await vault.saveCredential(client, OWNER, input())
    failures.select = { code: '57014', message: 'canceling statement due to statement timeout' }

    await expect(vault.listCredentials(client, OWNER)).rejects.toMatchObject({
      code: 'storage-failed',
    })
    await expect(
      vault.resolveCredentialFor(client, OWNER, 'acme.wd5.myworkdayjobs.com')
    ).rejects.toMatchObject({ code: 'storage-failed' })
  })

  it('says the length limit without quoting the password', async () => {
    const vault = await loadVault({ key: STRONG_KEY })
    const client = makeClient()
    const long = `${SECRET}${'x'.repeat(600)}`
    const error = await vault
      .saveCredential(client, OWNER, input({ secret: long }))
      .catch((e: Error) => e)
    expectNoSecret((error as Error).message)
    expect((error as Error).message).toContain('512')
  })
})

/**
 * The global assertion for property (5).
 *
 * Runs last and covers EVERY console call made by every test above — the save
 * failure, the decrypt failure, the demo refusals, the ambiguous-provider
 * warning. A per-test check would miss a log line emitted from a path the test
 * was not looking at, which is exactly how a secret ends up in a log.
 */
describe('nothing spoken aloud during any of the above contained the secret', () => {
  it('holds across every log line the module emitted', () => {
    expect(spoken.length).toBeGreaterThan(0)
    for (const line of spoken) expectNoSecret(line)
  })
})

function expectNoSecret(text: string) {
  expect(text).not.toContain(SECRET)
  expect(text).not.toContain(SECRET.trim())
  expect(text).not.toContain('PLACEHOLDER-rotated-99')
  expect(text).not.toContain('PLACEHOLDER-university-7')
}
