// POST /api/gmail/cron's own logic: CRON_SECRET auth, the eligible-user
// filter (monitor enabled AND a stored refresh token — see
// lib/gmail/token.ts's header for why the second half matters), the
// MAX_USERS_PER_TICK cap, and per-user isolation. runGmailSyncCore itself is
// mocked wholesale — its own behavior (including the idempotency guarantee)
// is pinned by lib/gmail/sync-core.test.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

interface ProfileRow {
  id: string
  preferences: Record<string, unknown> | null
}

let profiles: ProfileRow[]

const runGmailSyncCoreMock = vi.fn()
const getGmailAccessTokenMock = vi.fn()
const loadApiKeysMock = vi.fn()

class FakeQuery {
  constructor(private table: string) {}
  select(_cols?: string) {
    return this
  }
  then<T1 = { data: unknown; error: unknown }, T2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.resolve()).then(
      onfulfilled as (value: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>,
      onrejected as (reason: unknown) => T2 | PromiseLike<T2>
    )
  }
  private resolve(): { data: unknown; error: unknown } {
    if (this.table === 'profiles') return { data: profiles, error: null }
    throw new Error(`route.test.ts: unexpected table "${this.table}"`)
  }
}

vi.mock('@/lib/harness/supabase-admin', () => ({
  createAdminClient: () => ({ from: (table: string) => new FakeQuery(table) }),
}))
vi.mock('@/lib/gmail/token', () => ({
  getGmailAccessToken: (...args: unknown[]) => getGmailAccessTokenMock(...args),
}))
vi.mock('@/lib/harness/keys', () => ({
  loadApiKeys: (...args: unknown[]) => loadApiKeysMock(...args),
}))
vi.mock('@/lib/gmail/sync-core', () => ({
  runGmailSyncCore: (...args: unknown[]) => runGmailSyncCoreMock(...args),
}))

import { POST } from './route'

const SECRET = 'test-cron-secret'

function cronRequest() {
  return new NextRequest('http://localhost/api/gmail/cron', {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}` },
  })
}

function makeProfile(id: string, opts: { monitor?: boolean; refreshToken?: string | null } = {}): ProfileRow {
  const { monitor = true, refreshToken = 'enc:fake-refresh-token' } = opts
  return {
    id,
    preferences: {
      gmail_permissions: monitor
        ? { monitor: { enabled: true, grantedAt: '2026-08-01T00:00:00.000Z', revokedAt: null, migratedFrom: null } }
        : {},
      gmail_sync: refreshToken ? { refreshToken } : {},
    },
  }
}

beforeEach(() => {
  process.env.CRON_SECRET = SECRET
  profiles = []
  runGmailSyncCoreMock.mockReset()
  getGmailAccessTokenMock.mockReset()
  loadApiKeysMock.mockReset()
  getGmailAccessTokenMock.mockResolvedValue({ ok: true, accessToken: 'live-token' })
  loadApiKeysMock.mockResolvedValue({})
  runGmailSyncCoreMock.mockResolvedValue({ success: true, processed: 0, isFirstSync: false, message: 'ok', totalScanned: 0, createdCompanies: [], createdApplications: [], statusUpdates: [], unmatched: [] })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('POST /api/gmail/cron — auth', () => {
  it('rejects a request without the correct CRON_SECRET', async () => {
    const response = await POST(new NextRequest('http://localhost/api/gmail/cron', { method: 'POST' }))
    expect(response.status).toBe(401)
    expect(runGmailSyncCoreMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/gmail/cron — eligibility filter', () => {
  it('only runs sync for users with monitor enabled AND a stored refresh token', async () => {
    profiles = [
      makeProfile('eligible-1'),
      makeProfile('no-monitor', { monitor: false }),
      makeProfile('no-refresh-token', { refreshToken: null }),
    ]

    const response = await POST(cronRequest())
    const body = await response.json()

    expect(body.eligibleUsers).toBe(1)
    expect(runGmailSyncCoreMock).toHaveBeenCalledTimes(1)
    expect(runGmailSyncCoreMock.mock.calls[0][0].userId).toBe('eligible-1')
  })

  it('caps the batch at MAX_USERS_PER_TICK even with more eligible profiles', async () => {
    profiles = Array.from({ length: 15 }, (_, i) => makeProfile(`user-${i}`))

    const response = await POST(cronRequest())
    const body = await response.json()

    expect(body.eligibleUsers).toBe(15)
    expect(body.processed).toBe(10) // MAX_USERS_PER_TICK
    expect(runGmailSyncCoreMock).toHaveBeenCalledTimes(10)
  })
})

describe('POST /api/gmail/cron — per-user isolation', () => {
  it("one user's sync throwing never blocks another user's tick", async () => {
    profiles = [makeProfile('user-ok'), makeProfile('user-bad')]
    runGmailSyncCoreMock.mockImplementation(async ({ userId }: { userId: string }) => {
      if (userId === 'user-bad') throw new Error('Gmail API rate limited')
      return { success: true, processed: 1, isFirstSync: false, message: 'ok', totalScanned: 1, createdCompanies: [], createdApplications: [], statusUpdates: [], unmatched: [] }
    })

    const response = await POST(cronRequest())
    const body = await response.json()

    expect(body.results).toHaveLength(2)
    const bad = body.results.find((r: { userId: string }) => r.userId === 'user-bad')
    expect(bad.error).toContain('Gmail API rate limited')
    const ok = body.results.find((r: { userId: string }) => r.userId === 'user-ok')
    expect(ok.processed).toBe(1)
  })

  it('an invalid_grant token failure is reported, not thrown, and never calls runGmailSyncCore', async () => {
    profiles = [makeProfile('user-revoked')]
    getGmailAccessTokenMock.mockResolvedValue({ ok: false, reason: 'invalid_grant', message: 'grant revoked' })

    const response = await POST(cronRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(runGmailSyncCoreMock).not.toHaveBeenCalled()
    expect(body.results[0].tokenIssue).toBe('invalid_grant')
  })
})
