// lib/ats-apply — official-ATS application submission (WRITE side).
//
// One entry point, submitApplication(), used by BOTH the applier agent
// (lib/harness/agents/applier.ts) and the human-approve route
// (app/api/drafts/approve). It enforces the hard boundary: official APIs only,
// credential-gated, human handoff otherwise. See types.ts for the full policy.

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  ApplyContent,
  ApplyCredentials,
  ApplyProfile,
  ApplyProviderId,
  ApplyResult,
  DetectedApply,
  HandoffField,
} from './types'
import { detectApplyTarget, buildApplyUrl } from './detect'
import { buildHandoffFields } from './fields'
import { assessReadiness, scanKnockouts } from './readiness'
import { submitGreenhouse } from './greenhouse'
import { submitLever } from './lever'
import { submitAshby } from './ashby'
import { getBaseResume, getLatestVersion } from '@/lib/resume/store'

export type {
  ApplyProviderId,
  ApplyProfile,
  ApplyContent,
  ApplyCredentials,
  ApplyResult,
  DetectedApply,
  DraftAnswers,
  HandoffField,
} from './types'
export { detectApplyTarget, buildApplyUrl } from './detect'
export { buildHandoffFields, splitName, DEFERRED_FIELD_LABELS } from './fields'
export { assessReadiness, scanKnockouts } from './readiness'

export interface SubmitApplicationParams {
  jobUrl: string
  profile: ApplyProfile
  content: ApplyContent
  jobDescription?: string | null
  credentials?: ApplyCredentials
  signal?: AbortSignal
  /**
   * Optional resume_documents lookup context. When `client` + `userId` are
   * both supplied and `content.resumeFullText` isn't already set,
   * submitApplication() resolves the real resume text — the newest tailored
   * version for `jobId` (public.resume_documents.job_id), falling back to
   * the newest BASE version — instead of silently leaving employers to
   * receive `resumeSummary` (a 2-4 sentence blurb) as the resume attachment.
   * `client` should be the service-role admin client (see
   * lib/resume/store.ts's header) or an RLS-scoped client for this user.
   * Omit either field to keep the old behavior (content passed through
   * unchanged) — this is additive and backward compatible.
   */
  client?: SupabaseClient
  userId?: string
  /** The `jobs.id` row this application targets (NOT `target.jobId`, which is the ATS's own posting id). */
  jobId?: string
}

/**
 * Fill in ApplyContent.resumeFullText from the most recent resume_documents
 * row for this (user, job) — the tailored version when one exists, else the
 * user's base resume version — when the caller supplied enough context and
 * hadn't already set it. This is what makes resumeFullText non-inert: see
 * greenhouse.ts / lever.ts / ashby.ts for the per-adapter preference order
 * (resumeFullText || profile.resumeText || resumeSummary) that consumes it.
 *
 * Best-effort only: a lookup failure must never block an application
 * attempt, so it's caught and logged, and the adapters' own fallback chain
 * (profile.resumeText, then resumeSummary) still applies.
 */
async function resolveResumeFullText(params: SubmitApplicationParams): Promise<ApplyContent> {
  const { content, client, userId, jobId } = params
  if (content.resumeFullText?.trim() || !client || !userId) return content

  try {
    const tailored = jobId ? await getLatestVersion(client, userId, jobId) : null
    const doc = tailored ?? (await getBaseResume(client, userId))
    const resumeFullText = doc?.content?.trim()
    if (resumeFullText) return { ...content, resumeFullText }
  } catch (err) {
    console.error('ats-apply: resume_documents lookup failed, falling back to profile resume text', err)
  }
  return content
}

/**
 * Prepare + (when safe) submit an application through an official ATS API.
 *
 * Returns:
 *   - { outcome: 'submitted' }  official POST succeeded
 *   - { outcome: 'handoff'   }  human must finish (no credential, knock-out
 *                               question, unsupported ATS, or missing identity)
 *   - { outcome: 'failed'    }  an official submit was attempted and errored
 *
 * NEVER performs a non-API submission. The handoff branch is the default.
 */
