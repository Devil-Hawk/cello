// Send a drafted outreach message through the person's OWN Gmail account.
// This was the body of POST /api/outreach/send; it moved here unchanged so the
// route, Chat and any later door reach it only through conversations.send.
// Every guardrail is enforced here, in order:
//   (0) demo sessions: a demo may draft, judge and preview, never deliver
//   (1) approve-queue: the message must be 'approved' (or autoSend enabled)
//   (2) daily cap: stay under preferences.outreach.dailyCap
//   (4) real identity: From is always the authenticated Gmail account
//   (5) follow-ups: never send after a reply, and only past the wait window
// Sends are From the signed-in person only: no spoofing, no scraped strangers.

import type { SupabaseClient } from '@supabase/supabase-js'
import { readProfileForDemoGuards } from '@/lib/harness/keys'
import { hasGmailPermission } from '@/lib/gmail/permissions'
import { readOutreachConfig } from '@/lib/outreach/config'
import { getOutreach, updateOutreach, countSentToday } from '@/lib/outreach/store'
import { canSendNow, checkDailyCap, followUpWindowElapsed } from '@/lib/outreach/guardrails'
import { demoSendGate, firstRefusal, type DemoProfileFacts } from '@/lib/access/guardrails'
import { REPLY_CHECK_UNKNOWN_MESSAGE, isGmailAuthError, sendGmailMessage, threadHasReply } from '@/lib/outreach/gmail'
import { resolveGmailAccessToken } from '@/lib/gmail/token'
import { logApiError } from '@/lib/observability/log'
import type { CommandContext } from '../define'

export interface SendReply {
  status: number
  body: Record<string, unknown>
}

const reply = (body: Record<string, unknown>, status = 200): SendReply => ({ status, body })

