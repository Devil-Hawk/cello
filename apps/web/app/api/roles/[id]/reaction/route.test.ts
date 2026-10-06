// POST and DELETE /api/roles/:id/reaction: what is accepted, what is refused, and
// that the work is done as the signed-in person.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = { user: { id: 'u1' } as { id: string } | null }
const client = { auth: { getUser: async () => ({ data: { user: state.user }, error: null }) } }
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => client }))

const triageRole = vi.fn()
const undoReaction = vi.fn()
vi.mock('@/lib/scoring', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/scoring')>()),
  triageRole: (...a: unknown[]) => triageRole(...a),
  undoReaction: (...a: unknown[]) => undoReaction(...a),
}))

import { ScoringInputError } from '@/lib/scoring'
import { DELETE, POST } from './route'

const ID = '4f5ad7eb-912c-4e15-ab3c-0f8248113d69'
const post = (body: unknown, id = ID) => POST(new NextRequest(`http://localhost/api/roles/${id}/reaction`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' } }), { params: { id } })
const del = (id = ID) => DELETE(new NextRequest(`http://localhost/api/roles/${id}/reaction`, { method: 'DELETE' }), { params: { id } })

beforeEach(() => {
  vi.clearAllMocks()
  state.user = { id: 'u1' }
})

describe('POST /api/roles/:id/reaction', () => {
  it('is 401 for a signed-out visitor, before reading anything', async () => {
    state.user = null
    expect((await post({ reaction: 'interested', surface: 'today' })).status).toBe(401)
    expect(triageRole).not.toHaveBeenCalled()
  })

  it('saves the reaction as the signed-in person and returns the message', async () => {
    triageRole.mockResolvedValue({ reaction: 'not_for_me', message: 'Got it. Fewer roles in this area.' })
    const res = await post({ reaction: 'not_for_me', reason: 'domain', surface: 'roles', pickKind: 'explore', note: 'ads again' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ reaction: 'not_for_me', message: 'Got it. Fewer roles in this area.' })
    expect(triageRole).toHaveBeenCalledWith({ db: client, userId: 'u1', jobId: ID, reaction: 'not_for_me', reason: 'domain', note: 'ads again', surface: 'roles', pickKind: 'explore' })
  })

  it('takes the new page names and the three added reasons, and refuses the old page names', async () => {
    triageRole.mockResolvedValue({ reaction: 'not_for_me', message: 'Got it.' })
    for (const surface of ['roles', 'record', 'today', 'applications', 'company', 'chat']) {
      expect((await post({ reaction: 'not_for_me', reason: 'sponsorship', surface })).status, surface).toBe(200)
    }
    for (const reason of ['relocation', 'agency', 'sponsorship']) {
      expect((await post({ reaction: 'not_for_me', reason, surface: 'roles' })).status, reason).toBe(200)
    }
    for (const surface of ['opportunities', 'pipeline']) {
      expect((await post({ reaction: 'interested', surface })).status, surface).toBe(400)
    }
  })

  it('refuses a body that is not a reaction, a made-up reason or surface, and a role id that is not an id', async () => {
    for (const bad of [{ reaction: 'love', surface: 'today' }, { reaction: 'not_for_me', reason: 'vibes', surface: 'today' }, { reaction: 'interested', surface: 'inbox' }, { surface: 'today' }, 'not json']) {
      const res = await post(bad)
      expect(res.status, JSON.stringify(bad)).toBe(400)
      expect(typeof (await res.json()).error).toBe('string')
    }
    expect((await post({ reaction: 'interested', surface: 'today' }, 'not-an-id')).status).toBe(400)
    expect(triageRole).not.toHaveBeenCalled()
  })

  it('turns a refusal from the scoring system into a 400 with its own words', async () => {
    triageRole.mockRejectedValue(new ScoringInputError('A reason belongs to a pass only.'))
    const res = await post({ reaction: 'interested', reason: 'pay', surface: 'today' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'A reason belongs to a pass only.' })
  })

  it('is a 500 with no internals for an unexpected failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    triageRole.mockRejectedValue(new Error('relation "role_reactions" does not exist'))
    const res = await post({ reaction: 'interested', surface: 'today' })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('role_reactions')
  })
})

describe('DELETE /api/roles/:id/reaction', () => {
  it('takes a reaction back, and is 401 when signed out', async () => {
    undoReaction.mockResolvedValue({ undone: true })
    const res = await del()
    expect(await res.json()).toEqual({ undone: true })
    expect(undoReaction).toHaveBeenCalledWith({ db: client, userId: 'u1', jobId: ID })
    state.user = null
    expect((await del()).status).toBe(401)
  })
})
