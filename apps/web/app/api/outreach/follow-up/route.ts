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
import type { OutreachDraftInput } from '@/lib/harness/agents/outreach'
import { runUnitOnce } from '@/lib/graph/oneshot'
import { fitHighlights } from '@/lib/scoring/read'
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

    // Build context for a short, low-pressure follow-up.
    let jobTitle = 'the role'
    let companyName = 'your company'
    let matchHighlights: string[] = []
    if (parent.job_id) {
      const { data: job } = await supabase
        .from('jobs')
        .select('title, chance_detail')
        .eq('id', parent.job_id)
        .single()
      if (job) {
        jobTitle = job.title || jobTitle
        matchHighlights = fitHighlights(job.chance_detail)
      }
    }
    if (parent.company_id) {
      const { data: company } = await supabase
        .from('companies')
        .select('name')
        .eq('id', parent.company_id)
        .eq('user_id', user.id)
        .single()
      if (company) companyName = company.name
    }

    setTraceInput({ jobTitle, companyName })

    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name, resume_text')
      .eq('id', user.id)
      .single()

    const draftInput: OutreachDraftInput = {
      userName: profile?.full_name || user.email?.split('@')[0] || 'Me',
      userEmail: user.email || '',
      jobTitle,
      companyName,
      contactName: parent.to_name,
      resumeText: profile?.resume_text ?? null,
      matchHighlights,
      kind: 'follow_up',
    }

    // runAgentUnit('outreach') — same unit the initial-draft route uses,
    // distinguished by draftInput.kind ('follow_up' here) — builds its own
    // metered LlmRunner from the user's stored keys (lib/harness/keys.ts#
    // loadApiKeys); no more makeLlmRunner here. generateOutreachDraft never
    // throws (falls back to a deterministic template on any model failure).
    const unitResult = await runUnitOnce('outreach', {
      admin,
      userId: user.id,
      goal: 'Draft outreach follow-up email',
      input: draftInput,
    })
    const draft = unitResult.output as { subject: string; body: string; tokensUsed: number }
    const usedLlm = draft.tokensUsed > 0

    try {
      const row = await insertOutreach(admin, {
        user_id: user.id,
        contact_id: parent.contact_id,
        job_id: parent.job_id,
        company_id: parent.company_id,
        to_email: parent.to_email,
        to_name: parent.to_name,
        subject: draft.subject,
        body: draft.body,
        status: 'pending_review',
        kind: 'follow_up',
        parent_id: parentId,
        used_llm: usedLlm,
      })
      setTraceMeta({ message_id: row.id })
      setTraceOutput({ subject: draft.subject, usedLlm })
      return NextResponse.json({ ok: true, message: row, usedLlm })
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to save follow-up' }, { status: 500 })
    }
  })
}
