// Agent: applier — build an application_draft and (only under policy) submit it
// through an official ATS API.
//
// OWNER: P4 apply workstream. HARD BOUNDARIES (enforced in code):
//   - Submissions ONLY via official ATS application APIs (lib/ats-apply).
//   - Default flow is the human-approve queue: the draft is created
//     'pending_review' and NOT submitted unless input.autoSubmit is true.
//   - Auto-submit is credential-gated and readiness-gated; anything needing
//     human steps (no credential, captcha/knock-out question, unsupported ATS)
//     stays pending with a prefilled handoff link in answers — never a blind POST.
//   - DEDUPE: one draft per (user, job); never submit a job the user already
//     applied to (existing applications row).
//
// Persists to application_drafts via ctx.admin (service role). Output satisfies
// ApplierOutput.

import type { AgentFn } from '../types'
import { ApplierInput } from '../schemas'
import {
  submitApplication,
  buildApplyProfile,
  buildHandoffFields,
  buildDraftAnswers,
  resolveApplyCredentials,
  detectApplyTarget,
  buildApplyUrl,
  type ApplyContent,
  type ApplyResult,
  type DraftAnswers,
} from '@/lib/ats-apply'

type DraftStatus = 'pending_review' | 'approved' | 'submitted' | 'rejected' | 'failed'

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

/** Pull cv_tailor content from an explicit input or an upstream dep output. */
function resolveContent(ctx: Parameters<AgentFn>[0], input: ReturnType<typeof ApplierInput.parse>): ApplyContent {
  let resumeSummary = input.resumeSummary
  let coverLetter = input.coverLetter
  if (!resumeSummary || !coverLetter) {
    for (const dep of Object.values(ctx.deps)) {
      if (dep && typeof dep === 'object') {
        const d = dep as Record<string, unknown>
        if (!resumeSummary && typeof d.resumeSummary === 'string') resumeSummary = d.resumeSummary
        if (!coverLetter && typeof d.coverLetter === 'string') coverLetter = d.coverLetter
      }
    }
  }
  return { resumeSummary, coverLetter }
}

export const applier: AgentFn = async (ctx) => {
  const input = ApplierInput.parse(ctx.input ?? {})

  // 1) Load job + company metadata.
  const { data: jobData, error: jobErr } = await ctx.admin
    .from('jobs')
    .select('id, url, description, company_id, companies(metadata)')
    .eq('id', input.jobId)
    .single()
  if (jobErr || !jobData) {
    throw new Error(`applier: job ${input.jobId} not found: ${jobErr?.message ?? 'no row'}`)
  }
  const job = jobData as JobRow
  const jobUrl = job.url ?? ''

  // 2) DEDUPE — never touch a job the user has already applied to.
  const { data: existingApp } = await ctx.admin
    .from('applications')
    .select('id, stage')
    .eq('user_id', ctx.userId)
    .eq('job_id', input.jobId)
    .maybeSingle()

  const { data: existingDraft } = await ctx.admin
    .from('application_drafts')
    .select('id, status')
    .eq('user_id', ctx.userId)
    .eq('job_id', input.jobId)
    .maybeSingle()

  if (existingApp) {
    // Already in the pipeline — do not create/submit a duplicate.
    return {
      output: {
        draftId: (existingDraft?.id as string) ?? null,
        status: ((existingDraft?.status as DraftStatus) ?? 'submitted') as DraftStatus,
        handoffUrl: null,
        submissionRef: null,
      },
      tokensUsed: 0,
    }
  }

  // 3) Assemble identity + tailored content + credentials.
  const { data: profile } = await ctx.admin
    .from('profiles')
    .select('full_name, email, resume_text, preferences')
    .eq('id', ctx.userId)
    .single()

  const applyProfile = buildApplyProfile({
    full_name: profile?.full_name as string | null,
    email: profile?.email as string | null,
    resume_text: profile?.resume_text as string | null,
    preferences: profile?.preferences,
  })
  const content = resolveContent(ctx, input)
  const credentials = resolveApplyCredentials(companyMetadata(job), profile?.preferences)

  // 4) Decide the result: submit only under policy (autoSubmit), else prepare a
  //    handoff so the draft lands in the human-approve queue with a prefill link.
  let result: ApplyResult
  let status: DraftStatus
  if (input.autoSubmit) {
    result = await submitApplication({
      jobUrl,
      profile: applyProfile,
      content,
      jobDescription: job.description,
      credentials,
      signal: ctx.signal,
      // Lets submitApplication resolve the real tailored resume_documents
      // text (see lib/ats-apply/index.ts#resolveResumeFullText) instead of
      // falling back to `content.resumeSummary` (a 2-4 sentence blurb) as the
      // resume attachment sent to a real employer — mirrors
      // app/api/drafts/approve/route.ts's own call.
      client: ctx.admin,
      userId: ctx.userId,
      jobId: input.jobId,
    })
    status =
      result.outcome === 'submitted'
        ? 'submitted'
        : result.outcome === 'failed'
          ? 'failed'
          : 'pending_review' // handoff stays pending
  } else {
    result = prepareHandoff(jobUrl, applyProfile, content)
    status = 'pending_review'
  }

  // 5) Build answers jsonb + merge any planner-provided answers.
  const provider = result.provider
  const fields =
    result.outcome === 'handoff'
      ? result.fields
      : buildHandoffFields(provider ?? 'greenhouse', applyProfile, content)
  const answers: DraftAnswers = buildDraftAnswers(provider, jobUrl, fields, result, job.description)
  if (input.answers && typeof input.answers === 'object') {
    answers.plannerAnswers = input.answers
  }
  if (result.outcome === 'failed') answers.submitError = result.error

  const handoffUrl = result.outcome === 'handoff' ? result.prefilledUrl : null
  const submissionRef = result.outcome === 'submitted' ? result.submissionRef : null

  // 6) Upsert the draft (one per user+job).
  const row: Record<string, unknown> = {
    user_id: ctx.userId,
    job_id: input.jobId,
    run_id: ctx.runId,
    resume_summary: content.resumeSummary ?? null,
    cover_letter: content.coverLetter ?? null,
    answers,
    status,
    submission_ref: submissionRef,
    submitted_at: status === 'submitted' ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  }

  const { data: upserted, error: upsertErr } = await ctx.admin
    .from('application_drafts')
    .upsert(row, { onConflict: 'user_id,job_id' })
    .select('id')
    .single()
  if (upsertErr || !upserted) {
    throw new Error(`applier: failed to persist draft: ${upsertErr?.message ?? 'no row'}`)
  }

  return {
    output: {
      draftId: (upserted as { id: string }).id,
      status,
      handoffUrl,
      submissionRef,
    },
    tokensUsed: 0,
  }
}

/** Build a handoff-only result (no submit) for the default review-queue path. */
function prepareHandoff(jobUrl: string, profile: ReturnType<typeof buildApplyProfile>, content: ApplyContent): ApplyResult {
  const target = detectApplyTarget(jobUrl)
  if (!target) {
    return {
      outcome: 'handoff',
      provider: null,
      prefilledUrl: jobUrl,
      reason: 'Posting is not a recognized official ATS; apply manually.',
      fields: [],
    }
  }
  return {
    outcome: 'handoff',
    provider: target.provider,
    prefilledUrl: buildApplyUrl(target, jobUrl),
    reason: 'Prepared for review — approve to submit or open the prefilled form.',
    fields: buildHandoffFields(target.provider, profile, content),
  }
}
