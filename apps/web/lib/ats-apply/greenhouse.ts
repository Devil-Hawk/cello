// Greenhouse — official Job Board API application submission.
//
//   POST https://boards-api.greenhouse.io/v1/boards/{board}/jobs/{jobId}
//
// Auth: HTTP Basic with the board's Job Board API key (key as username, no
// password) — "found on the API Credentials page", i.e. the EMPLOYER's console.
// This is Greenhouse's documented, official submission endpoint — no scraping,
// no browser automation. (The hosted board renderer at job-boards.greenhouse.io
// runs reCAPTCHA Enterprise; that route is out of bounds by hard boundary 1.)
//
// THE RULE THAT SHAPES THIS FILE
//   "Greenhouse will not confirm the inclusion of required fields. Validation
//    for required fields must be done on the client side, as Greenhouse will
//    not reject applications that are missing required fields."
//    — developers.greenhouse.io/job-board.html#submit-an-application
//
// A POST that omits a required question therefore SUCCEEDS, and a half-answered
// application lands in the employer's pipeline under the user's real name with
// nothing to show it went wrong. That is why capability.ts reads the public
// `?questions=true` schema first and blocks anything it cannot complete, and
// why this adapter sends only the documented standard fields.
//
// WHAT IS DELIBERATELY NEVER SENT
//   Greenhouse accepts `gender`, `race`, `veteran_status`, `disability_status`
//   and `demographic_answers[]`. None of them are ever populated here, at any
//   value, including "decline to state" — declining is itself an answer and it
//   is the user's to give. Same for `data_compliance[*]` consent flags: ticking
//   a consent box on someone's behalf is not consent. See NEVER_SUBMITTED_FIELDS
//   in capability.ts and the assertion below that keeps this honest.

import type { ApplyContent, ApplyProfile, DetectedApply } from './types'
import { NEVER_SUBMITTED_FIELDS } from './capability'
import { postJson, ApplyHttpError } from './http'

const API_HOSTS = new Set(['boards-api.greenhouse.io', 'boards-api.eu.greenhouse.io'])

function apiHostFor(target: DetectedApply): string {
  return target.host.includes('.eu.') ? 'boards-api.eu.greenhouse.io' : 'boards-api.greenhouse.io'
}

function basicAuth(apiKey: string): string {
  // Greenhouse uses the API key as the Basic-auth username with an empty password.
  return `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`
}

interface GreenhouseSubmitResponse {
  success?: string
  status?: number
  id?: number | string
  error?: string
}

export interface GreenhouseSubmitOutcome {
  submissionRef: string
  endpoint: string
  body: Record<string, unknown>
}

/**
 * Submit an application to a Greenhouse board. Returns a submission ref on
 * success; throws on transport/HTTP failure so the caller records status
 * 'failed'. Never falls back to any non-API path.
 */
export async function submitGreenhouse(
  target: DetectedApply,
  apiKey: string,
  profile: ApplyProfile,
  content: ApplyContent,
  signal?: AbortSignal
): Promise<GreenhouseSubmitOutcome> {
  if (!target.jobId) throw new Error('greenhouse: missing numeric job id in posting URL')

  // Preference order: the real tailored/base resume document, then the raw
  // profile resume text, and ONLY as a last resort the 2-4 sentence cv_tailor
  // summary blurb (never fabricated, but never a substitute for the resume).
  const resumeText =
    content.resumeFullText?.trim() || profile.resumeText?.trim() || content.resumeSummary?.trim() || ''
  const body: Record<string, unknown> = {
    first_name: profile.firstName,
    last_name: profile.lastName,
    email: profile.email,
  }
  if (profile.phone) body.phone = profile.phone
  if (resumeText) {
    body.resume_content = Buffer.from(resumeText, 'utf-8').toString('base64')
    body.resume_content_filename = 'resume.txt'
  }
  const cover = content.coverLetter?.trim()
  if (cover) {
    body.cover_letter_content = Buffer.from(cover, 'utf-8').toString('base64')
    body.cover_letter_content_filename = 'cover-letter.txt'
  }
  if (profile.linkedin) body.linkedin_profile = profile.linkedin
  if (profile.website) body.website = profile.website

  // `location` is omitted on purpose. Greenhouse ignores it unless `latitude`
  // and `longitude` accompany it ("If only `location` is sent and `latitude`
  // and `longitude` are omitted, `location` will be ignored entirely"), and
  // those come from a Places lookup we do not run. Sending a bare string would
  // look like an answered field while answering nothing.

  assertNoSensitiveFields(body)

  const host = apiHostFor(target)
  const url = `https://${host}/v1/boards/${target.slug}/jobs/${target.jobId}`

  try {
    const res = await postJson<GreenhouseSubmitResponse>(url, body, {
      allowedHosts: API_HOSTS,
      headers: { authorization: basicAuth(apiKey) },
      signal,
    })
    const ref = res?.id != null ? String(res.id) : `${target.slug}/${target.jobId}`
    return { submissionRef: `greenhouse:${ref}`, endpoint: url, body }
  } catch (err) {
    if (err instanceof ApplyHttpError) {
      throw new Error(`greenhouse submit failed (HTTP ${err.status}): ${err.body || err.message}`)
    }
    throw err
  }
}

/**
 * Last line of defence before the wire: refuse to send a body carrying a
 * demographic/EEO/legal answer, whatever put it there. Nothing in this file
 * writes these keys — the assertion exists so that a future edit, or a caller
 * who learns to merge extra fields into the body, cannot make Cello answer a
 * question that was never Cello's to answer.
 */
function assertNoSensitiveFields(body: Record<string, unknown>): void {
  for (const field of NEVER_SUBMITTED_FIELDS) {
    if (field in body) {
      throw new Error(
        `greenhouse: refusing to submit — "${field}" is a demographic/legal answer that only the applicant may give`
      )
    }
  }
  if ('data_compliance' in body) {
    throw new Error(
      'greenhouse: refusing to submit — data_compliance consent must come from the applicant, not from Cello'
    )
  }
}
