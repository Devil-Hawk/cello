// Approve a drafted application. This was the body of POST /api/drafts/approve;
// it moved here unchanged so the route and every later door reach it only
// through conversations.send.
//
// Approving a draft attempts an OFFICIAL-API submission (Greenhouse, Lever,
// Ashby) via lib/ats-apply.
//   - submitted  status 'submitted' + submission_ref, and an applications row.
//   - handoff    status 'approved', answers carry the prefilled apply link the
//                person opens to finish (the form needs human steps, or no credential).
//   - failed     status 'failed', error recorded in answers.
//
// HARD BOUNDARY: official APIs only, no captcha bypass, no form stuffing.

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
import type { CommandContext } from '../define'
import type { SendReply } from './outreach'

const reply = (body: Record<string, unknown>, status = 200): SendReply => ({ status, body })

interface JobRow {
  id: string
  url: string | null
  description: string | null
  company_id: string | null
  /** The person's own company metadata, never the first storer's (a companies(...) embed follows jobs.company_id). */
  viewer_company_metadata?: unknown
}

export async function approveDraft(ctx: CommandContext, input: { draftId: string }): Promise<SendReply> {
  const user = ctx.user
  if (!user) return reply({ error: 'Unauthorized' }, 401)
  const draftId = input.draftId

  const admin = ctx.admin()

  // Load + own the draft.
  const { data: draft, error: draftErr } = await admin
    .from('application_drafts')
    .select('id, user_id, job_id, resume_summary, cover_letter, answers, status, fill_state')
    .eq('id', draftId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (draftErr) return reply({ error: draftErr.message }, 500)
  if (!draft) return reply({ error: 'Draft not found' }, 404)

  if (draft.status === 'submitted') {
    return reply({ ok: true, status: 'submitted', draft })
  }
  if (draft.status === 'rejected') {
    return reply({ error: 'Draft was rejected' }, 409)
  }

  // ASSISTED-APPLY DRAFTS (a browser filled the hosted form — draft.fill_state
  // was written by PATCH /api/apply/state) never go through submitApplication:
  // there is no official-ATS credential involved, only a host-scoped board
  // sign-in released to the browser runner. "Approve" here means exactly what
  // ruling 8 requires it to mean — a human reviewed the filled answers and
  // screenshots and confirmed them — recorded as reviewed_at/review_confirmed_at.
  // A SEPARATE human click (POST /api/apply/confirm) is what actually
  // authorizes and dispatches the submit run; see that route's header for why
  // the two are deliberately not the same request.
  if (draft.fill_state) {
    // Only a completed, unreviewed fill may be approved from here — a
    // draft sitting in 'filling' (still in flight) or 'failed' (a submit
    // attempt already failed) must not be silently re-stamped 'approved'
    // with a fresh review_confirmed_at: that timestamp is exactly what
    // ruling 8 and app/api/apply/bundle gate a real submit dispatch on, and
    // neither status reflects an actual human re-review of anything.
    if (draft.status !== 'pending_review') {
      return reply({ error: `Draft is ${draft.status}, not pending_review — cannot approve.` }, 409)
    }
    const nowIso = new Date().toISOString()
    const { error: assistedErr } = await admin
      .from('application_drafts')
      .update({ status: 'approved', reviewed_at: nowIso, review_confirmed_at: nowIso, updated_at: nowIso })
      .eq('id', draftId)
      .eq('user_id', user.id)
    if (assistedErr) return reply({ error: assistedErr.message }, 500)
    return reply({ ok: true, status: 'approved', assisted: true })
  }

  // Load job + company + profile.
  const { data: jobData, error: jobErr } = await admin
    .from('person_jobs')
    .select('id, url, description, company_id:viewer_company_id, viewer_company_metadata')
    .eq('viewer_id', user.id)
    .eq('id', draft.job_id)
    .single()
  if (jobErr || !jobData) {
    return reply({ error: 'Job not found for draft' }, 404)
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
  const credentials = resolveApplyCredentials(job.viewer_company_metadata, profile?.preferences)

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

  const reviewedNowIso = new Date().toISOString()
  const { error: updErr } = await admin
    .from('application_drafts')
    .update({
      status,
      answers,
      submission_ref: submissionRef,
      submitted_at: status === 'submitted' ? reviewedNowIso : null,
      reviewed_at: reviewedNowIso,
      // Official-API drafts have no separate human-click submit step (the
      // approve click here already IS the authorization submitApplication()
      // acted on above), so this is stamped for consistency with the review
      // surface rather than gating anything further downstream for this path.
      review_confirmed_at: reviewedNowIso,
      updated_at: reviewedNowIso,
    })
    .eq('id', draftId)
    .eq('user_id', user.id)
  if (updErr) return reply({ error: updErr.message }, 500)

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

  return reply({ ok: true, status, submissionRef, handoffUrl, provider })
}
