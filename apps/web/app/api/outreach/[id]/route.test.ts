// PATCH /api/outreach/[id]: a failed send used to be a dead end: the card had no
// button and the route no way back. 'retry' returns a failed message to the
// review state; it never sends anything by itself.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { OutreachMessageRow } from '@/lib/outreach/types'

let user: { id: string } | null
let existing: Partial<OutreachMessageRow> | null
const updateMock = vi.fn(async (_c: unknown, _u: string, _id: string, fields: Partial<OutreachMessageRow>) => ({ ...existing, ...fields }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user } }) } }),
}))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/outreach/store', () => ({
  getOutreach: async () => existing,
  updateOutreach: (...args: Parameters<typeof updateMock>) => updateMock(...args),
  deleteOutreach: vi.fn(),
}))

import { PATCH } from './route'

function patch(body: unknown) {
  return PATCH(
    new NextRequest('http://localhost/api/outreach/msg-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: { id: 'msg-1' } }
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  user = { id: 'user-1' }
  existing = { id: 'msg-1', status: 'failed', subject: 'S', body: 'B', error: 'Gmail send failed (400): invalid To header' }
})

describe("action: 'retry'", () => {
  it('puts a failed message back in review and clears its error', async () => {
    const res = await patch({ action: 'retry' })

    expect(res.status).toBe(200)
    expect(updateMock).toHaveBeenCalledWith(expect.anything(), 'user-1', 'msg-1', { status: 'pending_review', error: null })
  })

  it.each(['pending_review', 'approved', 'skipped'] as const)('refuses to retry a %s message', async (status) => {
    existing = { ...existing, status }
    const res = await patch({ action: 'retry' })
    expect(res.status).toBe(409)
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('a sent message cannot be touched at all', async () => {
    existing = { ...existing, status: 'sent' }
    expect((await patch({ action: 'retry' })).status).toBe(409)
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('does not approve it: the human still has to send it', async () => {
    await patch({ action: 'retry' })
    const fields = updateMock.mock.calls[0][3]
    expect(fields.status).toBe('pending_review')
  })
})

it('a failed message can still be edited before it is retried', async () => {
  const res = await patch({ subject: 'Fixed subject' })
  expect(res.status).toBe(200)
  expect(updateMock).toHaveBeenCalledWith(expect.anything(), 'user-1', 'msg-1', { subject: 'Fixed subject' })
})
