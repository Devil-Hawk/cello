// Thin Gmail REST helpers: fetch/parse messages. No Supabase/DB concerns here.

import { gmail, type gmail_v1 } from '@googleapis/gmail'
import { OAuth2Client } from 'google-auth-library'
import PostalMime from 'postal-mime'
import type { GmailMessage } from './types'

/**
 * Search query for job-application-related email. Tightened from the old
 * broad `OR from:(... OR noreply)` (which matched almost anything) to
 * require an actual job-application signal in the subject, or a
 * careers/recruiting-looking sender paired with an application-shaped
 * subject — and excludes bulk mail categories.
 */
export const JOB_EMAIL_QUERY = [
  '(',
  'subject:(application OR "thank you for applying" OR "thanks for applying" OR "we received your application"',
  'OR "your application" OR "application status" OR interview OR "phone screen" OR onsite OR "next steps"',
  'OR offer OR "job offer" OR rejected OR "not moving forward" OR "moved forward with other")',
  'OR',
  '(from:(careers OR recruiting OR talent OR jobs OR hr OR hiring) subject:(application OR interview OR position OR role OR candidate OR offer))',
  ')',
  '-category:promotions -category:social -category:forums',
  '-subject:(newsletter OR digest OR unsubscribe OR webinar OR "% off" OR sale)',
].join(' ')

export function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/')
  try {
    return Buffer.from(base64, 'base64').toString('utf-8')
  } catch {
    return ''
  }
}

export function extractBody(payload: GmailMessage['payload']): string {
  // A raw read has already decoded every MIME layer; the walk below is for the
  // older shape (base64url `body.data`) that tests and `format=full` mail still use.
  if (payload.text !== undefined) return payload.text
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBase64Url(part.body.data)
      }
    }
    for (const part of payload.parts) {
      if (part.body?.data) return decodeBase64Url(part.body.data)
    }
  }
  if (payload.body?.data) return decodeBase64Url(payload.body.data)
  return ''
}

export function getHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  const header = headers.find((h) => h.name.toLowerCase() === name.toLowerCase())
  return header?.value || ''
}

export function extractDomain(email: string): string | null {
  const match = email.match(/@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/)
  return match ? match[1].toLowerCase() : null
}

/**
 * One Gmail client on the person's access token. gaxios loads node-fetch unless it
 * is handed a fetch, so it gets the global one, looked up per call (Node's own
 * client, and a test can stub it).
 * ponytail: no retries. gaxios would re-POST a send on a 5xx and could mail twice;
 * a failed read fails the sync as it always did and the next sync tries again.
 */
export const GOOGLE_TRANSPORT = {
  fetchImplementation: ((input, init) => globalThis.fetch(input, init)) as typeof fetch,
  retryConfig: { retry: 0, noResponseRetries: 0 },
}

export function googleAuthClient(credentials: { clientId?: string; clientSecret?: string } = {}): OAuth2Client {
  return new OAuth2Client({ ...credentials, transporterOptions: GOOGLE_TRANSPORT })
}

export function gmailFor(accessToken: string): gmail_v1.Gmail {
  const auth = googleAuthClient()
  auth.setCredentials({ access_token: accessToken })
  // ponytail: @googleapis/gmail ships its own google-auth-library (10.5.0), so the client type differs from ours in a private field; same shape at runtime. Drop the cast when the two versions meet.
  return gmail({ version: 'v1', auth: auth as unknown as gmail_v1.Options['auth'] })
}

/** The HTTP status of a failed Gmail call (gaxios keeps it on the error), or undefined for a network failure. */
export function gmailErrorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown })?.status
  return typeof status === 'number' ? status : undefined
}

function setHeader(headers: GmailMessage['payload']['headers'], name: string, value: string | undefined) {
  if (!value) return
  const existing = headers.find((h) => h.name.toLowerCase() === name.toLowerCase())
  if (existing) existing.value = value
  else headers.push({ name, value })
}

/** One raw Gmail message parsed with postal-mime. Every header is kept (Authentication-Results too). */
async function readRawMessage(g: gmail_v1.Gmail, id: string): Promise<GmailMessage> {
  const { data } = await g.users.messages.get({ userId: 'me', id, format: 'raw' })
  const mail = await PostalMime.parse(Buffer.from(data.raw ?? '', 'base64url'))
  const headers = mail.headers.map((h) => ({ name: h.originalKey, value: h.value }))
  // postal-mime leaves header values as sent; Gmail's own were decoded, so the two the callers read are put back decoded.
  setHeader(headers, 'Subject', mail.subject)
  setHeader(headers, 'From', mail.from?.address ? (mail.from.name ? `${mail.from.name} <${mail.from.address}>` : mail.from.address) : undefined)
  const invite = mail.attachments.find((a) => a.mimeType === 'text/calendar')
  return {
    id: data.id ?? id,
    threadId: data.threadId ?? '',
    labelIds: data.labelIds ?? undefined,
    snippet: data.snippet ?? '',
    internalDate: data.internalDate ?? '',
    payload: {
      headers,
      text: mail.text ?? mail.html ?? '',
      calendar: invite ? (typeof invite.content === 'string' ? invite.content : new TextDecoder().decode(invite.content)) : undefined,
    },
  }
}

