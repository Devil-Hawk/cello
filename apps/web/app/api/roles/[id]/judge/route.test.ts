import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = { user: { id: 'u1' } as { id: string } | null }
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user }, error: null }) } }) }))
const row = { band: 'possible', readings: [{ id: 'a' }], prov: { step: 'role.evidence' }, judged_at: '2026-10-22T10:00:00Z' }
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row }) }) }) }) }) }) }))

const judgeRole = vi.fn()
const judgeStatus = vi.fn()
vi.mock('@/lib/roles/judge', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/roles/judge')>()), judgeRole: (...a: unknown[]) => judgeRole(...a), judgeStatus: (...a: unknown[]) => judgeStatus(...a) }))
vi.mock('@/lib/scoring', () => ({ getRoleFit: async () => ({ jobId: 'x', blocked: [], want: null, chance: { label: 'possible', checks: [], gaps: [], confirm: [], note: null } }) }))

import { POST } from './route'

const ID = '4f5ad7eb-912c-4e15-ab3c-0f8248113d69'
const post = (id = ID, headers: Record<string, string> = {}) => POST(new NextRequest(`http://localhost/api/roles/${id}/judge`, { method: 'POST', headers }), { params: { id } })

beforeEach(() => {
  vi.clearAllMocks()
  state.user = { id: 'u1' }
  judgeStatus.mockResolvedValue({ judgedToday: 40, waiting: 80, line: null })
})

describe('POST /api/roles/:id/judge', () => {
  it('refuses a request from another site, and one that is not signed in, before judging anything', async () => {
    expect((await post(ID, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    state.user = null
    expect((await post()).status).toBe(401)
    expect((await post('nope')).status).toBe(401)
    state.user = { id: 'u1' }
    expect((await post('nope')).status).toBe(400)
    expect(judgeRole).not.toHaveBeenCalled()
  })

  it('judges the role for the signed-in person and returns the band, readings and provenance', async () => {
    judgeRole.mockResolvedValue({ judged: [ID], stopped: null })
    const res = await post(ID, { 'sec-fetch-site': 'same-origin' })
    expect(res.status).toBe(200)
    expect(judgeRole.mock.calls[0].slice(1, 3)).toEqual(['u1', ID])
    expect(await res.json()).toMatchObject({ band: 'possible', readings: [{ id: 'a' }], prov: { step: 'role.evidence' }, judgedAt: '2026-10-22T10:00:00Z', chance: { label: 'possible' } })
  })

  it('answers 429 with the day line when no free call is left', async () => {
    judgeRole.mockResolvedValue({ judged: [], stopped: 'day' })
    const res = await post()
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'Cello judged 40 of your 120 new roles today. The rest continue tomorrow.', skippedReason: 'day' })
  })

  it('answers 429 when the minute is full, 400 without a model or a resume, 404 for a role the person does not hold', async () => {
    judgeRole.mockResolvedValueOnce({ judged: [], stopped: 'minute' })
    expect((await post()).status).toBe(429)
    judgeRole.mockResolvedValueOnce({ judged: [], stopped: 'no_model' })
    expect(await (await post()).json()).toMatchObject({ error: 'Cello needs a model to read this one. Choose a free model.' })
    judgeRole.mockResolvedValueOnce({ judged: [], stopped: 'no_resume' })
    expect((await post()).status).toBe(400)
    judgeRole.mockResolvedValueOnce({ judged: [], stopped: null })
    expect((await post()).status).toBe(404)
  })
})
