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
import { CLASSIFY_MODEL } from '@/lib/gmail/classify'
import { callLlm } from '@/lib/harness/llm'
import type { DecryptedApiKeys } from '@/lib/harness/types'
import { logApiError } from '@/lib/observability/log'
import { parseFromHeader } from './gmail'
import { classifyReplyPatterns, classifyReplyWith, isAutoReply, isBounce, stripQuoted } from './reply-classify'
import type { ReplyClassification } from './types'
import { recordOutreachReply } from './store'

/** Threads checked per sync pass (most recently sent first). One Gmail call each. */
const MAX_THREADS_PER_PASS = 25

/**
 * The first message in a thread that came from someone other than the user.
 * "From the user" is Gmail's own SENT label, or the mailbox address when it is
 * known. An out-of-office or other automatic answer is not a person replying, so
 * it is skipped: counting it stamped replied_at and blocked the follow-up for
 * good. A bounce is kept, since it is something the user needs to see.
 * `messages` may arrive in any order; the earliest inbound one wins.
 */
export function pickInboundReply(messages: GmailMessage[], ownEmail: string | null): GmailMessage | null {
  const own = ownEmail?.toLowerCase() ?? null
  let best: GmailMessage | null = null
  for (const m of messages) {
    if (m.labelIds?.includes('SENT')) continue
    const from = parseFromHeader(getHeader(m.payload.headers, 'from')).email
    if (own && from === own) continue
    const subject = getHeader(m.payload.headers, 'subject')
    if (!isBounce(getHeader(m.payload.headers, 'from'), subject) && isAutoReply(m.payload.headers, subject)) continue
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
  /** With an OpenRouter key the reply is read by a model; without one, by patterns. */
  apiKeys?: DecryptedApiKeys
}): Promise<number> {
  const { admin, userId, accessToken, apiKeys } = args
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
      // Read what the person wrote, not the quoted copy of the user's email.
      const text = stripQuoted(extractBody(reply.payload))
      let classification: ReplyClassification
      if (isBounce(from, subject)) classification = 'bounce'
      else if (apiKeys?.openrouter) {
        classification = await classifyReplyWith(
          (opts) => callLlm(apiKeys, { ...opts, model: CLASSIFY_MODEL, reasoning: { effort: 'none' }, name: 'classify-reply' }),
          subject,
          text
        )
      } else classification = classifyReplyPatterns(subject, text)
      const rows = await recordOutreachReply(admin, {
        userId,
        gmailThreadId: threadId,
        gmailMessageId: reply.id,
        classification,
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
