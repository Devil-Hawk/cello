// Lever — official postings apply API.
//
//   POST https://api.lever.co/v0/postings/{site}/{postingId}?key={apiKey}
//
// CORRECTED 2026-08-03 against the vendor's own reference
// (github.com/lever/postings-api#apply-to-a-job-posting). This adapter
// previously posted to `/v0/postings/{site}/{id}/apply` with an
// `Authorization: Basic` header. Both were wrong:
//
//   * There is no `/apply` suffix. The documented path is the posting path
//     itself; the verb is what distinguishes reading from applying.
//   * Lever does not read an Authorization header here. The key is a QUERY
//     PARAMETER: "POST /v0/postings/SITE/POSTING-ID?key=APIKEY". Verified
//     empirically with a NON-MUTATING OPTIONS request to the documented path,
//     which answered `{"ok":false,"error":"You need an API key. Please contact
//     support@lever.co for a key"}` — i.e. the endpoint exists and is
//     key-gated exactly as documented.
//
// This uses Lever's official API surface; it does NOT drive the hosted
// jobs.lever.co form. That form loads js.hcaptcha.com and posts an invisible
// hCaptcha token in a hidden `h-captcha-response` input (confirmed by GET on
// 2026-08-03), and solving or routing around a challenge is off-limits — see
// the handoff route instead.
//
// KNOWN LIMITATION, DELIBERATE: Lever accepts a resume ONLY in
// multipart/form-data mode ("Only in `multipart/form-data` mode. Should be a
// file."). We submit JSON, so we send the resume as `comments` text rather
// than pretending a JSON string field will arrive as an attachment — silently
// dropping the resume would be the worse failure. `submitLever` reports which
// carrier it used so the attempt record is honest about it.

import type { ApplyContent, ApplyProfile, DetectedApply } from './types'
import { postJson, ApplyHttpError } from './http'

const API_HOSTS = new Set(['api.lever.co', 'api.eu.lever.co'])

function apiHostFor(target: DetectedApply): string {
  return target.host.includes('.eu.') ? 'api.eu.lever.co' : 'api.lever.co'
}

interface LeverSubmitResponse {
  ok?: boolean
  applicationId?: string
  id?: string
  error?: string
}

export interface LeverSubmitOutcome {
  submissionRef: string
  /** URL actually posted to, with the key redacted — for the attempt record. */
  endpoint: string
  /** The JSON body sent, so the caller can attest to it. Never has the key. */
  body: Record<string, unknown>
}

/** Build the documented apply URL. Exported so the attempt record can redact it. */
export function leverApplyUrl(target: DetectedApply, apiKey: string): string {
  const host = apiHostFor(target)
  return `https://${host}/v0/postings/${target.slug}/${target.jobId}?key=${encodeURIComponent(apiKey)}`
}

/** The same URL with the credential removed — safe to persist and to log. */
export function leverApplyUrlRedacted(target: DetectedApply): string {
  return `https://${apiHostFor(target)}/v0/postings/${target.slug}/${target.jobId}?key=REDACTED`
}

export async function submitLever(
  target: DetectedApply,
  apiKey: string,
  profile: ApplyProfile,
  content: ApplyContent,
  signal?: AbortSignal
): Promise<LeverSubmitOutcome> {
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

  // `comments` is Lever's documented free-text field ("Additional information
  // from the candidate"). The cover letter leads because that is what a
  // recruiter expects to read there; the resume follows it under a header so
  // the text is never lost just because JSON mode cannot carry a file.
  const cover = content.coverLetter?.trim()
  const commentParts: string[] = []
  if (cover) commentParts.push(cover)
  if (resumeText) commentParts.push(`--- Resume ---\n${resumeText}`)
  if (commentParts.length > 0) body.comments = commentParts.join('\n\n')

  const urls: Record<string, string> = {}
  if (profile.linkedin) urls.LinkedIn = profile.linkedin
  if (profile.website) urls.Portfolio = profile.website
  if (Object.keys(urls).length > 0) body.urls = urls

  // `silent` is left unset ON PURPOSE. Lever emails the candidate a
  // confirmation unless it is true, and that email is the user's own receipt
  // that something went out in their name. Suppressing it would make the
  // product harder to audit for the person it acts for.

  const url = leverApplyUrl(target, apiKey)

  try {
    const res = await postJson<LeverSubmitResponse>(url, body, {
      allowedHosts: API_HOSTS,
      signal,
    })
    // Lever answers 200 with {ok:false,error} for some rejections, so a 2xx is
    // not by itself proof the application landed.
    if (res && res.ok === false) {
      throw new Error(`lever submit rejected: ${res.error ?? 'unknown error'}`)
    }
    const ref = res?.applicationId || res?.id || `${target.slug}/${target.jobId}`
    return { submissionRef: `lever:${ref}`, endpoint: leverApplyUrlRedacted(target), body }
  } catch (err) {
    if (err instanceof ApplyHttpError) {
      // 429 is documented and expected above 2 applications/second. Name it, so
      // a caller batching a confirmed set knows to slow down rather than retry
      // blindly and lose the application.
      if (err.status === 429) {
        throw new Error(
          'lever submit rate-limited (HTTP 429): Lever allows 2 application POSTs/second. ' +
            'Retry this application rather than dropping it.'
        )
      }
      throw new Error(`lever submit failed (HTTP ${err.status}): ${err.body || err.message}`)
    }
    throw err
  }
}
