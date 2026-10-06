// The raw-mail path: format=raw through the Gmail client, parsed with postal-mime.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractBody, fetchGmailMessages, getHeader } from './gmail-api'

const ORIGINAL_FETCH = global.fetch
afterEach(() => {
  global.fetch = ORIGINAL_FETCH
})

// A nested multipart message: a quoted-printable ISO-8859-1 text part inside multipart/alternative,
// inside multipart/mixed with an invite, plus the Authentication-Results header the old reader dropped.
const MIME = [
  'Authentication-Results: mx.google.com; dkim=pass header.i=@acme.com; spf=pass',
  'From: =?UTF-8?Q?Jos=C3=A9_Recruiter?= <jose@acme.com>',
  'Subject: =?UTF-8?Q?Interview_with_Acme_=E2=80=93_next_steps?=',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="outer"',
  '',
  '--outer',
  'Content-Type: multipart/alternative; boundary="inner"',
  '',
  '--inner',
  'Content-Type: text/plain; charset=ISO-8859-1',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Hi, caf=E9 chat on Tuesday. Bring your r=E9sum=E9.',
  '--inner',
  'Content-Type: text/html; charset=UTF-8',
  '',
  '<p>html</p>',
  '--inner--',
  '--outer',
  'Content-Type: text/calendar; method=REQUEST; charset=UTF-8',
  '',
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'DTSTART:20261020T180000Z',
  'END:VEVENT',
  'END:VCALENDAR',
  '--outer--',
  '',
].join('\r\n')

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('fetchGmailMessages reads raw mail', () => {
  it('decodes nested multipart quoted-printable text, keeps Authentication-Results and finds the invite', async () => {
    const urls: string[] = []
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('/messages/m1')) {
        return json({ id: 'm1', threadId: 't1', labelIds: ['INBOX'], snippet: 'Hi', internalDate: '1790000000000', raw: Buffer.from(MIME).toString('base64url') })
      }
      return json({ messages: [{ id: 'm1', threadId: 't1' }] })
    }) as unknown as typeof fetch

    const [msg] = await fetchGmailMessages('tok', 'interview', 5)

    expect(urls.some((u) => u.includes('format=raw'))).toBe(true)
    expect(extractBody(msg.payload)).toBe('Hi, café chat on Tuesday. Bring your résumé.')
    expect(getHeader(msg.payload.headers, 'authentication-results')).toContain('dkim=pass')
    expect(getHeader(msg.payload.headers, 'subject')).toBe('Interview with Acme – next steps')
    expect(getHeader(msg.payload.headers, 'from')).toBe('José Recruiter <jose@acme.com>')
    expect(msg.payload.calendar).toContain('DTSTART:20261020T180000Z')
    expect(msg).toMatchObject({ id: 'm1', threadId: 't1', labelIds: ['INBOX'], internalDate: '1790000000000' })
  })

  it('skips a message Gmail will not give and keeps the rest', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/messages/bad')) return json({ error: { code: 404, message: 'Not Found' } }, 404)
      if (url.includes('/messages/m1')) return json({ id: 'm1', threadId: 't1', raw: Buffer.from(MIME).toString('base64url') })
      return json({ messages: [{ id: 'bad', threadId: 't0' }, { id: 'm1', threadId: 't1' }] })
    }) as unknown as typeof fetch

    expect((await fetchGmailMessages('tok', 'q', 5)).map((m) => m.id)).toEqual(['m1'])
  })

  it('says why a search failed', async () => {
    global.fetch = vi.fn(async () => json({ error: { code: 401, message: 'Invalid Credentials' } }, 401)) as unknown as typeof fetch
    await expect(fetchGmailMessages('tok', 'q', 5)).rejects.toThrow(/Gmail search failed: Invalid Credentials/)
  })
})
