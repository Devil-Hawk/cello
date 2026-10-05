// Outreach reply detection: look at the Gmail threads Cello itself started, not
// at mail that happens to look like a job application.
//
// The old bridge rode on the job-email search (subject keywords such as
// "interview" or "offer"), so a human answering "Staff Engineer at Acme - quick
// note" never matched, a bounce never matched, and the user's OWN sent message
// could match and be recorded as the "reply". Here the unit of work is a thread
// id we stored when the message was sent, and a reply is the first message in
// that thread that did not come from the user.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { GmailMessage } from '@/lib/gmail/types'
import { extractBody, fetchGmailAddress, fetchGmailThread, getHeader } from '@/lib/gmail/gmail-api'
import { classifyWithPatterns } from '@/lib/gmail/classify'
import { classifyReply } from '@/lib/gmail/stage'
import { logApiError } from '@/lib/observability/log'
import { parseFromHeader } from './gmail'
import { recordOutreachReply } from './store'

/** Threads checked per sync pass (most recently sent first). One Gmail call each. */
const MAX_THREADS_PER_PASS = 25

/**
 * The first message in a thread that came from someone other than the user.
 * "From the user" is Gmail's own SENT label, or the mailbox address when it is
 * known. `messages` may arrive in any order; the earliest inbound one wins.
 */
export function pickInboundReply(messages: GmailMessage[], ownEmail: string | null): GmailMessage | null {
  const own = ownEmail?.toLowerCase() ?? null
  let best: GmailMessage | null = null
  for (const m of messages) {
    if (m.labelIds?.includes('SENT')) continue
    const from = parseFromHeader(getHeader(m.payload.headers, 'from')).email
    if (own && from === own) continue
    if (!best || Number(m.internalDate) < Number(best.internalDate)) best = m
  }
  return best
}

/**
 * Stamp replied_at on every still-unreplied outreach thread that has an inbound
 * message. Never throws: reply tracking is a side effect of the sync and must
 * not fail it. Returns how many threads were marked replied.
 */
export async function syncOutreachReplies(args: {
  admin: SupabaseClient
  userId: string
  accessToken: string
}): Promise<number> {
  const { admin, userId, accessToken } = args
  try {
    const { data } = await admin
      .from('outreach_messages')
      .select('gmail_thread_id')
      .eq('user_id', userId)
      .eq('status', 'sent')
      .not('gmail_thread_id', 'is', null)
      .is('replied_at', null)
      .order('sent_at', { ascending: false })
      .limit(MAX_THREADS_PER_PASS)
    const threadIds = [...new Set(((data as { gmail_thread_id: string }[] | null) ?? []).map((r) => r.gmail_thread_id))]
    if (threadIds.length === 0) return 0

    const ownEmail = await fetchGmailAddress(accessToken)
    let replied = 0
    for (const threadId of threadIds) {
      const messages = await fetchGmailThread(accessToken, threadId)
      if (!messages) continue
      const reply = pickInboundReply(messages, ownEmail)
      if (!reply) continue

      const from = getHeader(reply.payload.headers, 'from')
      const subject = getHeader(reply.payload.headers, 'subject')
      const at = new Date(parseInt(reply.internalDate, 10))
      const receivedAt = isNaN(at.getTime()) ? new Date() : at
      // Pattern classification only: free, and a reply to cold outreach rarely
      // reads as a job-application stage, so most land on 'neutral' by design.
      const status = classifyWithPatterns(from, subject, extractBody(reply.payload), receivedAt).status
      const rows = await recordOutreachReply(admin, {
        userId,
        gmailThreadId: threadId,
        gmailMessageId: reply.id,
        classification: classifyReply(from, subject, status),
        occurredAt: receivedAt.toISOString(),
      })
      if (rows.length > 0) replied++
    }
    return replied
  } catch (err) {
    logApiError('gmail/outreach-replies', err, { userId })
    return 0
  }
}
