// POST /api/outreach/follow-up: the reply gate. A reply the sync already
// recorded (replied_at) must stop the draft with no Gmail call, and an unknown
// reply state (no usable token) must refuse rather than draft.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { OutreachMessageRow } from '@/lib/outreach/types'

let user: { id: string; email: string } | null
let session: { provider_token?: string | null } | null
let parent: Partial<OutreachMessageRow> | null

const supabase = {
  auth: {
    getUser: async () => ({ data: { user } }),
    getSession: async () => ({ data: { session } }),
  },
  from: () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      single: async () => ({ data: { preferences: {}, full_name: 'Alex', resume_text: 'r', title: 'Staff', match_details: null, name: 'Acme' } }),
    }
    return chain
  },
}
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabase }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/outreach/config', () => ({
  readOutreachConfig: async () => ({ prefs: { autoSend: false, dailyCap: 10, followUpDays: 5 }, userId: 'user-1' }),
}))

const insertOutreachMock = vi.fn(async (_c: unknown, row: Record<string, unknown>) => ({ id: 'fu-1', ...row }))
vi.mock('@/lib/outreach/store', () => ({
  getOutreach: async () => parent,
  findFollowUp: async () => null,
  insertOutreach: (...args: Parameters<typeof insertOutreachMock>) => insertOutreachMock(...args),
}))

const resolveTokenMock = vi.fn()
vi.mock('@/lib/gmail/token', () => ({ resolveGmailAccessToken: (...a: unknown[]) => resolveTokenMock(...a) }))
const threadHasReplyMock = vi.fn()
vi.mock('@/lib/outreach/gmail', () => ({ threadHasReply: (...a: unknown[]) => threadHasReplyMock(...a) }))

const runUnitOnceMock = vi.fn(async (..._a: unknown[]) => ({ output: { subject: 'Following up', body: 'Hi again', tokensUsed: 12 } }))
vi.mock('@/lib/graph/oneshot', () => ({ runUnitOnce: (...a: unknown[]) => runUnitOnceMock(...a) }))

import { POST } from './route'

const post = () =>
  POST(
    new NextRequest('http://localhost/api/outreach/follow-up', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentId: 'parent-1' }),
    })
  )

beforeEach(() => {
  vi.clearAllMocks()
  user = { id: 'user-1', email: 'alex@example.com' }
  session = { provider_token: 'session-token' }
  parent = {
    id: 'parent-1',
    status: 'sent',
    kind: 'initial',
    sent_at: '2026-09-01T00:00:00Z',
    gmail_thread_id: 'th-1',
    replied_at: null,
    to_email: 'jordan@acme.com',
    to_name: 'Jordan',
    contact_id: 'c1',
    job_id: null,
    company_id: null,
  }
  resolveTokenMock.mockResolvedValue({ ok: true, accessToken: 'stored-token' })
  threadHasReplyMock.mockResolvedValue(false)
})

describe('the reply gate', () => {
  it('stops at the replied_at the sync recorded, with no Gmail call and no draft', async () => {
    parent = { ...parent, replied_at: '2026-09-03T00:00:00Z' }

    const body = await (await post()).json()

    expect(body).toMatchObject({ ok: false, skipped: true, reason: 'contact already replied' })
    expect(threadHasReplyMock).not.toHaveBeenCalled()
    expect(runUnitOnceMock).not.toHaveBeenCalled()
  })

  it('refuses (fails closed) when no Gmail credential is usable, instead of drafting a chase it cannot vet', async () => {
    resolveTokenMock.mockResolvedValue({ ok: false, message: 'Gmail access not available.' })

    const res = await post()
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.needsReauth).toBe(true)
    expect(runUnitOnceMock).not.toHaveBeenCalled()
    expect(insertOutreachMock).not.toHaveBeenCalled()
  })

  it('checks the live thread with the resolved token and skips when the contact replied', async () => {
    threadHasReplyMock.mockResolvedValue(true)

    const body = await (await post()).json()

    expect(threadHasReplyMock).toHaveBeenCalledWith('stored-token', 'th-1', 'alex@example.com')
    expect(body).toMatchObject({ ok: false, skipped: true })
    expect(insertOutreachMock).not.toHaveBeenCalled()
  })

  it('drafts the follow-up into review when there is no reply, recording whether a model wrote it', async () => {
    const res = await (await post()).json()

    expect(res.ok).toBe(true)
    expect(insertOutreachMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'follow_up', parent_id: 'parent-1', status: 'pending_review', used_llm: true })
    )
  })
})
