// Only the owner reads the health report; everyone else gets a bare 404.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let user: { id: string } | null
let row: { report: unknown } | null
let readError: { message: string } | null

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user }, error: null }) } }),
}))
const fromMock = vi.fn()
vi.mock('@/lib/harness/supabase-admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      fromMock(table)
      const b = { select: () => b, order: () => b, limit: () => b, maybeSingle: async () => ({ data: row, error: readError }) }
      return b
    },
  }),
}))

import { GET } from './route'

const REPORT = { checked_at: '2026-10-06T08:00:00Z', db_bytes: 212 * 1024 * 1024, issues: [] }

beforeEach(() => {
  user = { id: 'owner-1' }
  row = { report: REPORT }
  readError = null
  fromMock.mockReset()
  process.env.OWNER_USER_ID = 'owner-1'
})
afterEach(() => {
  delete process.env.OWNER_USER_ID
})

describe('GET /api/ops/health', () => {
  it('is a 404 when signed out, and reads nothing', async () => {
    user = null
    const res = await GET()
    expect(res.status).toBe(404)
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('is a 404 for a signed-in person who is not the owner', async () => {
    user = { id: 'someone-else' }
    const res = await GET()
    expect(res.status).toBe(404)
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('is a 404 for everyone when no owner is set', async () => {
    delete process.env.OWNER_USER_ID
    const res = await GET()
    expect(res.status).toBe(404)
  })

  it('gives the owner the latest report', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ report: REPORT })
    expect(fromMock).toHaveBeenCalledWith('ops_health_checks')
  })

  it('gives the owner null before any check has run', async () => {
    row = null
    const res = await GET()
    expect(await res.json()).toEqual({ report: null })
  })

  it('says it could not read the report without leaking the database error', async () => {
    readError = { message: 'relation "ops_health_checks" does not exist' }
    const res = await GET()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('relation')
  })
})
