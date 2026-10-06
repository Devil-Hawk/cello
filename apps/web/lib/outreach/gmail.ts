// Gmail helpers for cold outreach.
//
// Sending goes through the user's OWN Gmail account via the Gmail API (no paid
// vendor, no spoofing — From is the authenticated account). Framework-free (the Gmail client on the
// global fetch), so this is safe to import from both request handlers and the harness.

import { gmailErrorStatus, gmailFor } from '@/lib/gmail/gmail-api'

export interface GmailSendInput {
  accessToken: string
  toEmail: string
  toName?: string | null
  fromName: string
  fromEmail: string
  subject: string
  body: string
  /** For a follow-up: keep it in the same thread. */
  threadId?: string | null
  inReplyToMessageId?: string | null
}

export interface GmailSendResult {
  id: string
  threadId: string
}

/** A non-2xx answer from Gmail's send endpoint, with the HTTP status kept so a caller can tell a bad token from a refused message. */
export class GmailSendError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'GmailSendError'
  }
}

/**
 * True when a send failed because the credential is unusable (expired or
 * under-scoped token), not because of the message. Nothing was delivered and
 * nothing is wrong with the draft, so the caller keeps it sendable and asks
 * the user to reconnect instead of burning it as failed.
 */
export function isGmailAuthError(err: unknown): boolean {
  if (!(err instanceof GmailSendError)) return false
  return err.status === 401 || (err.status === 403 && /insufficient|scope|permission/i.test(err.message))
}

/** RFC 2047 encoded-word for non-ASCII header values (subject / display name). */
function encodeHeaderWord(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value
  const b64 = Buffer.from(value, 'utf-8').toString('base64')
  return `=?UTF-8?B?${b64}?=`
}

function base64Url(input: string): string {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function formatAddress(email: string, name?: string | null): string {
  if (!name) return email
  return `${encodeHeaderWord(name)} <${email}>`
}

/** Build a MIME message and send it from the authenticated Gmail account. */
export async function sendGmailMessage(input: GmailSendInput): Promise<GmailSendResult> {
  const headers = [
    `From: ${formatAddress(input.fromEmail, input.fromName)}`,
    `To: ${formatAddress(input.toEmail, input.toName)}`,
    `Subject: ${encodeHeaderWord(input.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ]
  if (input.inReplyToMessageId) {
    headers.push(`In-Reply-To: ${input.inReplyToMessageId}`)
    headers.push(`References: ${input.inReplyToMessageId}`)
  }
  const raw = base64Url(`${headers.join('\r\n')}\r\n\r\n${input.body}`)

  try {
    const { data } = await gmailFor(input.accessToken).users.messages.send({
      userId: 'me',
      requestBody: input.threadId ? { raw, threadId: input.threadId } : { raw },
    })
    return { id: data.id as string, threadId: data.threadId as string }
  } catch (error) {
    const status = gmailErrorStatus(error)
    if (status === undefined) throw error
    throw new GmailSendError(`Gmail send failed (${status}): ${(error as Error).message.slice(0, 300)}`, status)
  }
}

interface GmailHeader { name: string; value: string }

/** A message's headers in the shape getHeader reads (Gmail marks every field optional). */
function headersOf(message: { payload?: { headers?: { name?: string | null; value?: string | null }[] } | null }): GmailHeader[] {
  return (message.payload?.headers ?? []).map((h) => ({ name: h.name ?? '', value: h.value ?? '' }))
}

function getHeader(headers: GmailHeader[], name: string): string {
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase())
  return h?.value || ''
}

/** "Jane Doe <jane@acme.com>" -> { name, email } */
export function parseFromHeader(from: string): { name: string | null; email: string | null } {
  const angle = from.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/)
  if (angle) {
    const name = (angle[1] || '').trim()
    return { name: name || null, email: angle[2].trim().toLowerCase() }
  }
  const bare = from.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)
  return { name: null, email: bare ? bare[0].toLowerCase() : null }
}

/** What a thread check found: someone else wrote, nobody did, or Gmail would not say. */
export type ReplyState = 'replied' | 'none' | 'unknown'

/**
 * Whether the given Gmail thread has an inbound reply, i.e. a message From
 * someone other than the user, so we never follow up after a reply.
 *
 * Tri-state on purpose. A non-OK answer means the reply state is UNKNOWN, not
 * "no reply" and not "replied": a send-only token 403s here (threads.get needs
 * gmail.readonly), an expired token 401s, and the API can 5xx. Callers must
 * fail closed on 'unknown' (do not draft or send) but must not tell the user the
 * contact replied, because that is false and hides the real fix.
 */
export async function threadHasReply(
  accessToken: string,
  threadId: string,
  userEmail: string
): Promise<ReplyState> {
  let data
  try {
    data = (await gmailFor(accessToken).users.threads.get({ userId: 'me', id: threadId, format: 'metadata', metadataHeaders: ['From'] })).data
  } catch (error) {
    const status = gmailErrorStatus(error)
    if (status === undefined) throw error
    console.warn('[outreach] reply check failed, reply state unknown', { status, threadId })
    return 'unknown'
  }
  const me = userEmail.toLowerCase()
  for (const m of data.messages || []) {
    const from = getHeader(headersOf(m), 'from')
    const { email } = parseFromHeader(from)
    if (email && email !== me) return 'replied'
  }
  return 'none'
}

/** What to tell the user when the reply state could not be read. */
export const REPLY_CHECK_UNKNOWN_MESSAGE =
  'Cello cannot see replies without the Monitor mailbox permission, so it will not draft or send a follow-up it cannot vet. Turn on "Monitor mailbox" in Settings > Connections.'
