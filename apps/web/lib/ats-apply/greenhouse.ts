// Greenhouse — official Job Board API application submission.
// POST https://boards-api.greenhouse.io/v1/boards/{board}/jobs/{jobId}
// Auth: HTTP Basic with the board's Job Board API key (key as username, no
// password). This is Greenhouse's documented, official submission endpoint — no
// scraping, no browser automation.

import type { ApplyContent, ApplyProfile, DetectedApply } from './types'
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
): Promise<{ submissionRef: string }> {
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

  const host = apiHostFor(target)
  const url = `https://${host}/v1/boards/${target.slug}/jobs/${target.jobId}`

  try {
    const res = await postJson<GreenhouseSubmitResponse>(url, body, {
      allowedHosts: API_HOSTS,
      headers: { authorization: basicAuth(apiKey) },
      signal,
    })
    const ref = res?.id != null ? String(res.id) : `${target.slug}/${target.jobId}`
    return { submissionRef: `greenhouse:${ref}` }
  } catch (err) {
    if (err instanceof ApplyHttpError) {
      throw new Error(`greenhouse submit failed (HTTP ${err.status}): ${err.body || err.message}`)
    }
    throw err
  }
}
