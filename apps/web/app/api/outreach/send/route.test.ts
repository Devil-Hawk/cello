// POST /api/outreach/send: what an expired session token, a rejected token and a
// failed bookkeeping write used to do to a perfectly good draft:
//   - sending used the one-hour session token only; it now prefers the stored
//     refresh token and falls back to the session token,
//   - a credential problem (nothing delivered) no longer marks the draft failed,
//   - a failure to RECORD a send that Gmail accepted is not reported as a failed
//     send, which invited a second delivery of the same email,
//   - a follow-up is suppressed from replied_at without asking Gmail.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { OutreachMessageRow } from '@/lib/outreach/types'

let user: { id: string; email: string; identities?: { provider: string }[] } | null
let session: { provider_token?: string | null } | null

const supabase = {
  auth: {
    getUser: async () => ({ data: { user }, error: null }),
    getSession: async () => ({ data: { session }, error: null }),
  },
  from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { full_name: 'Alex Candidate' } }) }) }) }),
}
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabase }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({}) }))

const SEND_ON = {
  gmail_permissions: {
    send: { enabled: true, grantedAt: '2026-10-01T00:00:00Z', revokedAt: null, migratedFrom: null },
    readShared: { enabled: false, grantedAt: null, revokedAt: null, migratedFrom: null },
    monitor: { enabled: false, grantedAt: null, revokedAt: null, migratedFrom: null },
  },
}
vi.mock('@/lib/harness/keys', () => ({
  readProfileForDemoGuards: async () => ({
    row: { preferences: SEND_ON, is_demo: false, demo_expires_at: null },
    error: null,
  }),
}))
vi.mock('@/lib/outreach/config', () => ({
  readOutreachConfig: async () => ({ prefs: { autoSend: false, dailyCap: 10, followUpDays: 5 }, userId: 'user-1' }),
}))

let rows: Record<string, OutreachMessageRow>
const updateOutreachMock = vi.fn(async (..._args: unknown[]) => ({}) as OutreachMessageRow)
vi.mock('@/lib/outreach/store', () => ({
  getOutreach: async (_c: unknown, _u: string, id: string) => rows[id] ?? null,
  updateOutreach: (...args: unknown[]) => updateOutreachMock(...args),
  countSentToday: async () => 0,
}))

const resolveTokenMock = vi.fn()
vi.mock('@/lib/gmail/token', () => ({
  resolveGmailAccessToken: (...args: unknown[]) => resolveTokenMock(...args),
}))

const sendGmailMessageMock = vi.fn()
const threadHasReplyMock = vi.fn()
vi.mock('@/lib/outreach/gmail', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/outreach/gmail')>()),
  sendGmailMessage: (...args: unknown[]) => sendGmailMessageMock(...args),
  threadHasReply: (...args: unknown[]) => threadHasReplyMock(...args),
}))
vi.mock('@/lib/observability/log', () => ({ logApiError: vi.fn() }))

import { POST } from './route'
import { GmailSendError, REPLY_CHECK_UNKNOWN_MESSAGE } from '@/lib/outreach/gmail'

function row(over: Partial<OutreachMessageRow>): OutreachMessageRow {
  return {
    id: 'msg-1',
    user_id: 'user-1',
    contact_id: 'c1',
    job_id: 'j1',
    company_id: 'co1',
    run_id: null,
    to_email: 'jordan@acme.com',
    to_name: 'Jordan',
    subject: 'Staff Engineer at Acme',
    body: 'Hello',
    status: 'pending_review',
    kind: 'initial',
    parent_id: null,
    gmail_message_id: null,
    gmail_thread_id: null,
    error: null,
    sent_at: null,
    replied_at: null,
    reply_gmail_message_id: null,
    reply_classification: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...over,
  }
}

function post(body: unknown) {
  return new NextRequest('http://localhost/api/outreach/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  user = { id: 'user-1', email: 'alex@example.com', identities: [{ provider: 'google' }] }
  session = { provider_token: 'session-token' }
  rows = { 'msg-1': row({}) }
  resolveTokenMock.mockResolvedValue({ ok: true, accessToken: 'stored-token' })
  sendGmailMessageMock.mockResolvedValue({ id: 'gm-1', threadId: 'th-1' })
  threadHasReplyMock.mockResolvedValue('none')
  updateOutreachMock.mockResolvedValue(row({ status: 'sent' }))
})

