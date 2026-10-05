// POST /api/outreach/send — send a drafted outreach message through the user's
// OWN Gmail account. Every guardrail is enforced here, in order:
//   (0) demo sessions: a demo may draft, judge and preview — never deliver
//   (1) approve-queue: message must be 'approved' (or autoSend enabled)
//   (2) daily cap: stay under preferences.outreach.dailyCap
//   (4) real identity: From is always the authenticated Gmail account
//   (5) follow-ups: never send after a reply, and only past the wait window
// Sends are From the signed-in user only — no spoofing, no scraped strangers.

import type { SupabaseClient } from '@supabase/supabase-js'
import { readProfileForDemoGuards } from '@/lib/harness/keys'
import { hasGmailPermission } from '@/lib/gmail/permissions'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { readOutreachConfig } from '@/lib/outreach/config'
import { getOutreach, updateOutreach, countSentToday } from '@/lib/outreach/store'
import { canSendNow, checkDailyCap, followUpWindowElapsed } from '@/lib/outreach/guardrails'
import { demoSendGate, firstRefusal, type DemoProfileFacts } from '@/lib/access/guardrails'
import { REPLY_CHECK_UNKNOWN_MESSAGE, isGmailAuthError, sendGmailMessage, threadHasReply } from '@/lib/outreach/gmail'
import { resolveGmailAccessToken } from '@/lib/gmail/token'
import { logApiError } from '@/lib/observability/log'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const {
    data: { session },
  } = await supabase.auth.getSession()
  // The Send permission is enforced HERE, not only in the UI. Settings writes
  // a preference; without this check revoking it was cosmetic and the next
  // "Approve & send" still delivered mail. A permission the product displays
  // but does not enforce is a promise it does not keep.
  //
  // is_demo / demo_expires_at ride along on the read this route was already
  // doing, so guardrail (0) below costs no extra query. They are selected
  // through an untyped view of the same client because the access-codes
  // migration's columns are not in @cello/shared's generated Database type yet
  // — the same escape hatch app/api/access-codes/route.ts uses.
  const { row: sendPerm } = await readProfileForDemoGuards(
    supabase as unknown as SupabaseClient,
    user.id
  )

  // Guardrail (0): a demo session never delivers mail.
  //
  // Everything upstream of this line is the demo — drafting, the judge, the
  // preview, the approve queue all run for real. Delivery is the one action
  // that leaves the workspace permanently: it puts a stranger's words in a real
  // person's inbox, From the owner's own Gmail account, with no undo. Every
  // other thing a demo can do writes rows RLS already fences off.
  //
  // Checked FIRST, before the Gmail permission and before the message is even
  // loaded, because it is the cheapest and most fundamental refusal — and
  // because a demo should be told "sending is off in the demo", not "turn on a
  // permission you cannot turn on". demoSendGate also refuses an EXPIRED demo
  // (with the expiry wording) and refuses outright when the profile could not
  // be read, since we cannot then prove the caller is not a demo.
  const demoFacts = (sendPerm ?? null) as DemoProfileFacts | null
  const demoGate = demoSendGate(demoFacts)
  if (!demoGate.allowed) {
    return NextResponse.json(
      { error: demoGate.reason, message: demoGate.message, demo: demoGate.code },
      { status: 403 }
    )
  }

  if (!hasGmailPermission(sendPerm?.preferences, 'send')) {
    return NextResponse.json(
      {
        error:
          'Sending through Gmail is turned off. Turn on "Send approved messages" in Settings, or copy the message and send it yourself.',
        needsPermission: 'send',
      },
      { status: 403 }
    )
  }

  let id: string
  // `approve: true` means "the human is approving this in the same breath as
  // sending it". Accepting the approval as an argument is what makes
  // approve-and-send atomic: the client no longer PATCHes the row to
  // 'approved' first, so a send that fails on the permission or cap check
  // below leaves the message exactly where it was — pending_review, not armed.
  // See SendIntent in lib/outreach/guardrails.ts.
  let humanApproved = false
  try {
    const body = await request.json()
    id = typeof body?.id === 'string' ? body.id : ''
    humanApproved = body?.approve === true
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const admin = createAdminClient()
  const message = await getOutreach(admin, user.id, id)
  if (!message) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const config = await readOutreachConfig(supabase, user.id)

  // Guardrail (1): approve-queue, composed with the demo gate a SECOND time.
  //
  // Deliberate redundancy, not a copy-paste slip. The refusal above is the one a
  // demo user actually sees; re-composing here means any future edit that adds
  // an early path around it — a new branch, a reordered read, a "fast path" for
  // follow-ups — still cannot reach sendGmailMessage below. firstRefusal keeps
  // it to the single `if (!sendGate.allowed)` branch this route already had.
  const sendGate = firstRefusal(demoSendGate(demoFacts), canSendNow(message, config.prefs, { humanApproved }))
  if (!sendGate.allowed) {
    return NextResponse.json({ error: sendGate.reason, needsApproval: message.status === 'pending_review' }, { status: 403 })
  }

  // Guardrail (2): daily cap.
  const sentToday = await countSentToday(admin, user.id)
  const capGate = checkDailyCap(sentToday, config.prefs)
  if (!capGate.allowed) {
    return NextResponse.json({ error: capGate.reason }, { status: 429 })
  }

  const userEmail = user.email || ''

  // The Gmail credential: the stored refresh token first, so a send an hour
  // after sign-in still works; the session's one-hour token only as a
  // fallback. Resolved after the cheap refusals above so a message that would
  // be refused anyway never costs a token exchange. A bad credential leaves the
  // draft exactly where it was and tells the user to reconnect.
  const token = await resolveGmailAccessToken(
    supabase,
    user.id,
    (sendPerm?.preferences ?? {}) as Record<string, unknown>,
    session?.provider_token
  )
  if (!token.ok) {
    const hasGoogle = user.identities?.some((i) => i.provider === 'google') ?? true
    return NextResponse.json(
      {
        error: hasGoogle ? token.message : 'Sending through Gmail needs a Google sign-in. Sign in with Google to use it.',
        needsReauth: true,
      },
      { status: 401 }
    )
  }
  const accessToken = token.accessToken

  // Guardrail (5): follow-ups — window + no-reply.
  let parentThread: string | null = null
  if (message.kind === 'follow_up' && message.parent_id) {
    const parent = await getOutreach(admin, user.id, message.parent_id)
    const windowGate = followUpWindowElapsed(parent?.sent_at ?? null, config.prefs)
    if (!windowGate.allowed) {
      return NextResponse.json({ error: windowGate.reason }, { status: 425 })
    }
    const threadId = parent?.gmail_thread_id ?? message.gmail_thread_id
    // replied_at is what the reply sync stamped; the live thread check is the
    // fresher second opinion. Either one suppresses the follow-up.
    const replyState = parent?.replied_at ? 'replied' : threadId ? await threadHasReply(accessToken, threadId, userEmail) : 'none'
    if (replyState === 'replied') {
      await updateOutreach(admin, user.id, id, { status: 'skipped', error: 'contact already replied, follow-up suppressed' })
      return NextResponse.json({ ok: false, skipped: true, reason: 'contact already replied' })
    }
    // Unknown is not "replied": leave the draft pending and say what is missing.
    if (replyState === 'unknown') {
      return NextResponse.json({ error: REPLY_CHECK_UNKNOWN_MESSAGE, needsPermission: 'monitor' }, { status: 403 })
    }
    parentThread = parent?.gmail_thread_id ?? null
  }

  // Identity (4): From is always the signed-in user.
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
      return NextResponse.json(
        { error: 'Gmail rejected the saved access. Reconnect Gmail in Settings, then send again.', needsReauth: true },
        { status: 401 }
      )
    }
    const errMsg = e instanceof Error ? e.message : 'Gmail send failed'
    await updateOutreach(admin, user.id, id, { status: 'failed', error: errMsg })
    return NextResponse.json({ error: errMsg }, { status: 502 })
  }

  // Gmail has the message. A failure to record that is NOT a failed send:
  // marking the row failed would tell the user nothing left and invite a
  // second send of an email already delivered.
  try {
    const updated = await updateOutreach(admin, user.id, id, {
      status: 'sent',
      sent_at: new Date().toISOString(),
      gmail_message_id: sent.id,
      gmail_thread_id: sent.threadId,
      error: null,
    })
    return NextResponse.json({ ok: true, message: updated })
  } catch (e) {
    logApiError('outreach/send:record', e, { userId: user.id })
    return NextResponse.json({
      ok: true,
      message: null,
      warning: 'The email was sent, but Cello could not record it. Do not send it again.',
    })
  }
}
