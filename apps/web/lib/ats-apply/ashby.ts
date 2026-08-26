// Ashby — official application submission API.
//
//   POST https://api.ashbyhq.com/applicationForm.submit
//
// Auth: HTTP Basic with the ORG's Ashby API key as the username, blank
// password. The endpoint "Requires the `candidatesWrite` permission", and those
// keys are minted by an Ashby Admin at app.ashbyhq.com/admin/api/keys — an
// employer artifact, never something a candidate holds. Official API surface
// only; the hosted jobs.ashbyhq.com form ships a `recaptchaPublicSiteKey` and a
// hidden grecaptcha badge (confirmed by GET on 2026-08-03) and is therefore
// out of bounds — see the handoff route.
//
// CORRECTED 2026-08-03 against Ashby's own OpenAPI schema, embedded in
// developers.ashbyhq.com/reference/applicationformsubmit. The previous version
// of this adapter sent top-level `resumeText` and `coverLetterText` keys and
// read `results.id` from the response. None of those exist:
//
//   ApplicationFormSubmitRequest = {
//     jobPostingId: uuid,                          // required, UUID-shaped
//     applicationForm: { fieldSubmissions: [{ path, value }] },   // required
//     allowSubmissionForUnpublishedJobPosting: boolean,           // required
//     utmData?, tagIds?
//   }
//   ApplicationFormSubmitResult = {
//     submittedFormInstance: { id, formDefinition, submittedValues },
//     formMessages: { blocked, blockMessageForCandidateHtml }
//   }
//
// Everything else Ashby ignores (the schema is `additionalProperties: {}`), so
// the old body would have been accepted while quietly discarding the resume and
// the cover letter. That is the exact failure mode this workstream exists to
// stop, so both are now sent on their real form paths.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RESUME PROBLEM, AND WHY capability.ts BLOCKS THIS PROVIDER
//
// `_systemfield_resume` is a FILE field. In JSON mode Ashby requires its value
// to be a handle from file.createFileUploadHandle, which returns a presigned
// upload URL on a storage host we cannot know in advance — an unbounded
// outbound target that this module's SSRF posture (fixed host allowlists) is
// specifically built to refuse. Verifying that flow end-to-end needs a real
// org key and a real upload, and hard boundary 4 forbids test submissions.
//
// So we do not guess. capability.ts refuses an Ashby submit while a resume is
// present, and this adapter refuses too rather than sending a resume-less
// application in someone's name. If the upload flow is ever verified against a
// real key, the block in capability.ts is the single place to relax.
//
// Ashby dedups candidates by email per org (career-ops apply.md "Known ATS
// Quirks") — a repeat email silently merges, so the caller's dedup guard (one
// draft per job) matters here.

import type { ApplyContent, ApplyProfile, DetectedApply } from './types'
import { postJson, ApplyHttpError } from './http'

const API_HOSTS = new Set(['api.ashbyhq.com'])
const SUBMIT_URL = 'https://api.ashbyhq.com/applicationForm.submit'

/** Ashby posting ids are UUIDs; anything else is not a posting we can target. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function basicAuth(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`
}

interface AshbySubmitResponse {
  success?: boolean
  results?: {
    submittedFormInstance?: { id?: string }
    formMessages?: { blocked?: boolean; blockMessageForCandidateHtml?: string | null }
  }
  errors?: unknown
}

export interface AshbySubmitOutcome {
  submissionRef: string
  endpoint: string
  body: Record<string, unknown>
}

export async function submitAshby(
  target: DetectedApply,
  apiKey: string,
  profile: ApplyProfile,
  content: ApplyContent,
  signal?: AbortSignal
): Promise<AshbySubmitOutcome> {
  if (!target.jobId) throw new Error('ashby: missing job posting id in URL')
  if (!UUID_RE.test(target.jobId)) {
    throw new Error(`ashby: posting id "${target.jobId}" is not a UUID; refusing to submit against a guess`)
  }

  // Second line of defence behind capability.ts: an adapter must never be the
  // thing that quietly drops a resume. If there is resume content and no way to
  // attach it, this is not a submission we are willing to make.
  const resumeText =
    content.resumeFullText?.trim() || profile.resumeText?.trim() || content.resumeSummary?.trim() || ''
  if (resumeText) {
    throw new Error(
      'ashby: resume attachment requires file.createFileUploadHandle, which is unverified against a ' +
        'real org key — refusing to submit an application without the resume. Use the handoff link.'
    )
  }

  const fieldSubmissions: { path: string; value: unknown }[] = [
    { path: '_systemfield_name', value: profile.fullName || `${profile.firstName} ${profile.lastName}`.trim() },
    { path: '_systemfield_email', value: profile.email },
  ]
  if (profile.phone) fieldSubmissions.push({ path: '_systemfield_phone', value: profile.phone })
  if (profile.linkedin) fieldSubmissions.push({ path: '_systemfield_linkedin', value: profile.linkedin })
  const cover = content.coverLetter?.trim()
  if (cover) fieldSubmissions.push({ path: '_systemfield_coverletter', value: cover })

  const body: Record<string, unknown> = {
    jobPostingId: target.jobId,
    applicationForm: { fieldSubmissions },
    // Defaults to true in Ashby's schema. We send false deliberately: an
    // unpublished posting is one the employer took down, and an application
    // into a closed req is noise in someone's pipeline and a false "applied"
    // in the user's tracker.
    allowSubmissionForUnpublishedJobPosting: false,
  }

  try {
    const res = await postJson<AshbySubmitResponse>(SUBMIT_URL, body, {
      allowedHosts: API_HOSTS,
      headers: { authorization: basicAuth(apiKey) },
      signal,
    })
    // Ashby answers 200 with success:false for validation failures. Their docs
    // are explicit that ignoring this means "applications not being recorded
    // without any notification to the candidate" — so a 2xx is never enough.
    if (!res || res.success !== true) {
      throw new Error(`ashby submit rejected: ${JSON.stringify(res?.errors ?? {}).slice(0, 500)}`)
    }
    // A "blocked" submission was refused by an employer rule; the form instance
    // exists but the application did not land.
    if (res.results?.formMessages?.blocked === true) {
      throw new Error(
        `ashby submit blocked by an employer rule: ${
          res.results.formMessages.blockMessageForCandidateHtml ?? 'no reason given'
        }`
      )
    }
    const ref = res.results?.submittedFormInstance?.id || target.jobId
    return { submissionRef: `ashby:${ref}`, endpoint: SUBMIT_URL, body }
  } catch (err) {
    if (err instanceof ApplyHttpError) {
      throw new Error(`ashby submit failed (HTTP ${err.status}): ${err.body || err.message}`)
    }
    throw err
  }
}
