// POST /api/outreach/send — send a drafted outreach message through the user's
// OWN Gmail account. Every guardrail is enforced here, in order:
//   (1) approve-queue: message must be 'approved' (or autoSend enabled)
//   (2) daily cap: stay under preferences.outreach.dailyCap
//   (4) real identity: From is always the authenticated Gmail account
//   (5) follow-ups: never send after a reply, and only past the wait window
// Sends are From the signed-in user only — no spoofing, no scraped strangers.

import { hasGmailPermission } from '@/lib/gmail/permissions'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { readOutreachConfig } from '@/lib/outreach/config'
import { getOutreach, updateOutreach, countSentToday } from '@/lib/outreach/store'
import { canSendNow, checkDailyCap, followUpWindowElapsed } from '@/lib/outreach/guardrails'
import { sendGmailMessage, threadHasReply } from '@/lib/outreach/gmail'

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
  const { data: sendPerm } = await supabase
    .from('profiles')
    .select('preferences')
    .eq('id', user.id)
    .single()
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

  if (!session?.provider_token) {
    return NextResponse.json(
      { error: 'Gmail access not available. Connect Gmail in Settings to enable this.', needsReauth: true },
      { status: 401 }
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

  // Guardrail (1): approve-queue.
  const sendGate = canSendNow(message, config.prefs, { humanApproved })
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

  // Guardrail (5): follow-ups — window + no-reply.
  if (message.kind === 'follow_up' && message.parent_id) {
    const parent = await getOutreach(admin, user.id, message.parent_id)
    const windowGate = followUpWindowElapsed(parent?.sent_at ?? null, config.prefs)
    if (!windowGate.allowed) {
      return NextResponse.json({ error: windowGate.reason }, { status: 425 })
    }
    const threadId = parent?.gmail_thread_id ?? message.gmail_thread_id
    if (threadId) {
      const replied = await threadHasReply(session.provider_token, threadId, userEmail)
      if (replied) {
        await updateOutreach(admin, user.id, id, { status: 'skipped', error: 'contact already replied — follow-up suppressed' })
        return NextResponse.json({ ok: false, skipped: true, reason: 'contact already replied' })
      }
    }
  }

  // Identity (4): From is always the signed-in user.
  const { data: profile } = await supabase.from('profiles').select('full_name').eq('id', user.id).single()
  const fromName = profile?.full_name || userEmail.split('@')[0] || 'Me'

  const parentThread =
    message.kind === 'follow_up' && message.parent_id
      ? (await getOutreach(admin, user.id, message.parent_id))?.gmail_thread_id ?? null
      : null

  try {
    const sent = await sendGmailMessage({
      accessToken: session.provider_token,
      toEmail: message.to_email,
      toName: message.to_name,
      fromName,
      fromEmail: userEmail,
      subject: message.subject,
      body: message.body,
      threadId: parentThread,
    })
    const updated = await updateOutreach(admin, user.id, id, {
      status: 'sent',
      sent_at: new Date().toISOString(),
      gmail_message_id: sent.id,
      gmail_thread_id: sent.threadId,
      error: null,
    })
    return NextResponse.json({ ok: true, message: updated })
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : 'Gmail send failed'
    await updateOutreach(admin, user.id, id, { status: 'failed', error: errMsg })
    return NextResponse.json({ error: errMsg }, { status: 502 })
  }
}
