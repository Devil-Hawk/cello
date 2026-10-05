// /api/settings/outreach: autoSend, dailyCap and followUpDays were read by the
// send route, the queue banner and the follow-up window and written by nothing.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

let user: { id: string } | null
let row: Record<string, unknown> | null
let writes: Record<string, unknown>[]
let writeFailure: { code?: string; message?: string } | null

const supabase = {
  auth: { getUser: async () => ({ data: { user }, error: null }) },
  from: () => ({
    select: () => ({ eq: () => ({ single: async () => ({ data: row, error: null }) }) }),
    update: (patch: Record<string, unknown>) => ({
      eq: async () => {
        if (writeFailure) return { error: writeFailure }
        writes.push(patch)
        row = { ...(row ?? {}), ...patch }
        return { error: null }
      },
    }),
  }),
}
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabase }))
vi.mock('@/lib/harness/keys', () => ({
  readProfileForDemoGuards: async () => ({ row, error: null }),
}))

import { GET, POST } from './route'

function post(body: unknown) {
  return new NextRequest('http://localhost/api/settings/outreach', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const owner = (preferences: Record<string, unknown> = {}) => ({ preferences, is_demo: false, demo_expires_at: null })

beforeEach(() => {
  user = { id: 'user-1' }
  row = owner()
  writes = []
  writeFailure = null
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('GET', () => {
  it('returns the defaults for an account that never set anything', async () => {
    const body = await (await GET()).json()
    expect(body.prefs).toEqual({ autoSend: false, dailyCap: 10, followUpDays: 5 })
  })

  it('returns what was saved', async () => {
    row = owner({ outreach: { dailyCap: 20, followUpDays: 9, autoSend: true } })
    expect((await (await GET()).json()).prefs).toEqual({ autoSend: true, dailyCap: 20, followUpDays: 9 })
  })

  it('is closed to a signed-out caller', async () => {
    user = null
    expect((await GET()).status).toBe(401)
  })
})

describe('POST', () => {
  it('saves the three settings and leaves every other preference alone', async () => {
    row = owner({ api_keys: { openrouter: 'enc:x' }, targeting: { titles: ['SRE'] } })

    const res = await POST(post({ dailyCap: 25, followUpDays: 7, autoSend: false }))

    expect(res.status).toBe(200)
    expect((await res.json()).prefs).toEqual({ autoSend: false, dailyCap: 25, followUpDays: 7 })
    const saved = writes[0].preferences as Record<string, unknown>
    expect(saved.outreach).toEqual({ autoSend: false, dailyCap: 25, followUpDays: 7 })
    expect(saved.api_keys).toEqual({ openrouter: 'enc:x' })
    expect(saved.targeting).toEqual({ titles: ['SRE'] })
  })

  it('changing one field keeps the others as they were', async () => {
    row = owner({ outreach: { dailyCap: 30, followUpDays: 12, autoSend: false } })
    await POST(post({ followUpDays: 3 }))
    expect((writes[0].preferences as Record<string, unknown>).outreach).toEqual({ autoSend: false, dailyCap: 30, followUpDays: 3 })
  })

  it.each([
    [{ dailyCap: 0 }],
    [{ dailyCap: 51 }],
    [{ dailyCap: 2.5 }],
    [{ dailyCap: '10' }],
    [{ followUpDays: 0 }],
    [{ followUpDays: 61 }],
    [{ autoSend: 'yes' }],
  ])('refuses %j instead of clamping it silently, writing nothing', async (body) => {
    const res = await POST(post(body))
    expect(res.status).toBe(400)
    expect(writes).toEqual([])
  })

  it('refuses a demo session before reading the body', async () => {
    row = { preferences: {}, is_demo: true, demo_expires_at: new Date(Date.now() + 3600_000).toISOString() }
    const res = await POST(post({ dailyCap: 5 }))
    expect(res.status).toBe(403)
    expect(writes).toEqual([])
  })

  it('maps the database lockdown refusal to the same 403, not a 500', async () => {
    writeFailure = { code: '42501', message: 'demo profiles cannot enable outreach auto-send' }
    const res = await POST(post({ autoSend: true }))
    expect(res.status).toBe(403)
  })

  it('is closed to a signed-out caller', async () => {
    user = null
    expect((await POST(post({ dailyCap: 5 }))).status).toBe(401)
  })
})
