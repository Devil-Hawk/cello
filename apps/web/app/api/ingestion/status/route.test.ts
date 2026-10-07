import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = { user: { id: 'user-1' } as { id: string } | null, fail: false }

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user }, error: null }) },
    from: (table: string) => {
      if (table === 'ingestion_runs') {
        const b: Record<string, unknown> = {
          select: () => b,
          eq: () => b,
          order: () => b,
          limit: () => b,
          maybeSingle: async () => (state.fail ? { data: null, error: { message: 'boom' } } : { data: null, error: null }),
        }
        return b
      }
      if (table === 'routines') return { select: () => ({ in: () => Promise.resolve({ data: [{ command: 'roles.check', next_due_at: '2026-10-08T18:00:00Z', enabled: true }], error: null }) }) }
      if (table === 'job_heartbeats') return { select: () => ({ in: () => Promise.resolve({ data: [], error: null }) }) }
      return { select: () => Promise.resolve({ count: 2, error: null }) }
    },
  }),
}))

vi.mock('@/lib/harness/supabase-admin', () => ({
  createAdminClient: () => ({ rpc: async () => ({ data: false, error: null }), from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }),
}))

import { GET } from './route'

beforeEach(() => {
  state.user = { id: 'user-1' }
  state.fail = false
})

describe('GET /api/ingestion/status', () => {
  it('requires a signed-in user', async () => {
    state.user = null
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('returns the status, never cached', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toMatchObject({ state: 'never', hasCompanies: true })
  })

  it('carries the clock: the next check from the routine, and background work off without the server rows', async () => {
    const body = await (await GET()).json()
    expect(body.nextCheckAt).toBe('2026-10-08T18:00:00Z')
    expect(body.checks).toMatchObject({ backgroundReady: false, backgroundText: 'Background work is off on this server.' })
    expect(body.checks.rolesCheck).toMatchObject({ command: 'roles.check', nextDueAt: '2026-10-08T18:00:00Z' })
  })

  it('says it could not read, without the database message', async () => {
    state.fail = true
    const res = await GET()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('boom')
  })
})
