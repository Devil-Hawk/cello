import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ rpc: vi.fn() }))

vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({ rpc: state.rpc }) }))
vi.mock('@/lib/access/tokens', () => ({
  validateToken: async (_admin: unknown, bearer: string) =>
    bearer === 'cello_pat_fill'
      ? { ok: true, userId: 'user-a', scopes: ['fill:extension'] }
      : bearer === 'cello_pat_relay'
        ? { ok: true, userId: 'user-a', scopes: ['relay'] }
        : { ok: false, reason: 'unknown' },
}))

import { GET } from './route'

const get = (authorization?: string) =>
  GET(new NextRequest('http://localhost/api/extension/status', { headers: authorization ? { authorization } : {} }))

beforeEach(() => state.rpc.mockReset())

describe('GET /api/extension/status', () => {
  it('answers 401 with no token or an unknown one, and 403 to the relay token', async () => {
    expect((await get()).status).toBe(401)
    expect((await get('Bearer nope')).status).toBe(401)
    expect((await get('Bearer cello_pat_relay')).status).toBe(403)
    expect(state.rpc).not.toHaveBeenCalled()
  })

  it('returns exactly what the SQL function says, for the token holder', async () => {
    state.rpc.mockResolvedValue({ data: { send_for_me: true, paused: false, sent_today: 1, tries_today: 2, cap: 3 }, error: null })
    const res = await get('Bearer cello_pat_fill')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ send_for_me: true, paused: false, sent_today: 1, tries_today: 2, cap: 3 })
    expect(state.rpc).toHaveBeenCalledWith('extension_status', { p_user: 'user-a' })
  })

  it('answers 500 rather than invented numbers when the read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    state.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } })
    expect((await get('Bearer cello_pat_fill')).status).toBe(500)
  })
})
