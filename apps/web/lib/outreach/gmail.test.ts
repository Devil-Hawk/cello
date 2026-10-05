import { afterEach, describe, expect, it, vi } from 'vitest'
import { GmailSendError, isGmailAuthError, sendGmailMessage } from './gmail'

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
  global.fetch = vi.fn().mockResolvedValue({ ok: false, status, text: async () => text }) as unknown as typeof fetch
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