export async function fetchGmailMessages(
  accessToken: string,
  query: string,
  maxResults = 500
): Promise<GmailMessage[]> {
  const g = gmailFor(accessToken)
  const allMessageIds: Array<{ id: string }> = []
  let pageToken: string | undefined

  while (allMessageIds.length < maxResults) {
    let page: gmail_v1.Schema$ListMessagesResponse
    try {
      page = (await g.users.messages.list({ userId: 'me', q: query, maxResults: Math.min(100, maxResults - allMessageIds.length), pageToken })).data
    } catch (error) {
      throw new Error(`Gmail search failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    allMessageIds.push(...((page.messages ?? []) as Array<{ id: string }>))

    pageToken = page.nextPageToken ?? undefined
    if (!pageToken) break
  }

  const messages: GmailMessage[] = []
  const batchSize = 10

  for (let i = 0; i < Math.min(allMessageIds.length, maxResults); i += batchSize) {
    const batch = allMessageIds.slice(i, i + batchSize)
    const batchResults = await Promise.all(
      // A message that cannot be read is skipped; it is not marked scanned, so the next sync tries it again.
      batch.map(({ id }) => readRawMessage(g, id).catch(() => null))
    )
    messages.push(...batchResults.filter((m): m is GmailMessage => m !== null))
  }

  return messages
}

/** Every message in one Gmail thread, oldest first, or null when the thread cannot be read.
 *  threads.get has no raw format, so it gives the ids and each message is read raw. */
export async function fetchGmailThread(accessToken: string, threadId: string): Promise<GmailMessage[] | null> {
  const g = gmailFor(accessToken)
  try {
    const { data } = await g.users.threads.get({ userId: 'me', id: threadId, format: 'minimal' })
    return await Promise.all((data.messages ?? []).map((m) => readRawMessage(g, m.id as string)))
  } catch {
    return null
  }
}

const THREAD_HEADERS = ['From', 'To', 'Cc', 'Reply-To', 'Date', 'Subject', 'List-Id', 'List-Unsubscribe', 'Precedence', 'Auto-Submitted']
/** ponytail: the newest 100 messages of a thread; a 300-message thread is read as one capped page. */
const THREAD_MESSAGE_CAP = 100

export interface ThreadHeaders {
  id: string
  messages: { id: string; internalDate: string; headers: Array<{ name: string; value: string }> }[]
}

/** One thread's headers only (format=metadata): no body is read. Null when it cannot be read. */
export async function fetchThreadHeaders(accessToken: string, threadId: string): Promise<ThreadHeaders | null> {
  try {
    const { data } = await gmailFor(accessToken).users.threads.get({ userId: 'me', id: threadId, format: 'metadata', metadataHeaders: THREAD_HEADERS })
    const messages = (data.messages ?? []).slice(-THREAD_MESSAGE_CAP).map((m) => ({
      id: m.id ?? '',
      internalDate: m.internalDate ?? '',
      headers: (m.payload?.headers ?? []).map((h) => ({ name: h.name ?? '', value: h.value ?? '' })),
    }))
    return { id: threadId, messages: messages.filter((m) => m.id) }
  } catch {
    return null
  }
}

/** Thread ids of a search, newest first, at most `max`. */
export async function listThreadIds(accessToken: string, query: string, max: number): Promise<string[]> {
  try {
    const { data } = await gmailFor(accessToken).users.threads.list({ userId: 'me', q: query, maxResults: Math.min(max, 100) })
    return (data.threads ?? []).map((t) => t.id ?? '').filter(Boolean)
  } catch {
    return []
  }
}

/** Every address the mailbox sends as (gmail.readonly reads it), so an alias counts as "you". */
export async function fetchSendAs(accessToken: string): Promise<string[]> {
  try {
    const { data } = await gmailFor(accessToken).users.settings.sendAs.list({ userId: 'me' })
    return (data.sendAs ?? []).map((s) => (s.sendAsEmail ?? '').toLowerCase()).filter(Boolean)
  } catch {
    return []
  }
}

/** The mailbox's own address (needs gmail.readonly, which the sync already holds), or null. */
export async function fetchGmailAddress(accessToken: string): Promise<string | null> {
  try {
    const { data } = await gmailFor(accessToken).users.getProfile({ userId: 'me' })
    return data.emailAddress ? data.emailAddress.toLowerCase() : null
  } catch {
    return null
  }
}
