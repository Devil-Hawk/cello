// POST /api/outreach/draft — draft a personalized cold-outreach email for a
// contact tied to a job/company, and store it as an outreach_message with status
// 'pending_review' (approve-queue by default). Enforces the hard dedupe guardrail
// (one initial email per contact per role). Does NOT send — see /api/outreach/send.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { readOutreachConfig } from '@/lib/outreach/config'
import { makeLlmRunner } from '@/lib/outreach/llm'
import { findDuplicateInitial, insertOutreach } from '@/lib/outreach/store'
import { generateOutreachDraft, fallbackOutreachDraft, type OutreachDraftInput } from '@/lib/harness/agents/outreach'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface MatchDetails {
  highlights?: unknown
  skillsMatch?: { matched?: unknown }
}

function highlightsFrom(matchDetails: unknown): string[] {
  const md = (matchDetails ?? {}) as MatchDetails
  const out: string[] = []
  if (Array.isArray(md.highlights)) {
    for (const h of md.highlights) if (typeof h === 'string') out.push(h)
  }
  if (out.length === 0 && md.skillsMatch && Array.isArray(md.skillsMatch.matched)) {
    for (const s of md.skillsMatch.matched) if (typeof s === 'string') out.push(s)
  }
  return out.slice(0, 6)
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let contactId: string
  let jobId: string | null = null
  try {
    const body = await request.json()
    contactId = typeof body?.contactId === 'string' ? body.contactId : ''
    if (typeof body?.jobId === 'string' && body.jobId) jobId = body.jobId
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!contactId) return NextResponse.json({ error: 'contactId is required' }, { status: 400 })

  // Contact (must be the user's own, and reachable by email).
  const { data: contact } = await supabase
    .from('contacts')
    .select('id, name, email, title, company_id')
    .eq('id', contactId)
    .eq('user_id', user.id)
    .single()
  if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
  if (!contact.email) {
    return NextResponse.json({ error: 'Contact has no email address to reach' }, { status: 400 })
  }

  const admin = createAdminClient()

  // Guardrail (3): hard dedupe — no repeat pestering.
  const dupe = await findDuplicateInitial(admin, user.id, contactId, jobId)
  if (dupe) {
    return NextResponse.json(
      { error: 'An outreach email to this contact for this role already exists.', existing: dupe },
      { status: 409 }
    )
  }

  // Job + company context.
  let jobTitle = 'a role'
  let jobDescription: string | null = null
  let companyId: string | null = contact.company_id ?? null
  let matchHighlights: string[] = []
  if (jobId) {
    const { data: job } = await supabase
      .from('jobs')
      .select('id, title, description, company_id, match_details')
      .eq('id', jobId)
      .single()
    if (job) {
      jobTitle = job.title || jobTitle
      jobDescription = job.description ?? null
      companyId = job.company_id ?? companyId
      matchHighlights = highlightsFrom(job.match_details)
    }
  }

  let companyName = 'your company'
  if (companyId) {
    const { data: company } = await supabase
      .from('companies')
      .select('id, name')
      .eq('id', companyId)
      .eq('user_id', user.id)
      .single()
    if (company) companyName = company.name
  }

  // Identity + resume (source of truth for fit claims — never fabricated).
  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, resume_text')
    .eq('id', user.id)
    .single()
  const userName = profile?.full_name || user.email?.split('@')[0] || 'Me'
  const userEmail = user.email || ''

  const draftInput: OutreachDraftInput = {
    userName,
    userEmail,
    jobTitle,
    companyName,
    contactName: contact.name,
    contactTitle: contact.title,
    resumeText: profile?.resume_text ?? null,
    matchHighlights,
    jobDescription,
    kind: 'initial',
  }

  const config = await readOutreachConfig(supabase, user.id)
  const llm = makeLlmRunner(config.openrouterKey)
  const draft = llm ? await generateOutreachDraft(llm, draftInput) : fallbackOutreachDraft(draftInput)

  try {
    const row = await insertOutreach(admin, {
      user_id: user.id,
      contact_id: contactId,
      job_id: jobId,
      company_id: companyId,
      to_email: contact.email,
      to_name: contact.name,
      subject: draft.subject,
      body: draft.body,
      status: 'pending_review',
      kind: 'initial',
    })
    return NextResponse.json({ ok: true, message: row, usedLlm: !!llm })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to save draft' },
      { status: 500 }
    )
  }
}
