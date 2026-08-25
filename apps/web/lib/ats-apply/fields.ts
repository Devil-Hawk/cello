// Build the prefilled field map shown in the human-handoff view and stored in
// application_drafts.answers. These are IDENTITY + LINK fields only — the fields
// an ATS can accept from us without fabricating anything.
//
// Ported from career-ops `prepare-application.mjs` (buildGreenhouseFields /
// buildAshbyFields / buildLeverFields). We deliberately DO NOT map legal,
// demographic, work-authorization, visa/sponsorship, or salary fields — those
// are always deferred to the human (see DEFERRED_FIELD_LABELS).
//
// Portions adapted from career-ops, MIT License:
//   Copyright (c) 2026 Santiago Fernández de Valderrama
//   (full text in career-ops/LICENSE).

import type { ApplyContent, ApplyProfile, ApplyProviderId, HandoffField } from './types'

/** Field categories we NEVER auto-answer; surfaced so the human completes them. */
export const DEFERRED_FIELD_LABELS = [
  'Work authorization / visa sponsorship',
  'Demographic / EEO self-identification',
  'Disability & veteran status',
  'Salary expectation',
  'Background-check consent',
] as const

function coverBlurb(content: ApplyContent): string | null {
  const cover = content.coverLetter?.trim()
  if (!cover) return null
  const words = cover.split(/\s+/).filter(Boolean).length
  const preview = cover.slice(0, 80).replace(/\s+/g, ' ')
  return `${words} words — ${preview}${cover.length > 80 ? '…' : ''}`
}

/**
 * Standard field map keyed by the labels each ATS uses on its hosted form, so a
 * human copy/pasting during handoff sees familiar names. Empty values are
 * dropped. Returns [label, value][].
 */
export function buildHandoffFields(
  provider: ApplyProviderId,
  profile: ApplyProfile,
  content: ApplyContent
): HandoffField[] {
  const cover = coverBlurb(content)
  const rows: (HandoffField | null)[] = []

  if (provider === 'greenhouse') {
    rows.push(
      ['first_name', profile.firstName],
      ['last_name', profile.lastName],
      ['email', profile.email],
      profile.phone ? ['phone', profile.phone] : null,
      ['resume', 'attach resume.txt (generated from your profile resume)'],
      cover ? ['cover_letter', cover] : null,
      profile.linkedin ? ['linkedin_profile', profile.linkedin] : null,
      profile.website ? ['website', profile.website] : null
    )
  } else if (provider === 'ashby') {
    rows.push(
      ['firstName', profile.firstName],
      ['lastName', profile.lastName],
      ['email', profile.email],
      profile.phone ? ['phone', profile.phone] : null,
      ['resume', 'attach resume.txt (generated from your profile resume)'],
      cover ? ['coverLetter', cover] : null,
      profile.linkedin ? ['linkedInUrl', profile.linkedin] : null
    )
  } else {
    // lever
    rows.push(
      ['name', profile.fullName || `${profile.firstName} ${profile.lastName}`.trim()],
      ['email', profile.email],
      profile.phone ? ['phone', profile.phone] : null,
      ['resume', 'attach resume.txt (generated from your profile resume)'],
      cover ? ['comments', cover] : null,
      profile.linkedin ? ['urls[LinkedIn]', profile.linkedin] : null,
      profile.website ? ['urls[Portfolio]', profile.website] : null
    )
  }

  return rows.filter((r): r is HandoffField => r !== null && !!r[1])
}

/** Split a full name into first / last for ATS forms that separate them. */
export function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { firstName: '', lastName: '' }
  if (parts.length === 1) return { firstName: parts[0], lastName: '' }
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') }
}
