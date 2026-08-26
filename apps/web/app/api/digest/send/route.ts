// POST /api/digest/send — send today's digest to the user's OWN inbox via their
// OWN Gmail (request context only, where session.provider_token exists).
//
// Guards, in order:
//   (0) demo sessions: a demo reads its digest in-app, never by email
//   (1) opt-in: preferences.digest.enabled must be true (unless `force`)
//   (2) once-per-day: preferences.digest.lastSentDate !== today (unless `force`)
// Gates (1) and (2) are enforced inside composeAndStoreDigest; the digest is
// stored regardless so the user can always read it in-app. From/To is always
// the authenticated account — no spoofing, no external recipients.

import type { SupabaseClient } from '@supabase/supabase-js'
import { readProfileForDemoGuards } from '@/lib/harness/keys'
import { hasGmailPermission } from '@/lib/gmail/permissions'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { composeAndStoreDigest } from '@/lib/harness/agents/digest'
import { demoSendGate, type DemoProfileFacts } from '@/lib/access/guardrails'
import { sendGmailMessage } from '@/lib/outreach/gmail'

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
  // doing, so guardrail (0) below costs no extra query. Selected through an
  // untyped view of the same client because the access-codes migration's
  // columns are not in @cello/shared's generated Database type yet.
  const { row: sendPerm } = await readProfileForDemoGuards(
    supabase as unknown as SupabaseClient,
    user.id
  )

  // Guardrail (0): a demo session never delivers mail.
  //
  // This route's recipient is the signed-in account itself, which sounds
  // harmless — but the message goes out through session.provider_token, i.e.
  // through a REAL connected Gmail mailbox, and the digest body is composed
  // from workspace data. Refusing here keeps the rule simple enough to hold:
  // no demo request ever reaches sendGmailMessage, whoever the To happens to
  // be. The demo still reads exactly the same digest at GET /api/digest, which
  // composes it from stored data with no mail involved.
  //
  // demoSendGate also refuses an expired demo, and refuses outright when the
  // profile could not be read — we cannot then prove the caller is not a demo.
  const demoGate = demoSendGate((sendPerm ?? null) as DemoProfileFacts | null)
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

  if (!session?.provider_token) {
    return NextResponse.json(
      {
        error: 'Gmail access not available. Connect Gmail in Settings to enable this.',
        needsReauth: true,
      },
      { status: 401 }
    )
  }

  let force = false
  try {
    const body = await request.json().catch(() => ({}))
    force = body?.force === true
  } catch {
    // no body → default (respect gates)
  }

  const userEmail = user.email || ''
  if (!userEmail) {
    return NextResponse.json({ error: 'No email on account' }, { status: 400 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name')
    .eq('id', user.id)
    .single()
  const fromName = profile?.full_name || userEmail.split('@')[0] || 'Me'

  const admin = createAdminClient()
  const result = await composeAndStoreDigest(admin, user.id, {
    force,
    send: async (digest) => {
      if (digest.empty) return // nothing worth emailing; still stored for in-app view
      await sendGmailMessage({
        accessToken: session.provider_token!,
        toEmail: userEmail,
        toName: fromName,
        fromName,
        fromEmail: userEmail,
        subject: digest.subject,
        body: digest.text,
      })
    },
  })

  if (result.outcome === 'error') {
    return NextResponse.json({ error: result.reason ?? 'Digest failed' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, ...result })
}
