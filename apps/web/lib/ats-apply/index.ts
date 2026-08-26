// lib/ats-apply — official-ATS application submission (WRITE side).
//
// One entry point, submitApplication(), used by BOTH the applier agent
// (lib/harness/agents/applier.ts) and the human-approve route
// (app/api/drafts/approve). See types.ts for the policy and capability.ts for
// the sourced, per-provider research the policy is built on.
//
// THE GATE, IN ONE PLACE
//   Deciding whether a POST may happen is capability.ts's job, not this file's.
//   submitApplication() gathers evidence (does a credential exist? did a human
//   confirm? what does the public form schema say?), hands it to
//   assessSubmitCapability(), and does exactly what it is told. That separation
//   is deliberate: the decision is the part that must be reviewable and
//   testable in isolation, and it now is.
//
//   The gate is strictly TIGHTER than the credential-only rule it replaced.
//   Nothing that could not submit before can submit now; several things that
//   COULD submit before (no human confirmation; a Greenhouse form with required
//   questions we cannot answer) now correctly refuse.

import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  ApplyAttemptRecord,
  ApplyContent,
  ApplyCredentials,
  ApplyProfile,
  ApplyProviderId,
  ApplyResult,
  DetectedApply,
  HandoffField,
  SubmitAuthorization,
} from './types'
import { isSubmitAuthorization } from './types'
import { detectApplyTarget, buildApplyUrl } from './detect'
import { buildHandoffFields } from './fields'
import { assessReadiness, scanKnockouts } from './readiness'
import {
  assessSubmitCapability,
  describeBlockers,
  fetchGreenhouseFormFacts,
  type CapabilityAssessment,
  type PostingFormFacts,
} from './capability'
import { submitGreenhouse } from './greenhouse'
import { submitLever } from './lever'
import { submitAshby } from './ashby'
import { getBaseResume, getLatestVersion } from '@/lib/resume/store'

export type {
  ApplyAttemptRecord,
  ApplyProviderId,
  ApplyProfile,
  ApplyContent,
  ApplyCredentials,
  ApplyResult,
  DetectedApply,
  DraftAnswers,
  HandoffField,
  SubmitAuthorization,
} from './types'
export { isSubmitAuthorization } from './types'
export { detectApplyTarget, buildApplyUrl } from './detect'
export { buildHandoffFields, splitName, DEFERRED_FIELD_LABELS } from './fields'
export { assessReadiness, scanKnockouts } from './readiness'
export {
  assessSubmitCapability,
  describeBlockers,
  fetchGreenhouseFormFacts,
  readGreenhouseFormFacts,
  PROVIDER_SUBMIT_FACTS,
  NEVER_SUBMITTED_FIELDS,
  AUTHORIZATION_MAX_AGE_MS,
  type CapabilityAssessment,
  type CapabilityBlocker,
  type CapabilityBlockerCode,
  type PostingFormFacts,
  type ProviderSubmitFacts,
  type SubmitRoute,
} from './capability'

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
  /**
   * The human's explicit confirmation for THIS batch — the one condition that
   * can never be inferred. Its ABSENCE is a refusal, not a default: without it
   * every call returns a handoff and nothing is ever sent.
   *
   * Optional in the type only so that callers which never submit (the applier
   * agent's non-autoSubmit path, draft staging) need not fabricate one. Any
   * caller that wants a submission MUST supply it; see
   * lib/harness/chains.ts#buildSubmitConfirmedPlan for where the confirmation
   * originates and `SubmitAuthorization` in types.ts for the shape.
   *
   * Accepts `unknown` because it usually arrives from JSON (a journaled plan
   * step input, a request body); it is validated with isSubmitAuthorization()
   * before it can authorize anything.
   */
  authorization?: unknown
  /**
   * Pre-resolved public form schema, when the caller already fetched it.
   * Supplying it skips the network read inside this function — useful for
   * tests and for batch flows that assessed a set of postings up front.
   * Omitting it means submitApplication fetches it itself for providers that
   * publish one; a fetch failure becomes a handoff, never a hopeful POST.
   */
  postingForm?: PostingFormFacts | null
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
/**
 * Look up the real résumé to attach, and say whether the lookup FAILED.
 *
 * WHY THE FAILURE FLAG EXISTS
 *   This used to swallow the error and `return content`, logging "falling back
 *   to profile resume text". But the thing it falls back to is
 *   `content.resumeSummary` — a two-to-four sentence blurb cv_tailor writes for
 *   internal use — and `hasResumeContent` downstream counted that blurb as
 *   having a résumé. So a transient resume_documents outage did not stop the
 *   submission; it silently downgraded the attachment and sent the blurb to a
 *   real employer AS THE CANDIDATE'S RÉSUMÉ, under their name, irreversibly.
 *
 *   That is the worst failure available in this module, and it happened on the
 *   most ordinary error there is. A submission is not undoable, so the only
 *   correct behaviour when we cannot prove we have the real document is to stop
 *   and hand off to the human — who still gets a prefilled link and loses
 *   nothing but the automation.
 *
 *   The distinction that matters is FAILED versus ABSENT. A user with no stored
 *   résumé is a normal, knowable state the capability assessment already
 *   handles. A lookup that THREW tells us nothing about what exists, and
 *   guessing in that state is what caused the bug.
 */