export async function sendOutreach(
  ctx: CommandContext,
  input: { id: string; approve: boolean }
): Promise<SendReply> {
  const supabase = ctx.supabase
  const user = ctx.user
  if (!supabase || !user) return reply({ error: 'Unauthorized' }, 401)
  const session = ctx.session ? await ctx.session() : null

  // The Send permission is enforced HERE, not only in the UI. Settings writes
  // a preference; without this check revoking it was cosmetic and the next
  // "Approve & send" still delivered mail. A permission the product displays
  // but does not enforce is a promise it does not keep.
  //
  // is_demo / demo_expires_at ride along on the read this does anyway, so
  // guardrail (0) below costs no extra query. They are selected through an
  // untyped view of the same client because the access-codes migration's
  // columns are not in @cello/shared's generated Database type yet.
  const { row: sendPerm } = await readProfileForDemoGuards(supabase as unknown as SupabaseClient, user.id)

  // Guardrail (0): a demo session never delivers mail. Checked first, before the
  // Gmail permission and before the message is loaded, because it is the
  // cheapest and most fundamental refusal. demoSendGate also refuses an expired
  // demo and refuses outright when the profile could not be read.
  const demoFacts = (sendPerm ?? null) as DemoProfileFacts | null
  const demoGate = demoSendGate(demoFacts)
  if (!demoGate.allowed) {
    return reply({ error: demoGate.reason, message: demoGate.message, demo: demoGate.code }, 403)
  }

  if (!hasGmailPermission(sendPerm?.preferences, 'send')) {
    return reply(
      {
        error:
          'Sending through Gmail is turned off. Turn on "Send from my Gmail" in Settings, or copy the message and send it yourself.',
        needsPermission: 'send',
      },
      403
    )
  }

  const admin = ctx.admin()
  const message = await getOutreach(admin, user.id, input.id)
  if (!message) return reply({ error: 'Not found' }, 404)

  const config = await readOutreachConfig(supabase, user.id)

  // Guardrail (1): approve-queue, composed with the demo gate a SECOND time on
  // purpose, so a future edit that adds an early path around the refusal above
  // still cannot reach sendGmailMessage below. `approve: true` means the person
  // is approving in the same breath as sending, which keeps approve-and-send
  // atomic: a send that fails on the permission or cap check leaves the message
  // exactly where it was. See SendIntent in lib/outreach/guardrails.ts.
  const sendGate = firstRefusal(demoSendGate(demoFacts), canSendNow(message, config.prefs, { humanApproved: input.approve }))
  if (!sendGate.allowed) {
    return reply({ error: sendGate.reason, needsApproval: message.status === 'pending_review' }, 403)
  }

  // Guardrail (2): daily cap.
  const sentToday = await countSentToday(admin, user.id)
  const capGate = checkDailyCap(sentToday, config.prefs)
  if (!capGate.allowed) return reply({ error: capGate.reason }, 429)

  const userEmail = user.email || ''

  // The Gmail credential: the stored refresh token first, so a send an hour
  // after sign-in still works; the session's one-hour token only as a fallback.
  // Resolved after the cheap refusals above so a message that would be refused
  // anyway never costs a token exchange. A bad credential leaves the draft
  // exactly where it was and tells the person to reconnect.
  const token = await resolveGmailAccessToken(
    supabase,
    user.id,
    (sendPerm?.preferences ?? {}) as Record<string, unknown>,
    session?.provider_token
  )
  if (!token.ok) {
    const hasGoogle = user.identities?.some((i) => i.provider === 'google') ?? true
    return reply(
      {
        error: hasGoogle ? token.message : 'Sending through Gmail needs a Google sign-in. Sign in with Google to use it.',
        needsReauth: true,
      },
      401
    )
  }
  const accessToken = token.accessToken

  // Guardrail (5): follow-ups, window and no-reply.
  let parentThread: string | null = null
  if (message.kind === 'follow_up' && message.parent_id) {
    const parent = await getOutreach(admin, user.id, message.parent_id)
    const windowGate = followUpWindowElapsed(parent?.sent_at ?? null, config.prefs)
    if (!windowGate.allowed) return reply({ error: windowGate.reason }, 425)
    const threadId = parent?.gmail_thread_id ?? message.gmail_thread_id
    // replied_at is what the reply sync stamped; the live thread check is the
    // fresher second opinion. Either one suppresses the follow-up.
    const replyState = parent?.replied_at ? 'replied' : threadId ? await threadHasReply(accessToken, threadId, userEmail) : 'none'
    if (replyState === 'replied') {
      await updateOutreach(admin, user.id, input.id, { status: 'skipped', error: 'contact already replied, follow-up suppressed' })
      return reply({ ok: false, skipped: true, reason: 'contact already replied' })
    }
    // Unknown is not "replied": leave the draft pending and say what is missing.
    if (replyState === 'unknown') {
      return reply({ error: REPLY_CHECK_UNKNOWN_MESSAGE, needsPermission: 'monitor' }, 403)
    }
    parentThread = parent?.gmail_thread_id ?? null
  }

  // Identity (4): From is always the signed-in person.
  const { data: profile } = await supabase.from('profiles').select('full_name').eq('id', user.id).single()
  const fromName = profile?.full_name || userEmail.split('@')[0] || 'Me'

  let sent
  try {
    sent = await sendGmailMessage({
      accessToken,
      toEmail: message.to_email,
      toName: message.to_name,
      fromName,
      fromEmail: userEmail,
      subject: message.subject,
      body: message.body,
      threadId: parentThread,
    })
  } catch (e) {
    // The credential, not the message: nothing was delivered and the draft is
    // fine, so it stays sendable. Marking it failed here burned a good draft on
    // every expired token.
    if (isGmailAuthError(e)) {
      return reply({ error: 'Gmail rejected the saved access. Reconnect Gmail in Settings, then send again.', needsReauth: true }, 401)
    }
    const errMsg = e instanceof Error ? e.message : 'Gmail send failed'
    await updateOutreach(admin, user.id, input.id, { status: 'failed', error: errMsg })
    return reply({ error: errMsg }, 502)
  }

  // Gmail has the message. A failure to record that is NOT a failed send:
  // marking the row failed would tell the person nothing left and invite a
  // second send of an email already delivered.
  try {
    const updated = await updateOutreach(admin, user.id, input.id, {
      status: 'sent',
      sent_at: new Date().toISOString(),
      gmail_message_id: sent.id,
      gmail_thread_id: sent.threadId,
      error: null,
    })
    return reply({ ok: true, message: updated })
  } catch (e) {
    logApiError('outreach/send:record', e, { userId: user.id })
    return reply({
      ok: true,
      message: null,
      warning: 'The email was sent, but Cello could not record it. Do not send it again.',
    })
  }
}
