// Gmail helpers for cold outreach + contact mining.
//
// Sending goes through the user's OWN Gmail account via the Gmail API (no paid
// vendor, no spoofing — From is the authenticated account). Contact mining reads
// the user's OWN mailbox headers only. Framework-free (global fetch), so this is
// safe to import from both request handlers and the harness.

import type { MinedContact } from './types'

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1'

const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'aol.com', 'protonmail.com', 'mail.com', 'live.com', 'msn.com',
])

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

  const res = await fetch(`${GMAIL_API}/users/me/messages/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input.threadId ? { raw, threadId: input.threadId } : { raw }),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Gmail send failed (${res.status}): ${detail.slice(0, 300)}`)
  }
  const data = (await res.json()) as { id: string; threadId: string }
  return { id: data.id, threadId: data.threadId }
}

interface GmailHeader { name: string; value: string }
interface GmailListItem { id: string; threadId: string }

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

export function emailDomain(email: string): string | null {
  const m = email.toLowerCase().match(/@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})$/)
  return m ? m[1] : null
}

function inferRelationship(name: string | null, title: string, from: string): string {
  const hay = `${name ?? ''} ${title} ${from}`.toLowerCase()
  if (/hiring manager|engineering manager|\bhead of\b|\bdirector\b|\bvp\b|\blead\b/.test(hay)) {
    return 'hiring_manager'
  }
  if (/recruit|talent|sourcer|people ops|\bhr\b|staffing/.test(hay)) {
    return 'recruiter'
  }
  return 'contact'
}

export interface MineOptions {
  accessToken: string
  /** Tracked companies to mine correspondence for. */
  companies: { id: string; name: string; domain: string | null }[]
  /** Cap on Gmail messages scanned per run. */
  maxMessages?: number
}

/**
 * Mine the user's OWN inbox for recruiter / hiring-manager correspondence tied
 * to a tracked company (matched by the company's email domain). Extracts
 * {name, email, company, last_contact_at} from message headers only. Returns the
 * most-recent contact per email. NO third-party / LinkedIn scraping.
 */
export async function mineRecruiterContacts(opts: MineOptions): Promise<MinedContact[]> {
  const byDomain = new Map<string, { id: string; name: string }>()
  for (const c of opts.companies) {
    if (c.domain) {
      const d = c.domain.toLowerCase().replace(/^www\./, '')
      if (!PERSONAL_DOMAINS.has(d)) byDomain.set(d, { id: c.id, name: c.name })
    }
  }
  if (byDomain.size === 0) return []

  const maxMessages = opts.maxMessages ?? 120
  // Build an OR query over the tracked company domains.
  const query = Array.from(byDomain.keys())
    .slice(0, 30)
    .map((d) => `from:${d}`)
    .join(' OR ')

  const listRes = await fetch(
    `${GMAIL_API}/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${Math.min(100, maxMessages)}`,
    { headers: { Authorization: `Bearer ${opts.accessToken}` } }
  )
  if (!listRes.ok) {
    const detail = await listRes.text().catch(() => '')
    throw new Error(`Gmail search failed (${listRes.status}): ${detail.slice(0, 200)}`)
  }
  const listData = (await listRes.json()) as { messages?: GmailListItem[] }
  const ids = (listData.messages || []).slice(0, maxMessages)

  const best = new Map<string, MinedContact>()

  const batchSize = 10
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize)
    const results = await Promise.all(
      batch.map(async ({ id }) => {
        const r = await fetch(
          `${GMAIL_API}/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${opts.accessToken}` } }
        )
        return r.ok ? ((await r.json()) as { payload?: { headers?: GmailHeader[] }; internalDate?: string }) : null
      })
    )
    for (const msg of results) {
      if (!msg?.payload?.headers) continue
      const from = getHeader(msg.payload.headers, 'from')
      const subject = getHeader(msg.payload.headers, 'subject')
      const { name, email } = parseFromHeader(from)
      if (!email) continue
      const domain = emailDomain(email)
      if (!domain) continue
      const company = byDomain.get(domain) || byDomain.get(domain.replace(/^mail\./, ''))
      if (!company) continue

      const lastContactAt = msg.internalDate
        ? new Date(parseInt(msg.internalDate, 10)).toISOString()
        : new Date().toISOString()

      const existing = best.get(email)
      if (existing && existing.lastContactAt >= lastContactAt) continue

      best.set(email, {
        name: name || email.split('@')[0],
        email,
        companyId: company.id,
        companyName: company.name,
        title: null,
        relationship: inferRelationship(name, subject, from),
        lastContactAt,
      })
    }
  }

  return Array.from(best.values())
}

/**
 * True if the given Gmail thread has an inbound reply — i.e. a message From
 * someone other than the user, so we never send a follow-up after a reply.
 */
export async function threadHasReply(
  accessToken: string,
  threadId: string,
  userEmail: string
): Promise<boolean> {
  const res = await fetch(
    `${GMAIL_API}/users/me/threads/${threadId}?format=metadata&metadataHeaders=From`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  if (!res.ok) {
    // FAIL CLOSED. Any non-OK response means the reply state is UNKNOWN, not
    // "no reply": a send-only token 403s here, an expired token 401s, and the
    // API can 5xx. Reporting "no reply" in those cases makes the guardrail
    // "never follow up after they answered" fail open, and the failure lands on
    // a real person who already replied. Suppressing a follow-up costs a delay;
    // sending a duplicate costs the user's credibility with that contact.
    console.warn('[outreach] reply check failed, suppressing follow-up', {
      status: res.status,
      threadId,
    })
    return true
  }
  const data = (await res.json()) as { messages?: { payload?: { headers?: GmailHeader[] } }[] }
  const me = userEmail.toLowerCase()
  for (const m of data.messages || []) {
    const from = getHeader(m.payload?.headers || [], 'from')
    const { email } = parseFromHeader(from)
    if (email && email !== me) return true
  }
  return false
}