async function resolveResumeFullText(
  params: SubmitApplicationParams
): Promise<{ content: ApplyContent; lookupFailed: boolean }> {
  const { content, client, userId, jobId } = params
  if (content.resumeFullText?.trim() || !client || !userId) {
    return { content, lookupFailed: false }
  }

  try {
    const tailored = jobId ? await getLatestVersion(client, userId, jobId) : null
    const doc = tailored ?? (await getBaseResume(client, userId))
    const resumeFullText = doc?.content?.trim()
    if (resumeFullText) return { content: { ...content, resumeFullText }, lookupFailed: false }
  } catch (err) {
    console.error('ats-apply: resume_documents lookup FAILED — refusing to submit, handing off', err)
    return { content, lookupFailed: true }
  }
  // Reached cleanly with nothing stored: absent, not failed.
  return { content, lookupFailed: false }
}

/** SHA-256 hex of a string — the primitive behind every attestation below. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex')
}

/**
 * Build the evidentiary record for one attempt.
 *
 * Scalar values are kept verbatim because they are short and they are what the
 * employer actually reads; the resume and cover letter are kept as
 * {chars, sha256} so the user can prove which document went out by re-hashing
 * their own copy, without a resume being duplicated into every draft row. The
 * credential never appears — endpoints are recorded pre-redacted by the
 * adapters, and no header is ever captured.
 */
function buildAttemptRecord(args: {
  provider: ApplyProviderId | null
  route: 'official-api' | 'handoff'
  outcome: 'submitted' | 'failed' | 'handoff'
  profile: ApplyProfile
  content: ApplyContent
  authorization: SubmitAuthorization | null
  assessment: CapabilityAssessment | null
  endpoint?: string
  body?: Record<string, unknown>
  submissionRef?: string
  error?: string
}): ApplyAttemptRecord {
  const { profile, content } = args
  const sentValues: Record<string, string> = {}
  const put = (k: string, v: string | undefined) => {
    if (v && v.trim()) sentValues[k] = v.trim()
  }
  // Only ever the identity/link fields — the same closed set fields.ts maps.
  // Nothing here reads a demographic, legal or salary value, because none is
  // ever collected in ApplyProfile in the first place.
  put('first_name', profile.firstName)
  put('last_name', profile.lastName)
  put('email', profile.email)
  put('phone', profile.phone)
  put('linkedin', profile.linkedin)
  put('website', profile.website)

  const attachments: ApplyAttemptRecord['attachments'] = []
  const resume = content.resumeFullText?.trim() || profile.resumeText?.trim() || content.resumeSummary?.trim()
  if (resume) attachments.push({ field: 'resume', chars: resume.length, sha256: sha256(resume) })
  const cover = content.coverLetter?.trim()
  if (cover) attachments.push({ field: 'cover_letter', chars: cover.length, sha256: sha256(cover) })

  const record: ApplyAttemptRecord = {
    at: new Date().toISOString(),
    provider: args.provider,
    route: args.route,
    endpoint: args.endpoint ?? null,
    method: args.route === 'official-api' ? 'POST' : null,
    contentType: args.route === 'official-api' ? 'application/json' : null,
    sentValues,
    attachments,
    bodySha256: args.body ? sha256(JSON.stringify(args.body)) : null,
    authorization: args.authorization
      ? {
          source: args.authorization.source,
          confirmedAt: args.authorization.at,
          batchId: args.authorization.batchId ?? null,
        }
      : null,
    outcome: args.outcome,
  }
  if (args.submissionRef) record.submissionRef = args.submissionRef
  if (args.error) record.error = args.error
  if (args.assessment && args.assessment.blockers.length > 0) record.blockers = args.assessment.blockers
  if (args.assessment && args.assessment.warnings.length > 0) record.warnings = args.assessment.warnings
  return record
}

