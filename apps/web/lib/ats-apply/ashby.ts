// Ashby — official application submission API.
// POST https://api.ashbyhq.com/applicationForm.submit
// Auth: HTTP Basic with the org's Ashby API key (key as username). Official API
// surface only; no hosted-form automation. Ashby dedups candidates by email per
// org (career-ops apply.md "Known ATS Quirks") — a repeat email silently merges,
// so the caller's dedup guard (one draft per job) matters here.

import type { ApplyContent, ApplyProfile, DetectedApply } from './types'
import { postJson, ApplyHttpError } from './http'

const API_HOSTS = new Set(['api.ashbyhq.com'])
const SUBMIT_URL = 'https://api.ashbyhq.com/applicationForm.submit'

function basicAuth(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`
}

interface AshbySubmitResponse {
  success?: boolean
  results?: { id?: string; submittedFormInstanceId?: string }
  errors?: unknown
}

export async function submitAshby(
  target: DetectedApply,
  apiKey: string,
  profile: ApplyProfile,
  content: ApplyContent,
  signal?: AbortSignal
): Promise<{ submissionRef: string }> {
  if (!target.jobId) throw new Error('ashby: missing job posting id in URL')

  const fieldSubmissions: { path: string; value: unknown }[] = [
    { path: '_systemfield_name', value: profile.fullName || `${profile.firstName} ${profile.lastName}`.trim() },
    { path: '_systemfield_email', value: profile.email },
  ]
  if (profile.phone) fieldSubmissions.push({ path: '_systemfield_phone', value: profile.phone })
  if (profile.linkedin) fieldSubmissions.push({ path: 'linkedin', value: profile.linkedin })

  // Preference order: the real tailored/base resume document, then the raw
  // profile resume text, and ONLY as a last resort the 2-4 sentence cv_tailor
  // summary blurb (never fabricated, but never a substitute for the resume).
  const resumeText =
    content.resumeFullText?.trim() || profile.resumeText?.trim() || content.resumeSummary?.trim() || ''
  const body: Record<string, unknown> = {
    jobPostingId: target.jobId,
    applicationForm: { fieldSubmissions },
  }
  if (resumeText) body.resumeText = resumeText
  const cover = content.coverLetter?.trim()
  if (cover) body.coverLetterText = cover

  try {
    const res = await postJson<AshbySubmitResponse>(SUBMIT_URL, body, {
      allowedHosts: API_HOSTS,
      headers: { authorization: basicAuth(apiKey) },
      signal,
    })
    if (res && res.success === false) {
      throw new Error(`ashby submit rejected: ${JSON.stringify(res.errors ?? {}).slice(0, 500)}`)
    }
    const ref = res?.results?.id || res?.results?.submittedFormInstanceId || target.jobId
    return { submissionRef: `ashby:${ref}` }
  } catch (err) {
    if (err instanceof ApplyHttpError) {
      throw new Error(`ashby submit failed (HTTP ${err.status}): ${err.body || err.message}`)
    }
    throw err
  }
}
