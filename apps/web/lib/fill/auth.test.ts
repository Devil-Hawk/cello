// The extension's token: only a live token with the fill scope gets in, and it carries its owner.

import { describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const tokens = vi.hoisted(() => ({ result: { ok: false } as { ok: boolean; userId?: string; scopes?: string[] }, row: { id: 'tok1' } as { id: string } | null }))
vi.mock('@/lib/access/tokens', () => ({ hashToken: (t: string) => `h:${t}`, validateToken: async () => tokens.result }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: tokens.row }) }) }) }) }) }))

import { fillAuth, isFillAuth } from './auth'

const req = (auth?: string) => new NextRequest('http://localhost/api/fill/next', { method: 'POST', headers: auth ? { authorization: auth } : {} })

describe('fillAuth', () => {
  it('refuses a request with no token, a token that is not valid, and one without the fill scope', async () => {
    expect(((await fillAuth(req())) as NextResponse).status).toBe(401)
    tokens.result = { ok: false }
    expect(((await fillAuth(req('Bearer abc'))) as NextResponse).status).toBe(401)
    tokens.result = { ok: true, userId: 'u2', scopes: ['relay:model'] }
    expect(((await fillAuth(req('Bearer abc'))) as NextResponse).status).toBe(401)
  })

  it('refuses a token whose row is gone, and gives a good token its owner', async () => {
    tokens.result = { ok: true, userId: 'u2', scopes: ['fill:extension'] }
    tokens.row = null
    expect(((await fillAuth(req('Bearer abc'))) as NextResponse).status).toBe(401)
    tokens.row = { id: 'tok1' }
    const a = await fillAuth(req('Bearer abc'))
    expect(isFillAuth(a) && a.userId).toBe('u2')
  })
})