describe('the Gmail credential', () => {
  it('sends with the token the resolver returns (stored refresh token first), passing the session token as the fallback', async () => {
    const res = await POST(post({ id: 'msg-1', approve: true }))

    expect(res.status).toBe(200)
    expect(resolveTokenMock).toHaveBeenCalledWith(supabase, 'user-1', SEND_ON, 'session-token')
    expect(sendGmailMessageMock).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'stored-token' }))
  })

  it('still sends when there is no session token at all, because the stored refresh token covers it', async () => {
    session = null
    const res = await POST(post({ id: 'msg-1', approve: true }))
    expect(res.status).toBe(200)
    expect(resolveTokenMock).toHaveBeenCalledWith(supabase, 'user-1', SEND_ON, undefined)
  })

  it('answers 401 needsReauth, sends nothing and leaves the draft alone when no credential works', async () => {
    resolveTokenMock.mockResolvedValue({ ok: false, message: 'Gmail access not available. Connect Gmail in Settings to enable this.' })

    const res = await POST(post({ id: 'msg-1', approve: true }))
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.needsReauth).toBe(true)
    expect(sendGmailMessageMock).not.toHaveBeenCalled()
    expect(updateOutreachMock).not.toHaveBeenCalled()
  })

  it('tells an email/password user that Gmail needs a Google sign-in, not to reconnect Gmail', async () => {
    user = { id: 'user-1', email: 'alex@example.com', identities: [{ provider: 'email' }] }
    resolveTokenMock.mockResolvedValue({ ok: false, message: 'Gmail access not available.' })

    const res = await POST(post({ id: 'msg-1', approve: true }))
    const body = await res.json()

    expect(body.error).toMatch(/Google sign-in/)
  })
})

describe('what a failed send does to the draft', () => {
  it('a rejected token (Gmail 401) keeps the draft sendable: not marked failed, needsReauth returned', async () => {
    sendGmailMessageMock.mockRejectedValue(new GmailSendError('Gmail send failed (401): invalid credentials', 401))

    const res = await POST(post({ id: 'msg-1', approve: true }))
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.needsReauth).toBe(true)
    expect(updateOutreachMock).not.toHaveBeenCalled()
  })

  it('a message-level refusal marks the draft failed with Gmail\'s own words, so the card can show and retry it', async () => {
    sendGmailMessageMock.mockRejectedValue(new GmailSendError('Gmail send failed (400): invalid To header', 400))

    const res = await POST(post({ id: 'msg-1', approve: true }))

    expect(res.status).toBe(502)
    expect(updateOutreachMock).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'msg-1',
      expect.objectContaining({ status: 'failed', error: expect.stringContaining('invalid To header') })
    )
  })

  it('a send Gmail accepted but Cello could not record is reported as sent with a warning, never as failed', async () => {
    updateOutreachMock.mockRejectedValue(new Error('updateOutreach failed: connection reset'))

    const res = await POST(post({ id: 'msg-1', approve: true }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.warning).toMatch(/Do not send it again/)
    // The only write attempted was the 'sent' one; nothing tried to mark it failed.
    expect(updateOutreachMock).toHaveBeenCalledTimes(1)
    expect(updateOutreachMock).toHaveBeenCalledWith(expect.anything(), 'user-1', 'msg-1', expect.objectContaining({ status: 'sent' }))
  })
})

describe('follow-ups', () => {
  beforeEach(() => {
    rows = {
      'parent-1': row({ id: 'parent-1', status: 'sent', sent_at: '2026-09-01T00:00:00Z', gmail_thread_id: 'th-0' }),
      'msg-1': row({ kind: 'follow_up', parent_id: 'parent-1' }),
    }
  })

  it('is suppressed from the parent\'s replied_at without asking Gmail', async () => {
    rows['parent-1'] = { ...rows['parent-1'], replied_at: '2026-09-03T00:00:00Z' }

    const res = await POST(post({ id: 'msg-1', approve: true }))
    const body = await res.json()

    expect(body).toMatchObject({ ok: false, skipped: true })
    expect(threadHasReplyMock).not.toHaveBeenCalled()
    expect(sendGmailMessageMock).not.toHaveBeenCalled()
  })

  it('asks Gmail with the resolved token and sends into the parent thread when there is no reply', async () => {
    const res = await POST(post({ id: 'msg-1', approve: true }))

    expect(res.status).toBe(200)
    expect(threadHasReplyMock).toHaveBeenCalledWith('stored-token', 'th-0', 'alex@example.com')
    expect(sendGmailMessageMock).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'th-0' }))
  })

  it('does not call a Gmail 403 on the thread "already replied": the draft stays pending and the user is told what is missing', async () => {
    const realFetch = global.fetch
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'insufficient scopes' }) as unknown as typeof fetch
    const actual = await vi.importActual<typeof import('@/lib/outreach/gmail')>('@/lib/outreach/gmail')
    threadHasReplyMock.mockImplementation(actual.threadHasReply)
    try {
      const res = await POST(post({ id: 'msg-1', approve: true }))
      const body = await res.json()

      expect(res.status).toBe(403)
      expect(body.error).toBe(REPLY_CHECK_UNKNOWN_MESSAGE)
      expect(body.skipped).toBeUndefined()
      expect(updateOutreachMock).not.toHaveBeenCalled()
      expect(sendGmailMessageMock).not.toHaveBeenCalled()
    } finally {
      global.fetch = realFetch
    }
  })
})
