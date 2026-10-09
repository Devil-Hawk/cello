// GET and POST /api/roles/:id/fit: reading what Cello concluded about one role,
// and assessing it on demand. POST names the role in the trace (not a bare uuid)
// and explains a missing key or resume instead of failing quietly.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const traced = { meta: [] as unknown[] }
vi.mock('@/lib/trace/spans', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/trace/spans')>()
  return { ...actual, setTraceMeta: (x: Record<string, string>) => (traced.meta.push(x), actual.setTraceMeta(x)) }
})

const state = { user: { id: 'u1' } as { id: string } | null, canRun: true }
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user }, error: null }) } }) }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/harness/keys', () => ({ loadApiKeys: async () => ({ openrouter: 'k' }) }))
vi.mock('@/lib/harness/llm', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/harness/llm')>()), callLlm: vi.fn() }))
vi.mock('@/lib/harness/llm-key-message', () => ({ canRunLlm: () => state.canRun, missingOpenRouterMessage: () => 'Add an OpenRouter key in Settings.' }))

const getRoleFit = vi.fn()
const assessJobs = vi.fn()
vi.mock('@/lib/scoring', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/scoring')>()),
  getRoleFit: (...a: unknown[]) => getRoleFit(...a),
  assessJobs: (...a: unknown[]) => assessJobs(...a),
}))

import { GET, POST } from './route'

const ID = '4f5ad7eb-912c-4e15-ab3c-0f8248113d69'
const FIT = { jobId: ID, assessedAt: '2026-10-06T08:00:00Z', blocked: [], want: { p: 0.7, reason: 'Payments work.', tier: 'high', calibrated: false, nReactions: 2 }, chance: { label: 'possible', checks: [], gaps: [], confirm: [], note: null } }
const get = (id = ID) => GET(new NextRequest(`http://localhost/api/roles/${id}/fit`), { params: { id } })
const post = (id = ID) => POST(new NextRequest(`http://localhost/api/roles/${id}/fit`, { method: 'POST' }), { params: { id } })

beforeEach(() => {
  vi.clearAllMocks()
  traced.meta.length = 0
  state.user = { id: 'u1' }
  state.canRun = true
})

describe('GET /api/roles/:id/fit', () => {
  it('returns the verdict for one of the person\'s roles, 404 for anyone else\'s, 401 signed out, 400 for a bad id', async () => {
    getRoleFit.mockResolvedValueOnce(FIT)
    expect(await (await get()).json()).toMatchObject({ chance: { label: 'possible' }, want: { tier: 'high' } })
    getRoleFit.mockResolvedValueOnce(null)
    expect((await get()).status).toBe(404)
    expect((await get('nope')).status).toBe(400)
    state.user = null
    expect((await get()).status).toBe(401)
  })
})

describe('POST /api/roles/:id/fit', () => {
  it('is a 400 explaining the gap when there is no model key, and spends nothing', async () => {
    state.canRun = false
    const res = await post()
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'Add an OpenRouter key in Settings.', skippedReason: 'no-llm-key' })
    expect(assessJobs).not.toHaveBeenCalled()
  })

  it('assesses just this role now and returns its fit, naming the role in the trace', async () => {
    assessJobs.mockResolvedValue({ assessed: 1, blocked: 0, failed: 0, remaining: 0, fits: new Map([[ID, FIT]]) })
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ jobId: ID, chance: { label: 'possible' } })
    expect(assessJobs).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', jobIds: [ID], limit: 1 }))
    expect(traced.meta).toEqual([{ job_id: ID }])
  })

  it('says to add a resume rather than showing a chance it cannot check', async () => {
    assessJobs.mockResolvedValue({ assessed: 0, blocked: 0, failed: 0, remaining: 0, skippedReason: 'no-resume', fits: new Map() })
    const res = await post()
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/resume/i)
  })

  it('is a 404 when the role is not the person\'s, and a 500 without internals when assessing breaks', async () => {
    assessJobs.mockResolvedValue({ assessed: 0, blocked: 0, failed: 0, remaining: 0, skippedReason: 'no-roles', fits: new Map() })
    getRoleFit.mockResolvedValue(null)
    expect((await post()).status).toBe(404)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    assessJobs.mockRejectedValue(new Error('timeout talking to 10.1.2.3'))
    const broken = await post()
    expect(broken.status).toBe(500)
    expect(JSON.stringify(await broken.json())).not.toContain('10.1.2.3')
  })
})
