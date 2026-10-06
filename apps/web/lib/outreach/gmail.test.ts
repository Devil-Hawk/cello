import { afterEach, describe, expect, it, vi } from 'vitest'
import { GmailSendError, isGmailAuthError, sendGmailMessage, threadHasReply } from './gmail'

const ORIGINAL_FETCH = global.fetch
afterEach(() => {
  global.fetch = ORIGINAL_FETCH
})

const input = {
  accessToken: 'tok',
  toEmail: 'jordan@acme.com',
  fromName: 'Alex',
  fromEmail: 'alex@example.com',
  subject: 'Hello',
  body: 'Body',
}

function gmailAnswers(status: number, text: string) {
  global.fetch = vi.fn().mockResolvedValue(new Response(text, { status })) as unknown as typeof fetch
}

describe('sendGmailMessage failures keep the HTTP status', () => {
  it('throws a GmailSendError carrying the status', async () => {
    gmailAnswers(401, 'invalid credentials')
    const err = await sendGmailMessage(input).catch((e) => e)
    expect(err).toBeInstanceOf(GmailSendError)
    expect(err.status).toBe(401)
    expect(err.message).toContain('401')
  })
})

describe('isGmailAuthError: is it the credential or the message?', () => {
  it.each([
    [401, 'invalid credentials', true],
    [403, 'Request had insufficient authentication scopes.', true],
    [403, 'Rate limit exceeded', false],
    [400, 'Invalid To header', false],
    [500, 'backend error', false],
  ])('%i %s -> %s', (status, text, expected) => {
    expect(isGmailAuthError(new GmailSendError(`Gmail send failed (${status}): ${text}`, status))).toBe(expected)
  })

  it('is false for anything that is not a Gmail send error', () => {
    expect(isGmailAuthError(new Error('Gmail send failed (401)'))).toBe(false)
    expect(isGmailAuthError(null)).toBe(false)
  })
})

describe('threadHasReply is tri-state', () => {
  const thread = (froms: string[]) =>
    new Response(JSON.stringify({ messages: froms.map((f) => ({ payload: { headers: [{ name: 'From', value: f }] } })) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

  it.each([401, 403, 500])('is unknown, never replied, when Gmail answers %i', async (status) => {
    gmailAnswers(status, 'nope')
    expect(await threadHasReply('tok', 'th', 'alex@example.com')).toBe('unknown')
  })

  it('is replied when someone other than the user wrote in the thread', async () => {
    global.fetch = vi.fn().mockResolvedValue(thread(['Alex <alex@example.com>', 'Jordan <jordan@acme.com>'])) as unknown as typeof fetch
    expect(await threadHasReply('tok', 'th', 'alex@example.com')).toBe('replied')
  })

  it('is none when only the user wrote', async () => {
    global.fetch = vi.fn().mockResolvedValue(thread(['Alex <alex@example.com>'])) as unknown as typeof fetch
    expect(await threadHasReply('tok', 'th', 'alex@example.com')).toBe('none')
  })
})
