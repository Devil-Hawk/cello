// Lever — official postings apply API.
// POST https://api.lever.co/v0/postings/{site}/{postingId}/apply
// Auth: HTTP Basic with the site's Lever API key (key as username). This uses
// Lever's official API surface; it does NOT drive the hosted jobs.lever.co form
// (that path is captcha-gated and off-limits — see the handoff route instead).

import type { ApplyContent, ApplyProfile, DetectedApply } from './types'
import { postJson, ApplyHttpError } from './http'

const API_HOSTS = new Set(['api.lever.co', 'api.eu.lever.co'])

function apiHostFor(target: DetectedApply): string {
  return target.host.includes('.eu.') ? 'api.eu.lever.co' : 'api.lever.co'
}

function basicAuth(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`
}

interface LeverSubmitResponse {
  ok?: boolean
  applicationId?: string
  id?: string
  error?: string
}

export async function submitLever(
  target: DetectedApply,
  apiKey: string,
  profile: ApplyProfile,
  content: ApplyContent,
  signal?: AbortSignal
): Promise<{ submissionRef: string }> {
  if (!target.jobId) throw new Error('lever: missing posting id in URL')

  // Preference order: the real tailored/base resume document, then the raw
  // profile resume text, and ONLY as a last resort the 2-4 sentence cv_tailor
  // summary blurb (never fabricated, but never a substitute for the resume).
  const resumeText =
    content.resumeFullText?.trim() || profile.resumeText?.trim() || content.resumeSummary?.trim() || ''
  const body: Record<string, unknown> = {
    name: profile.fullName || `${profile.firstName} ${profile.lastName}`.trim(),
    email: profile.email,
  }
  if (profile.phone) body.phone = profile.phone
  if (resumeText) body.resume = resumeText
  const cover = content.coverLetter?.trim()
  if (cover) body.comments = cover
  const urls: Record<string, string> = {}
  if (profile.linkedin) urls.LinkedIn = profile.linkedin
  if (profile.website) urls.Portfolio = profile.website
  if (Object.keys(urls).length > 0) body.urls = urls

  const host = apiHostFor(target)
  const url = `https://${host}/v0/postings/${target.slug}/${target.jobId}/apply`

  try {
    const res = await postJson<LeverSubmitResponse>(url, body, {
      allowedHosts: API_HOSTS,
      headers: { authorization: basicAuth(apiKey) },
      signal,
    })
    const ref = res?.applicationId || res?.id || `${target.slug}/${target.jobId}`
    return { submissionRef: `lever:${ref}` }
  } catch (err) {
    if (err instanceof ApplyHttpError) {
      throw new Error(`lever submit failed (HTTP ${err.status}): ${err.body || err.message}`)
    }
    throw err
  }
}