/**
 * Prepare + (when authorized AND capable) submit an application through an
 * official ATS API.
 *
 * Returns:
 *   - { outcome: 'submitted' }  official POST succeeded
 *   - { outcome: 'handoff'   }  a human must finish it — and `attempt.blockers`
 *                               says exactly why, in words safe to show them
 *   - { outcome: 'failed'    }  an official submit was attempted and errored
 *
 * Every branch carries an `attempt` record. NEVER performs a non-API
 * submission, and never submits without a human authorization reaching it.
 * The handoff branch is the default and, for most real postings, the outcome.
 */
export async function submitApplication(params: SubmitApplicationParams): Promise<ApplyResult> {
  const { jobUrl, profile, jobDescription, credentials, signal } = params

  const target = detectApplyTarget(jobUrl)
  // Resolved AFTER the target check so an unsupported-ATS URL never pays for
  // a resume_documents lookup it can't use.
  const resolved = target
    ? await resolveResumeFullText(params)
    : { content: params.content, lookupFailed: false }
  const content = resolved.content
  const authorization = isSubmitAuthorization(params.authorization) ? params.authorization : null

  if (!target) {
    const assessment = assessSubmitCapability({
      target: null,
      hasCredential: false,
      authorization,
      profile,
      hasResumeContent: false,
    })
    return {
      outcome: 'handoff',
      provider: null,
      prefilledUrl: jobUrl,
      reason: describeBlockers(assessment.blockers),
      fields: [],
      attempt: buildAttemptRecord({
        provider: null,
        route: 'handoff',
        outcome: 'handoff',
        profile,
        content,
        authorization,
        assessment,
      }),
    }
  }

  const provider = target.provider
  const fields = buildHandoffFields(provider, profile, content)
  const credential = credentials?.[provider]
  const applyUrl = buildApplyUrl(target, jobUrl)
  // A FAILED résumé lookup means we cannot submit, full stop.
  //
  // Note what the other three terms allow: `content.resumeSummary` is the short
  // blurb cv_tailor writes for internal use, and counting it here is what let a
  // resume_documents outage put a two-sentence summary in front of an employer
  // as the candidate's résumé. Absent is fine — the assessment below reports a
  // missing résumé and hands off. FAILED is different: we know nothing about
  // what exists, and an irreversible action taken on an unknown is the one
  // trade never worth making. See resolveResumeFullText.
  const hasResumeContent =
    !resolved.lookupFailed &&
    !!(
      content.resumeFullText?.trim() ||
      profile.resumeText?.trim() ||
      content.resumeSummary?.trim()
    )

  // The public form schema is only fetched when everything cheap already
  // passed — there is no point spending a network round trip to discover the
  // form for an application that has no credential or no human behind it.
  // `undefined` here means "not looked up yet"; capability treats a null result
  // for a schema-publishing provider as unknown, hence handoff.
  const cheapAssessment = assessSubmitCapability({
    target,
    hasCredential: !!credential,
    authorization,
    jobId: params.jobId,
    profile,
    hasResumeContent,
    jobDescription,
    // Pretend the schema is fine for this first pass so that its absence does
    // not mask the cheaper, more actionable blockers below it.
    formFacts: params.postingForm ?? PROVISIONAL_FORM_OK,
  })
  const cheapBlockers = cheapAssessment.blockers.filter((b) => b.code !== 'form-schema-unavailable')

  let formFacts: PostingFormFacts | null | undefined = params.postingForm
  if (cheapBlockers.length === 0 && formFacts === undefined) {
    formFacts = await fetchGreenhouseFormFactsFor(target, signal)
  }

  const assessment = assessSubmitCapability({
    target,
    hasCredential: !!credential,
    authorization,
    jobId: params.jobId,
    profile,
    hasResumeContent,
    jobDescription,
    formFacts: formFacts ?? null,
  })

  if (assessment.route !== 'official-api' || !credential) {
    return {
      outcome: 'handoff',
      provider,
      prefilledUrl: applyUrl,
      reason: describeBlockers(assessment.blockers),
      fields,
      attempt: buildAttemptRecord({
        provider,
        route: 'handoff',
        outcome: 'handoff',
        profile,
        content,
        authorization,
        assessment,
      }),
    }
  }

  // Authorized + credentialed + capability-cleared → attempt the official submit.
  try {
    const result = await submitByProvider(provider, target, credential, profile, content, signal)
    return {
      outcome: 'submitted',
      submissionRef: result.submissionRef,
      provider,
      attempt: buildAttemptRecord({
        provider,
        route: 'official-api',
        outcome: 'submitted',
        profile,
        content,
        authorization,
        assessment,
        endpoint: result.endpoint,
        body: result.body,
        submissionRef: result.submissionRef,
      }),
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    return {
      outcome: 'failed',
      provider,
      error,
      attempt: buildAttemptRecord({
        provider,
        route: 'official-api',
        outcome: 'failed',
        profile,
        content,
        authorization,
        assessment,
        error,
      }),
    }
  }
}

/**
 * Stand-in used ONLY for the cheap first pass, so that "we haven't looked at
 * the form yet" doesn't surface as a form blocker and drown out the real
 * reason an application is being handed off. Never reaches a submit decision:
 * the second, binding assessment always uses the real (or genuinely absent)
 * facts.
 */
const PROVISIONAL_FORM_OK: PostingFormFacts = {
  provider: 'greenhouse',
  source: 'provisional — schema not yet read',
  requiredAnswerable: [],
  requiredUnanswerable: [],
  consentRequired: false,
  demographicSurveyPresent: false,
}

/** Read the public form schema for providers that publish one; null otherwise. */
async function fetchGreenhouseFormFactsFor(
  target: DetectedApply,
  signal?: AbortSignal
): Promise<PostingFormFacts | null> {
  return target.provider === 'greenhouse' ? fetchGreenhouseFormFacts(target, signal) : null
}

/** What an adapter reports back, so the attempt record can attest to the send. */
interface ProviderSubmitOutcome {
  submissionRef: string
  endpoint: string
  body: Record<string, unknown>
}

async function submitByProvider(
  provider: ApplyProviderId,
  target: DetectedApply,
  credential: string,
  profile: ApplyProfile,
  content: ApplyContent,
  signal?: AbortSignal
): Promise<ProviderSubmitOutcome> {
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

/**
 * Build the DraftAnswers jsonb payload from a submit result.
 *
 * `priorAttempts` is how the attempt log stays append-only across retries: pass
 * the existing `answers.attempts` from the draft row being updated and this
 * returns them with the new attempt appended. Omit it on a first attempt. A
 * caller that drops it on a retry silently erases the user's own evidence of
 * what was sent before, which is why it is a parameter rather than something
 * this function tries to infer.
 */
export function buildDraftAnswers(
  provider: ApplyProviderId | null,
  jobUrl: string,
  fields: HandoffField[],
  result: ApplyResult,
  jobDescription?: string | null,
  priorAttempts?: ApplyAttemptRecord[] | null
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
  const attempts = [...(priorAttempts ?? [])]
  if (result.attempt) attempts.push(result.attempt)
  if (attempts.length > 0) answers.attempts = attempts
  return answers
}
