// POST /api/drafts/approve  { draftId }
//
// The human-approve action of the one-click-apply flow. Approving a draft
// attempts an OFFICIAL-API submission (Greenhouse/Lever/Ashby) via lib/ats-apply.
//   - submitted  → status 'submitted' + submission_ref, and an applications row.
//   - handoff    → status 'approved', answers carry the prefilled apply link the
//                  user opens to finish (form needs human steps / no credential).
//   - failed     → status 'failed', error recorded in answers.
//
// HARD BOUNDARY: official APIs only, no captcha bypass, no form stuffing.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import {
  submitApplication,
  buildApplyProfile,
  buildHandoffFields,
  buildDraftAnswers,
  resolveApplyCredentials,
  type ApplyContent,
  type DraftAnswers,
} from '@/lib/ats-apply'
import { logApiError } from '@/lib/observability/log'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface JobRow {
  id: string
  url: string | null
  description: string | null
  company_id: string | null
  companies?: { metadata?: unknown } | { metadata?: unknown }[] | null
}

function companyMetadata(job: JobRow): unknown {
  const c = job.companies
  if (Array.isArray(c)) return c[0]?.metadata
  return c?.metadata
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let draftId: string
  try {
    const body = await request.json()
    draftId = typeof body?.draftId === 'string' ? body.draftId : ''
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!draftId) return NextResponse.json({ error: 'draftId is required' }, { status: 400 })

  const admin = createAdminClient()

  // Load + own the draft.
  const { data: draft, error: draftErr } = await admin
    .from('application_drafts')
    .select('id, user_id, job_id, resume_summary, cover_letter, answers, status')
    .eq('id', draftId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (draftErr) return NextResponse.json({ error: draftErr.message }, { status: 500 })
  if (!draft) return NextResponse.json({ error: 'Draft not found' }, { status: 404 })

  if (draft.status === 'submitted') {
    return NextResponse.json({ ok: true, status: 'submitted', draft })
  }
  if (draft.status === 'rejected') {
    return NextResponse.json({ error: 'Draft was rejected' }, { status: 409 })
  }

  // Load job + company + profile.
  const { data: jobData, error: jobErr } = await admin
    .from('jobs')
    .select('id, url, description, company_id, companies(metadata)')
    .eq('id', draft.job_id)
    .single()
  if (jobErr || !jobData) {
    return NextResponse.json({ error: 'Job not found for draft' }, { status: 404 })
  }
  const job = jobData as JobRow
  const jobUrl = job.url ?? ''

  const { data: profile } = await admin
    .from('profiles')
    .select('full_name, email, resume_text, preferences')
    .eq('id', user.id)
    .single()

  const applyProfile = buildApplyProfile({
    full_name: profile?.full_name as string | null,
    email: profile?.email as string | null,
    resume_text: profile?.resume_text as string | null,
    preferences: profile?.preferences,
  })
  const content: ApplyContent = {
    resumeSummary: (draft.resume_summary as string | null) ?? undefined,
    coverLetter: (draft.cover_letter as string | null) ?? undefined,
  }
  const credentials = resolveApplyCredentials(companyMetadata(job), profile?.preferences)

  // Attempt the official submit (credential-gated inside submitApplication).
  const result = await submitApplication({
    jobUrl,
    profile: applyProfile,
    content,
    jobDescription: job.description,
    credentials,
    client: admin,
    userId: user.id,
    jobId: job.id,
  })

  const provider = result.provider
  const fields =
    result.outcome === 'handoff'
      ? result.fields
      : buildHandoffFields(provider ?? 'greenhouse', applyProfile, content)
  const answers: DraftAnswers = buildDraftAnswers(provider, jobUrl, fields, result, job.description)
  if (result.outcome === 'failed') {
    answers.submitError = result.error
    // A real submission to an employer's ATS failed — submitApplication()
    // already caught the underlying error so this request won't crash, but
    // that also means it would otherwise be invisible outside this draft's
    // DB row. No job/company/resume content in `extra` — provider + IDs only.
    logApiError('drafts/approve:submit', new Error(result.error), {
      userId: user.id,
      jobId: job.id,
      draftId,
      provider,
    })
  }

  const status =
    result.outcome === 'submitted' ? 'submitted' : result.outcome === 'failed' ? 'failed' : 'approved'
  const submissionRef = result.outcome === 'submitted' ? result.submissionRef : null
  const handoffUrl = result.outcome === 'handoff' ? result.prefilledUrl : null

  const { error: updErr } = await admin
    .from('application_drafts')
    .update({
      status,
      answers,
      submission_ref: submissionRef,
      submitted_at: status === 'submitted' ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', draftId)
    .eq('user_id', user.id)
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

  // On a real submit, reflect it in the pipeline (best-effort, deduped).
  if (status === 'submitted') {
    try {
      const { data: existingApp } = await admin
        .from('applications')
        .select('id')
        .eq('user_id', user.id)
        .eq('job_id', draft.job_id)
        .maybeSingle()
      if (!existingApp) {
        await admin.from('applications').insert({
          user_id: user.id,
          job_id: draft.job_id,
          stage: 'applied',
          applied_at: new Date().toISOString(),
          source: 'cello-autopilot',
          cover_letter: (draft.cover_letter as string | null) ?? null,
        })
      }
    } catch {
      /* pipeline reflection is best-effort */
    }
  }

  return NextResponse.json({ ok: true, status, submissionRef, handoffUrl, provider })
}
