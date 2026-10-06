// POST /api/fill/token: a demo cannot connect an extension; a person gets one scoped token and the old one is revoked.

import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ demo: true, revoked: 0, created: 0 }))
vi.mock('@/lib/pipeline/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pipeline/session')>()),
  sessionCtx: async () => ({
    userId: 'u1',
    door: { actor: 'person', channel: 'session' },
    admin: {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { is_demo: state.demo, demo_expires_at: null } }) }) }),
        update: () => ({ eq: () => ({ is: () => ({ contains: async () => (state.revoked++, {}) }) }) }),
      }),
    },
  }),
}))
vi.mock('@/lib/access/tokens', () => ({ createToken: async (_a: unknown, i: { scopes: string[] }) => (state.created++, { token: 'cello_pat_x', id: 'tok1', scopes: i.scopes }) }))

import { POST } from '@/app/api/fill/token/route'

describe('POST /api/fill/token', () => {
  it('refuses a demo account and mints nothing', async () => {
    const res = await POST()
    expect(res.status).toBe(403)
    expect(state.created + state.revoked).toBe(0)
  })

  it('gives a person one token and revokes the old', async () => {
    state.demo = false
    const res = await POST()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ token: 'cello_pat_x', id: 'tok1' })
    expect(state.revoked).toBe(1)
  })
})