export async function submitApplication(params: SubmitApplicationParams): Promise<ApplyResult> {
  const { jobUrl, profile, jobDescription, credentials, signal } = params

  const target = detectApplyTarget(jobUrl)
  if (!target) {
    return {
      outcome: 'handoff',
      provider: null,
      prefilledUrl: jobUrl,
      reason: 'Posting is not a recognized official ATS (Greenhouse/Lever/Ashby); apply manually.',
      fields: [],
    }
  }

  // Resolved AFTER the target check so an unsupported-ATS URL never pays for
  // a resume_documents lookup it can't use.
  const content = await resolveResumeFullText(params)

  const provider = target.provider
  const fields = buildHandoffFields(provider, profile, content)
  const credential = credentials?.[provider]
  const applyUrl = buildApplyUrl(target, jobUrl)

  const readiness = assessReadiness({
    provider,
    hasCredential: !!credential,
    profile,
    jobDescription,
    resumeSummary: content.resumeSummary,
    coverLetter: content.coverLetter,
  })

  if (!readiness.ready || !credential) {
    return {
      outcome: 'handoff',
      provider,
      prefilledUrl: applyUrl,
      reason: readiness.issues.join(' '),
      fields,
    }
  }

  // Ready + credentialed → attempt the official submit.
  try {
    const result = await submitByProvider(provider, target, credential, profile, content, signal)
    return { outcome: 'submitted', submissionRef: result.submissionRef, provider }
  } catch (err) {
    return {
      outcome: 'failed',
      provider,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function submitByProvider(
  provider: ApplyProviderId,
  target: DetectedApply,
  credential: string,
  profile: ApplyProfile,
  content: ApplyContent,
  signal?: AbortSignal
): Promise<{ submissionRef: string }> {
  switch (provider) {
    case 'greenhouse':
      return submitGreenhouse(target, credential, profile, content, signal)
    case 'lever':
      return submitLever(target, credential, profile, content, signal)
    case 'ashby':
      return submitAshby(target, credential, profile, content, signal)
    default:
      throw new Error(`unsupported provider: ${provider}`)
  }
}

// --- Profile + credential assembly helpers ----------------------------------

interface ProfileRowLike {
  full_name?: string | null
  email?: string | null
  resume_text?: string | null
  preferences?: unknown
}

/** Read a nested contact field from preferences.contact (best-effort). */
function contactField(preferences: unknown, key: string): string | undefined {
  if (!preferences || typeof preferences !== 'object') return undefined
  const contact = (preferences as Record<string, unknown>).contact
  if (!contact || typeof contact !== 'object') return undefined
  const value = (contact as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Assemble the ApplyProfile Cello is allowed to auto-map from a profiles row. */
export function buildApplyProfile(row: ProfileRowLike): ApplyProfile {
  const fullName = (row.full_name ?? '').trim()
  const parts = fullName.split(/\s+/).filter(Boolean)
  const firstName = parts[0] ?? ''
  const lastName = parts.slice(1).join(' ')
  return {
    firstName,
    lastName,
    fullName,
    email: (row.email ?? '').trim(),
    phone: contactField(row.preferences, 'phone'),
    location: contactField(row.preferences, 'location'),
    linkedin: contactField(row.preferences, 'linkedin'),
    website: contactField(row.preferences, 'website') ?? contactField(row.preferences, 'portfolio'),
    resumeText: row.resume_text ?? undefined,
  }
}

/**
 * Resolve official apply credentials from (a) the company's ATS metadata
 * (companies.metadata.ats.applyKey — an employer-provided board key a power
 * user configured) and (b) the user's preferences.autopilot.atsKeys.
 */
export function resolveApplyCredentials(
  companyMetadata: unknown,
  preferences: unknown
): ApplyCredentials {
  const creds: ApplyCredentials = {}

  // From preferences.autopilot.atsKeys.{provider}
  if (preferences && typeof preferences === 'object') {
    const autopilot = (preferences as Record<string, unknown>).autopilot
    if (autopilot && typeof autopilot === 'object') {
      const keys = (autopilot as Record<string, unknown>).atsKeys
      if (keys && typeof keys === 'object') {
        for (const p of ['greenhouse', 'lever', 'ashby'] as const) {
          const v = (keys as Record<string, unknown>)[p]
          if (typeof v === 'string' && v.trim()) creds[p] = v.trim()
        }
      }
    }
  }

  // From companies.metadata.ats { provider, applyKey } — overrides for that provider.
  if (companyMetadata && typeof companyMetadata === 'object') {
    const ats = (companyMetadata as Record<string, unknown>).ats
    if (ats && typeof ats === 'object') {
      const provider = (ats as Record<string, unknown>).provider
      const applyKey = (ats as Record<string, unknown>).applyKey
      if (
        (provider === 'greenhouse' || provider === 'lever' || provider === 'ashby') &&
        typeof applyKey === 'string' &&
        applyKey.trim()
      ) {
        creds[provider] = applyKey.trim()
      }
    }
  }

  return creds
}

/** Build the DraftAnswers jsonb payload from a submit result. */
export function buildDraftAnswers(
  provider: ApplyProviderId | null,
  jobUrl: string,
  fields: HandoffField[],
  result: ApplyResult,
  jobDescription?: string | null
): import('./types').DraftAnswers {
  const deferred = scanKnockouts(jobDescription)
  const answers: import('./types').DraftAnswers = {
    provider,
    jobUrl,
    fields,
  }
  if (deferred.length > 0) answers.deferredToHuman = deferred
  if (result.outcome === 'handoff') {
    answers.handoff = { prefilledUrl: result.prefilledUrl, reason: result.reason }
  } else if (result.outcome === 'submitted') {
    answers.submission = { ref: result.submissionRef, at: new Date().toISOString() }
  }
  return answers
}
