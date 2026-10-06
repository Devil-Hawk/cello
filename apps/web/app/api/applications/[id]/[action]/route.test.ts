// The action route: an unknown word is a 404 before anything is read, and every action needs the session.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

let user: { id: string } | null
const skip = vi.fn()

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user }, error: null }) } }) }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/pipeline/commands', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/pipeline/commands')>()), skip: (...a: unknown[]) => skip(...a) }))

import { POST } from './route'

const ID = '11111111-1111-4111-8111-111111111111'
const call = (action: string, body: unknown = {}) =>
  POST(new NextRequest(`http://localhost/api/applications/${ID}/${action}`, { method: 'POST', body: JSON.stringify(body) }), { params: { id: ID, action } })

beforeEach(() => {
  user = { id: 'u1' }
  skip.mockReset().mockResolvedValue({ ok: false, refusal: 'stale', sentence: 'This changed while you were looking. Open it again.' })
})

describe('POST /api/applications/[id]/[action]', () => {
  it('404s an action that is not in the list, even for a signed-in person', async () => {
    expect((await call('delete')).status).toBe(404)
    expect((await call('constructor')).status).toBe(404)
    expect(skip).not.toHaveBeenCalled()
  })

  it('needs the session for every action, the person-only ones included', async () => {
    user = null
    for (const a of ['mark-sent', 'approve', 'stage', 'retract', 'allow-send', 'skip']) expect((await call(a)).status).toBe(401)
    expect(skip).not.toHaveBeenCalled()
  })

  it('answers a refusal with its sentence and a status', async () => {
    const res = await call('skip')
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ ok: false, refusal: 'stale', error: expect.stringContaining('changed') })
  })

  it('refuses a stage that is not one, and an approval with no resume version', async () => {
    expect((await call('stage', { stage: 'hired' })).status).toBe(400)
    expect((await call('approve', {})).status).toBe(400)
  })
})
