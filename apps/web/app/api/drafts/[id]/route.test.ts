// A failed draft update must not hand the database's own error text to the
// client; the real message goes to the server log instead.

import { NextRequest } from 'next/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

const PG_MESSAGE = 'duplicate key value violates unique constraint "application_drafts_pkey"'

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }),
}))
const saveDraftText = vi.fn(async () => ({ artifactId: 'a1', version: 2, changed: true }))
vi.mock('@/lib/writing/drafts', () => ({ saveDraftText: (...a: unknown[]) => (saveDraftText as (...x: unknown[]) => unknown)(...a) }))
vi.mock('@/lib/harness/supabase-admin', () => ({
  createAdminClient: () => {
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'update', 'eq']) chain[m] = () => chain
    chain.maybeSingle = async () => ({ data: { id: 'd1', status: 'pending_review', job_id: 'j1' } })
    chain.single = async () => ({ data: null, error: { code: '23505', message: PG_MESSAGE } })
    return { from: () => chain }
  },
}))

import { PATCH } from './route'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PATCH /api/drafts/[id]', () => {
  it('writes the letter as an artifact version by the person before the row follows', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    saveDraftText.mockClear()
    await PATCH(new NextRequest('http://localhost/api/drafts/d1', { method: 'PATCH', body: JSON.stringify({ cover_letter: 'My edit' }) }), { params: { id: 'd1' } })
    expect(saveDraftText).toHaveBeenCalledWith(expect.anything(), { userId: 'u1', jobId: 'j1', field: 'cover_letter', text: 'My edit', author: 'user' })
  })

  it('does not touch the letter when only the summary changes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    saveDraftText.mockClear()
    await PATCH(new NextRequest('http://localhost/api/drafts/d1', { method: 'PATCH', body: JSON.stringify({ resume_summary: 'Short.' }) }), { params: { id: 'd1' } })
    expect(saveDraftText).not.toHaveBeenCalled()
  })

  it('returns a fixed message on a database failure and logs the real one', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await PATCH(
      new NextRequest('http://localhost/api/drafts/d1', { method: 'PATCH', body: JSON.stringify({ cover_letter: 'hi' }) }),
      { params: { id: 'd1' } }
    )
    expect(res.status).toBe(500)
    const text = JSON.stringify(await res.json())
    expect(text).toBe(JSON.stringify({ error: 'Failed to update draft' }))
    expect(text).not.toContain('duplicate key')
    expect(log.mock.calls.flat().join(' ')).toContain(PG_MESSAGE)
  })
})
