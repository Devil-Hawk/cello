// GET /api/gmail/permissions must never return the Gmail refresh token that
// now lives alongside gmail_sync (see lib/gmail/token.ts / app/auth/callback)
// — it returns only the permission GRANT state (enabled/grantedAt/revokedAt),
// never the credential that makes a grant usable. Same "sweep every response
// for secret material" idiom as app/api/settings/keys/route.test.ts.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const USER_ID = 'owner-user-1'
const SECRET_REFRESH_TOKEN = 'enc:PLACEHOLDER-refresh-token-never-leaked'

let user: { id: string } | null
let row: Record<string, unknown> | null
const writes: Record<string, unknown>[] = []
const responses: string[] = []

const supabase = {
  auth: { getUser: async () => ({ data: { user }, error: null }) },
  from(_table: string) {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: row, error: null }),
        }),
      }),
      update(patch: Record<string, unknown>) {
        return {
          eq: async () => {
            writes.push(patch)
            row = { ...(row ?? {}), ...patch }
            return { data: null, error: null }
          },
        }
      },
    }
  },
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabase }))

import { GET, PUT } from './route'

async function read(response: Response): Promise<Record<string, unknown>> {
  const text = await response.clone().text()
  responses.push(text)
  return (await response.json().catch(() => ({}))) as Record<string, unknown>
}

beforeEach(() => {
  user = { id: USER_ID }
  row = {
    preferences: {
      gmail_permissions: {
        monitor: { enabled: true, grantedAt: '2026-08-01T00:00:00.000Z', revokedAt: null, migratedFrom: null },
      },
      gmail_sync: {
        lastSyncDate: '2026-08-20T00:00:00.000Z',
        refreshToken: SECRET_REFRESH_TOKEN,
      },
    },
  }
  writes.length = 0
})

afterAll(() => {
  expect(responses.length).toBeGreaterThan(0)
  for (const text of responses) {
    expect(text).not.toContain(SECRET_REFRESH_TOKEN)
    expect(text.toLowerCase()).not.toContain('refreshtoken')
  }
})

describe('GET /api/gmail/permissions', () => {
  it('returns the grant state but never the stored refresh token', async () => {
    const response = await GET()
    expect(response.status).toBe(200)
    const body = await read(response)
    expect((body.permissions as { monitor: { enabled: boolean } }).monitor.enabled).toBe(true)
    expect(JSON.stringify(body)).not.toContain('refreshToken')
  })

  it('401s an unauthenticated caller before touching the profile', async () => {
    user = null
    const response = await GET()
    expect(response.status).toBe(401)
    await read(response)
  })

  it('reports backgroundReady from stored token presence, not any live session scope', async () => {
    const response = await GET()
    const body = await read(response)
    expect(body.backgroundReady).toBe(true)
    expect(body.lastSyncAt).toBe('2026-08-20T00:00:00.000Z')
  })

  it('backgroundReady is false once the refresh token is gone, even if monitor still reads enabled', async () => {
    row = {
      preferences: {
        gmail_permissions: {
          monitor: { enabled: true, grantedAt: '2026-08-01T00:00:00.000Z', revokedAt: null, migratedFrom: null },
        },
        gmail_sync: { lastSyncDate: '2026-08-20T00:00:00.000Z' },
      },
    }
    const response = await GET()
    const body = await read(response)
    expect(body.backgroundReady).toBe(false)
  })
})

describe('PUT /api/gmail/permissions', () => {
  function putRequest(body: unknown) {
    return new NextRequest('http://localhost/api/gmail/permissions', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('toggling a tier never echoes the refresh token back, and leaves gmail_sync untouched', async () => {
    const response = await PUT(putRequest({ tier: 'send', enabled: true }))
    expect(response.status).toBe(200)
    await read(response)

    expect(writes).toHaveLength(1)
    const written = writes[0].preferences as Record<string, unknown>
    const gmailSync = written.gmail_sync as Record<string, unknown>
    expect(gmailSync.refreshToken).toBe(SECRET_REFRESH_TOKEN) // untouched, not wiped
  })
})
