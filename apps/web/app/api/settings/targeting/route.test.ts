// PUT /api/settings/targeting and the role types a person may choose: only ids of the taxonomy, at most 8,
// and `functions` follows from the chosen types' families.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

let stored: Record<string, unknown> = { api_keys: { openrouter: 'secret' } }
const writes: Record<string, unknown>[] = []
const supabase = {
  auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) },
  from: () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: { preferences: stored }, error: null }),
      update: (patch: Record<string, unknown>) => {
        writes.push(patch)
        return chain
      },
      then: (resolve: (v: unknown) => void) => resolve({ error: null }),
    }
    return chain
  },
}
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabase }))

import { PUT } from './route'

const put = (body: unknown) =>
  PUT(new NextRequest('http://localhost/api/settings/targeting', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }))

beforeEach(() => {
  writes.length = 0
  stored = { api_keys: { openrouter: 'secret' } }
})

describe('PUT /api/settings/targeting: role types', () => {
  it('saves chosen types, derives functions from their families, and keeps the rest of the preferences', async () => {
    const res = await put({ role_types: ['forward-deployed-engineer', 'data-scientist', 'ai-engineer'], seniority: ['senior'] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.targeting.role_types).toEqual(['forward-deployed-engineer', 'data-scientist', 'ai-engineer'])
    expect(body.targeting.functions).toEqual(['engineering', 'data'])
    const saved = writes[0].preferences as { api_keys: unknown; targeting: { role_types: string[]; functions: string[] } }
    expect(saved.api_keys).toEqual({ openrouter: 'secret' })
    expect(saved.targeting.role_types).toHaveLength(3)
  })

  it('refuses an id that is not in the taxonomy, and `other`, which nobody chooses', async () => {
    for (const bad of [['no-such-type'], ['ai-engineer', 'forged'], ['other'], [42], 'ai-engineer']) {
      const res = await put({ role_types: bad })
      expect(res.status, JSON.stringify(bad)).toBe(400)
    }
    expect(writes).toEqual([])
  })

  it('refuses a ninth type, and counts a repeated one once', async () => {
    const nine = ['forward-deployed-engineer', 'ai-engineer', 'ml-engineer', 'applied-scientist', 'research-engineer', 'research-scientist', 'data-scientist', 'data-engineer', 'analytics-engineer']
    const res = await put({ role_types: nine })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('at most 8')
    expect((await put({ role_types: nine.slice(0, 8) })).status).toBe(200)
    expect((await put({ role_types: ['ai-engineer', 'ai-engineer'] })).status).toBe(200)
  })

  it('keeps the target titles stored beside the form\'s fields', async () => {
    stored = { targeting: { titles: ['Backend Engineer'], countries: ['DE'] } }
    await put({ role_types: ['ai-engineer'] })
    const saved = writes[0].preferences as { targeting: { titles: string[]; countries: string[] } }
    expect(saved.targeting.titles).toEqual(['Backend Engineer'])
    expect(saved.targeting.countries).toEqual([])
  })

  it('leaves `functions` alone when no types are chosen, and saves the review state off', async () => {
    const res = await put({ functions: ['sales'], role_types: [], role_types_review: false })
    const body = await res.json()
    expect(body.targeting.functions).toEqual(['sales'])
    expect(body.targeting.role_types_review).toBe(false)
    expect((await put({ role_types_review: 'yes' })).status).toBe(400)
  })
})
