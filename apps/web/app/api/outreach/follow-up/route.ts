// POST /api/outreach/follow-up — draft the SINGLE allowed follow-up for a prior
// sent outreach. Guardrail (5): capped at one per parent, only after the wait
// window, and never if the contact already replied. The draft lands in the
// approve-queue like any other message (send still goes through /api/outreach/send).

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { readOutreachConfig } from '@/lib/outreach/config'
import { makeLlmRunner } from '@/lib/outreach/llm'
import { getOutreach, findFollowUp, insertOutreach } from '@/lib/outreach/store'
import { followUpWindowElapsed } from '@/lib/outreach/guardrails'
import { threadHasReply } from '@/lib/outreach/gmail'
import { generateOutreachDraft, fallbackOutreachDraft, type OutreachDraftInput } from '@/lib/harness/agents/outreach'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let parentId: string
  try {
    const body = await request.json()
    parentId = typeof body?.parentId === 'string' ? body.parentId : ''
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!parentId) return NextResponse.json({ error: 'parentId is required' }, { status: 400 })

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

  // No-reply gate (best-effort; needs the Gmail token).
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (session?.provider_token && parent.gmail_thread_id) {
    const replied = await threadHasReply(session.provider_token, parent.gmail_thread_id, user.email || '')
    if (replied) {
      return NextResponse.json({ ok: false, skipped: true, reason: 'contact already replied' })
    }
  }

  // Build context for a short, low-pressure follow-up.
  let jobTitle = 'the role'
  let companyName = 'your company'
  let matchHighlights: string[] = []
  if (parent.job_id) {
    const { data: job } = await supabase
      .from('jobs')
      .select('title, match_details')
      .eq('id', parent.job_id)
      .single()
    if (job) {
      jobTitle = job.title || jobTitle
      const md = (job.match_details ?? {}) as { highlights?: unknown }
      if (Array.isArray(md.highlights)) matchHighlights = md.highlights.filter((h): h is string => typeof h === 'string').slice(0, 4)
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

  const llm = makeLlmRunner(config.openrouterKey)
  const draft = llm ? await generateOutreachDraft(llm, draftInput) : fallbackOutreachDraft(draftInput)

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
    })
    return NextResponse.json({ ok: true, message: row, usedLlm: !!llm })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to save follow-up' }, { status: 500 })
  }
}
