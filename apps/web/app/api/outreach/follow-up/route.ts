// POST /api/outreach/follow-up — draft the SINGLE allowed follow-up for a prior
// sent outreach. Guardrail (5): capped at one per parent, only after the wait
// window, and never if the contact already replied. The draft lands in the
// approve-queue like any other message (send still goes through /api/outreach/send).

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { readOutreachConfig } from '@/lib/outreach/config'
import { getOutreach, findFollowUp, insertOutreach } from '@/lib/outreach/store'
import { followUpWindowElapsed } from '@/lib/outreach/guardrails'
import { REPLY_CHECK_UNKNOWN_MESSAGE, threadHasReply } from '@/lib/outreach/gmail'
import { resolveGmailAccessToken } from '@/lib/gmail/token'
import { discardMessage, writeMessage } from '@/lib/outreach/write'
import { loadOutreachSources } from '@/lib/outreach/sources'
import { writeReviewVerdicts } from '@/lib/outreach/persist-review'
import { setTraceInput, setTraceMeta, setTraceOutput, withTrace } from '@/lib/trace/spans'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return withTrace(createAdminClient(), user.id, { name: 'draft-follow-up' }, async () => {

    let parentId: string
    try {
      const body = await request.json()
      parentId = typeof body?.parentId === 'string' ? body.parentId : ''
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    if (!parentId) return NextResponse.json({ error: 'parentId is required' }, { status: 400 })
    setTraceMeta({ parent_id: parentId })

    const admin = createAdminClient()
    const parent = await getOutreach(admin, user.id, parentId)
    if (!parent) return NextResponse.json({ error: 'Parent message not found' }, { status: 404 })
    if (parent.status !== 'sent') {
      return NextResponse.json({ error: 'Can only follow up on a sent message' }, { status: 409 })
    }

    // Cap: one follow-up per parent.
    const existing = await findFollowUp(admin, user.id, parentId)
    if (existing) {
      return NextResponse.json({ error: 'A follow-up already exists for this message.', existing }, { status: 409 })
    }

    const config = await readOutreachConfig(supabase, user.id)

    // Window gate.
    const windowGate = followUpWindowElapsed(parent.sent_at, config.prefs)
    if (!windowGate.allowed) {
      return NextResponse.json({ error: windowGate.reason }, { status: 425 })
    }

    // No-reply gate. replied_at is what the reply sync already stamped, so a
    // known reply stops the follow-up with no Gmail call at all.
    if (parent.replied_at) {
      return NextResponse.json({ ok: false, skipped: true, reason: 'contact already replied' })
    }
    // Otherwise ask Gmail, and FAIL CLOSED: with no usable token the reply state
    // is unknown, and a follow-up chasing someone who already answered costs the
    // user more than a refusal costs them.
    if (parent.gmail_thread_id) {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      const { data: prefsRow } = await supabase.from('profiles').select('preferences').eq('id', user.id).single()
      const token = await resolveGmailAccessToken(
        supabase,
        user.id,
        (prefsRow?.preferences ?? {}) as Record<string, unknown>,
        session?.provider_token
      )
      if (!token.ok) {
        return NextResponse.json(
          { error: `Cannot check whether they replied. ${token.message}`, needsReauth: true },
          { status: 401 }
        )
      }
      const replyState = await threadHasReply(token.accessToken, parent.gmail_thread_id, user.email || '')
      if (replyState === 'replied') {
        return NextResponse.json({ ok: false, skipped: true, reason: 'contact already replied' })
      }
      if (replyState === 'unknown') {
        return NextResponse.json(
          { error: REPLY_CHECK_UNKNOWN_MESSAGE, needsPermission: 'monitor' },
          { status: 403 }
        )
      }
    }

    // The job post, company research, the earlier history and the sender's
    // identity and resume: the same sources the first email was written from.
    const sources = await loadOutreachSources({
      supabase,
      admin,
      userId: user.id,
      userEmail: user.email || '',
      contactId: parent.contact_id,
      jobId: parent.job_id,
      companyId: parent.company_id,
    })
    // No name, no draft: a follow-up is signed like the first email.
    if (!sources.senderName) {
      return NextResponse.json(
        { error: 'Add your full name in Settings first. Drafts are signed with it.', needsName: true },
        { status: 409 }
      )
    }

    setTraceInput({ jobTitle: sources.input.jobTitle, companyName: sources.input.companyName })

    // The Writer drafts, checks once and saves the text as a message artifact; the row below queues that version.
    // ponytail: it follows the last email sent to this contact, which is the parent unless a later one went out.
    const made = await writeMessage(admin, { id: user.id, email: user.email || '' }, { type: 'follow_up', job_id: parent.job_id ?? undefined, contact_id: parent.contact_id ?? undefined })
    if (!made.ok) return NextResponse.json({ error: made.error, fix: made.fix }, { status: 422 })
    const { review, artifactId, artifactVersion } = made.written
    const usedLlm = review.source === 'model'
    const templateReason = usedLlm ? null : (review.templateReason ?? null)

    try {
      const row = await insertOutreach(admin, {
        user_id: user.id,
        contact_id: parent.contact_id,
        job_id: parent.job_id,
        company_id: parent.company_id,
        to_email: parent.to_email,
        to_name: parent.to_name,
        subject: review.subject,
        body: review.body,
        status: 'pending_review',
        kind: 'follow_up',
        parent_id: parentId,
        used_llm: usedLlm,
        template_reason: templateReason,
        artifact_id: artifactId,
        artifact_version: artifactVersion,
      })
      await writeReviewVerdicts(admin, user.id, row.id, review)
      setTraceMeta({ message_id: row.id })
      setTraceOutput({ subject: review.subject, usedLlm, templateReason })
      return NextResponse.json({ ok: true, message: row, usedLlm, templateReason, checks: review.checks })
    } catch (e) {
      await discardMessage(admin, user.id, artifactId)
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to save follow-up' }, { status: 500 })
    }
  })
}