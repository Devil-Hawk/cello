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

function fakeGmail(threads: Record<string, GmailMessage[]>, address = 'alex@example.com') {
  global.fetch = vi.fn(async (url: string | URL | Request) => {
    const u = String(url)
    if (u.endsWith('/users/me/profile')) return { ok: true, json: async () => ({ emailAddress: address }) } as Response
    const m = u.match(/threads\/([^?]+)/)
    const found = m ? threads[decodeURIComponent(m[1])] : undefined
    return found ? ({ ok: true, json: async () => ({ messages: found }) } as Response) : ({ ok: false, status: 404 } as Response)
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

describe('replies are read from what the person wrote', () => {
  const QUOTE = '\n\nOn Tue, Oct 6, 2026 at 9:00 AM Alex <alex@example.com> wrote:\n> Would you be open to a chat about the role?'
  const withBody = (body: string) =>
    msg('m1', 'Jordan <jordan@acme.com>', 'Re: Staff Engineer at Acme - quick note', '2000', ['INBOX'], body)

  it('"Happy to chat, are you free Tuesday?" above a quoted original is positive, not neutral', async () => {
    fakeGmail({ 'th-1': [SENT, withBody(`Happy to chat, are you free Tuesday?${QUOTE}`)] })
    await syncOutreachReplies({ admin: fakeAdmin([{ gmail_thread_id: 'th-1' }]), userId: 'user-1', accessToken: 'tok' })
    expect(recordOutreachReplyMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ classification: 'positive' }))
  })

  it('"No thanks" above a quote containing "would you be open to a chat" is negative', async () => {
    fakeGmail({ 'th-1': [SENT, withBody(`No thanks.${QUOTE}`)] })
    await syncOutreachReplies({ admin: fakeAdmin([{ gmail_thread_id: 'th-1' }]), userId: 'user-1', accessToken: 'tok' })
    expect(recordOutreachReplyMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ classification: 'negative' }))
  })

  it('"We are not hiring for this right now" is negative', async () => {
    fakeGmail({ 'th-1': [SENT, withBody('We are not hiring for this right now.')] })
    await syncOutreachReplies({ admin: fakeAdmin([{ gmail_thread_id: 'th-1' }]), userId: 'user-1', accessToken: 'tok' })
    expect(recordOutreachReplyMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ classification: 'negative' }))
  })

  it('an out-of-office is skipped: nothing is recorded, so replied_at stays null and the follow-up stays open', async () => {
    const auto = {
      ...msg('m5', 'Jordan <jordan@acme.com>', 'Automatic reply: Staff Engineer at Acme', '2000'),
    }
    auto.payload.headers.push({ name: 'Auto-Submitted', value: 'auto-replied' })
    fakeGmail({ 'th-1': [SENT, auto] })

    const n = await syncOutreachReplies({ admin: fakeAdmin([{ gmail_thread_id: 'th-1' }]), userId: 'user-1', accessToken: 'tok' })

    expect(n).toBe(0)
    expect(recordOutreachReplyMock).not.toHaveBeenCalled()
  })

  it('a human reply that arrives after an out-of-office is the one recorded', async () => {
    const auto = msg('m5', 'Jordan <jordan@acme.com>', 'Out of office', '1500')
    const human = withBody('Back now. Happy to chat, are you free Friday?')
    human.internalDate = '3000'
    fakeGmail({ 'th-1': [SENT, auto, human] })

    await syncOutreachReplies({ admin: fakeAdmin([{ gmail_thread_id: 'th-1' }]), userId: 'user-1', accessToken: 'tok' })

    expect(recordOutreachReplyMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ gmailMessageId: 'm1', classification: 'positive' }))
  })

  it('a bounce that carries Auto-Submitted is still recorded as a bounce, not skipped as an auto-reply', async () => {
    const bounce = msg('m9', 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', 'Delivery Status Notification (Failure)', '2000')
    bounce.payload.headers.push({ name: 'Auto-Submitted', value: 'auto-replied' })
    fakeGmail({ 'th-1': [SENT, bounce] })

    await syncOutreachReplies({ admin: fakeAdmin([{ gmail_thread_id: 'th-1' }]), userId: 'user-1', accessToken: 'tok' })

    expect(recordOutreachReplyMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ classification: 'bounce' }))
  })
})
