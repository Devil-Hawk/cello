// Reply detection by thread. The old bridge only saw mail matching the
// job-application search, so ordinary replies and bounces were invisible, and
// the user's own sent message could be recorded as the "reply".

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GmailMessage } from '@/lib/gmail/types'

const recordOutreachReplyMock = vi.fn(async (..._args: unknown[]) => [{ id: 'row-1' }])
vi.mock('./store', () => ({ recordOutreachReply: (...args: unknown[]) => recordOutreachReplyMock(...args) }))
vi.mock('@/lib/observability/log', () => ({ logApiError: vi.fn() }))

import { pickInboundReply, syncOutreachReplies } from './reply'

const ORIGINAL_FETCH = global.fetch
afterEach(() => {
  global.fetch = ORIGINAL_FETCH
})

function msg(id: string, from: string, subject: string, internalDate: string, labelIds: string[] = ['INBOX'], body = ''): GmailMessage {
  return {
    id,
    threadId: 'th-1',
    labelIds,
    snippet: '',
    internalDate,
    payload: {
      headers: [
        { name: 'From', value: from },
        { name: 'Subject', value: subject },
      ],
      body: { data: Buffer.from(body).toString('base64url') },
    },
  }
}

const SENT = msg('m0', 'Alex <alex@example.com>', 'Staff Engineer at Acme - quick note', '1000', ['SENT'])
const REPLY = msg('m1', 'Jordan <jordan@acme.com>', 'Re: Staff Engineer at Acme - quick note', '2000')

describe('pickInboundReply', () => {
  it('finds a human reply whose subject has none of the job-application keywords', () => {
    expect(pickInboundReply([SENT, REPLY], 'alex@example.com')?.id).toBe('m1')
  })

  it('THE FALSE POSITIVE: the user\'s own message alone is not a reply, by SENT label or by address', () => {
    expect(pickInboundReply([SENT], null)).toBeNull()
    const noLabel = msg('m0', 'Alex <alex@example.com>', 'Offer follow-up: Application', '1000', ['INBOX'])
    expect(pickInboundReply([noLabel], 'alex@example.com')).toBeNull()
    // The address match is case-insensitive.
    expect(pickInboundReply([noLabel], 'ALEX@example.com')).toBeNull()
  })

  it('takes the EARLIEST inbound message when several arrived', () => {
    const later = msg('m2', 'Jordan <jordan@acme.com>', 'Re: again', '3000')
    expect(pickInboundReply([later, REPLY, SENT], 'alex@example.com')?.id).toBe('m1')
  })

  it('returns null for a thread with only the user\'s messages', () => {
    expect(pickInboundReply([SENT, msg('m3', 'alex@example.com', 'second note', '1500', ['SENT'])], 'alex@example.com')).toBeNull()
  })

  it('reads a bare address in From (no display name)', () => {
    expect(pickInboundReply([msg('m4', 'alex@example.com', 's', '1', ['INBOX'])], 'alex@example.com')).toBeNull()
  })
})

// --- syncOutreachReplies: fake admin + fake Gmail -----------------------------

function fakeAdmin(threadRows: { gmail_thread_id: string }[]) {
  const builder: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'not', 'is', 'order']) builder[m] = () => builder
  builder.limit = async () => ({ data: threadRows })
  return { from: () => builder } as never
}

// The Gmail client answers: a thread lists its message ids, and each message is read raw.
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function rawOf(m: GmailMessage): string {
  const head = m.payload.headers.map((h) => `${h.name}: ${h.value}`).join('\r\n')
  const body = Buffer.from(m.payload.body?.data ?? '', 'base64url').toString()
  return Buffer.from(`${head}\r\n\r\n${body}`).toString('base64url')
}

function fakeGmail(threads: Record<string, GmailMessage[]>, address = 'alex@example.com') {
  global.fetch = vi.fn(async (url: string | URL | Request) => {
    const u = String(url)
    if (u.endsWith('/users/me/profile')) return json({ emailAddress: address })
    const t = u.match(/threads\/([^?]+)/)
    if (t) {
      const found = threads[decodeURIComponent(t[1])]
      return found ? json({ messages: found.map((m) => ({ id: m.id, threadId: m.threadId })) }) : json({ error: { code: 404, message: 'Not Found' } }, 404)
    }
    const one = u.match(/messages\/([^?]+)/)
    const m = one ? Object.values(threads).flat().find((x) => x.id === decodeURIComponent(one[1])) : undefined
    return m
      ? json({ id: m.id, threadId: m.threadId, labelIds: m.labelIds, snippet: m.snippet, internalDate: m.internalDate, raw: rawOf(m) })
      : json({ error: { code: 404, message: 'Not Found' } }, 404)
  }) as unknown as typeof fetch
}

beforeEach(() => {
  recordOutreachReplyMock.mockClear()
})

describe('syncOutreachReplies', () => {
  it('records the human reply on the tracked thread, found by thread id', async () => {
    fakeGmail({ 'th-1': [SENT, REPLY] })

    const n = await syncOutreachReplies({ admin: fakeAdmin([{ gmail_thread_id: 'th-1' }]), userId: 'user-1', accessToken: 'tok' })

    expect(n).toBe(1)
    expect(recordOutreachReplyMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 'user-1', gmailThreadId: 'th-1', gmailMessageId: 'm1', classification: 'neutral' })
    )
  })

  it('records nothing when the thread only has the user\'s own message', async () => {
    fakeGmail({ 'th-1': [SENT] })
    const n = await syncOutreachReplies({ admin: fakeAdmin([{ gmail_thread_id: 'th-1' }]), userId: 'user-1', accessToken: 'tok' })
    expect(n).toBe(0)
    expect(recordOutreachReplyMock).not.toHaveBeenCalled()
  })

  it('classifies a delivery failure from mailer-daemon as a bounce', async () => {
    const bounce = msg('m9', 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', 'Delivery Status Notification (Failure)', '2000')
    fakeGmail({ 'th-1': [SENT, bounce] })

    await syncOutreachReplies({ admin: fakeAdmin([{ gmail_thread_id: 'th-1' }]), userId: 'user-1', accessToken: 'tok' })

    expect(recordOutreachReplyMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ classification: 'bounce' }))
  })

  it('does not call Gmail at all when no sent thread is waiting for a reply', async () => {
    const spy = vi.fn()
    global.fetch = spy as unknown as typeof fetch
    expect(await syncOutreachReplies({ admin: fakeAdmin([]), userId: 'user-1', accessToken: 'tok' })).toBe(0)
    expect(spy).not.toHaveBeenCalled()
  })

  it('an unreadable thread is skipped, the others still run', async () => {
    fakeGmail({ 'th-2': [SENT, REPLY] })
    const n = await syncOutreachReplies({
      admin: fakeAdmin([{ gmail_thread_id: 'th-missing' }, { gmail_thread_id: 'th-2' }]),
      userId: 'user-1',
      accessToken: 'tok',
    })
    expect(n).toBe(1)
  })

  it('never throws: a Gmail failure must not fail the whole sync', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch
    await expect(
      syncOutreachReplies({ admin: fakeAdmin([{ gmail_thread_id: 'th-1' }]), userId: 'user-1', accessToken: 'tok' })
    ).resolves.toBe(0)
  })
})
