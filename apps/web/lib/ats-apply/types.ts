// Official-ATS application submission — shared contract.
//
// This module (lib/ats-apply/*) is the WRITE side of the ATS integration: it
// takes an approved application_draft and submits it through an official ATS
// application API (Greenhouse boards, Lever postings, Ashby applicationForm).
//
// HARD BOUNDARIES (enforced in code, not just prompts):
//   - Submissions ONLY via official ATS application APIs. No headless-browser
//     form stuffing, no captcha solving/bypass. Every hosted application form
//     (Greenhouse, Lever, Ashby) is challenge-gated; see capability.ts Finding 2.
//   - No account creation and no credential entry on the user's behalf. A board
//     that demands an account is a handoff.
//   - Legal / demographic / work-authorization / visa-sponsorship / salary
//     fields are NEVER auto-answered; they are surfaced for the human.
//   - No submission without an explicit human authorization for that batch
//     reaching this layer as a parameter (SubmitAuthorization, below).
//   - Every submission ATTEMPT — sent, refused, or failed — leaves a durable
//     record of what went where (ApplyAttemptRecord, below).
//
// WHAT CHANGED, AND WHY IT MATTERED
//   This file used to state the gate as "a submit is attempted ONLY when an
//   explicit employer/API credential is configured for that provider." That
//   sentence was true but it was also the whole rule, which made the engine
//   answer exactly one question — credential yes/no — and nothing about the
//   posting it was about to write to. Greenhouse accepts applications that are
//   missing required answers WITHOUT rejecting them (verbatim quote and source
//   in capability.ts, Finding 3), so a credential-only gate could put a
//   half-finished application into an employer's pipeline under the user's real
//   name and report success.
//
//   The credential is now ONE of several conditions, all of which must hold,
//   and lib/ats-apply/capability.ts is the single place that evaluates them. It
//   is a strictly TIGHTER gate than before, not a looser one: no path that
//   could not submit yesterday can submit today.
//
//   The honest research finding underneath all of this: all three vendors key
//   their submission API to the EMPLOYER, and none offers a candidate-side
//   endpoint, so for the overwhelming majority of real postings the handoff is
//   not a fallback — it is the route. capability.ts documents that per provider
//   with sources, so the product can tell the user the truth.
//
// Kept framework-free (global fetch/URL/Buffer/crypto only) so it can be called
// from both API routes and the autopilot engine.

export type ApplyProviderId = 'greenhouse' | 'lever' | 'ashby'

/** Result of parsing a job posting URL into an application target. */
export interface DetectedApply {
  provider: ApplyProviderId
  /** Board token / company slug / org slug used to build API + apply URLs. */
  slug: string
  /** Posting id when the URL exposes one (Greenhouse numeric, Lever/Ashby uuid). */
  jobId: string | null
  /** Whichever host the URL used (retained for EU-region routing). */
  host: string
}

/** Candidate identity assembled from the profile — the only fields we auto-map. */
export interface ApplyProfile {
  firstName: string
  lastName: string
  fullName: string
  email: string
  phone?: string
  location?: string
  linkedin?: string
  website?: string
  /** Plain-text resume (profiles.resume_text), used as the resume attachment. */
  resumeText?: string
}

/** Tailored content produced by cv_tailor for this specific job. */
export interface ApplyContent {
  /**
   * The full resume text to attach — a `resume_documents.content` snapshot
   * (the tailored version for this job when one exists, else the base
   * resume). THIS is what should be uploaded as the resume attachment; it is
   * preferred over both `resumeSummary` and `profile.resumeText` by every
   * adapter (see greenhouse.ts/lever.ts/ashby.ts).
   */
  resumeFullText?: string
  /**
   * ATS-optimized resume SUMMARY — a 2-4 sentence blurb (never fabricated —
   * rephrased truth only). NOT a full resume; last-resort fallback only when
   * neither `resumeFullText` nor `profile.resumeText` is available.
   */
  resumeSummary?: string
  /** Cover letter body. */
  coverLetter?: string
}

/** A single prefilled field for the human handoff view (label -> value). */
export type HandoffField = [label: string, value: string]

/**
 * Per-provider apply credential, when a power user has configured one.
 *
 * Every one of these is an EMPLOYER key — Greenhouse's API Credentials page,
 * a Lever Super Admin's integrations page, an Ashby Admin's key console. A
 * job-seeker cannot mint one for a company they are applying to, which is why
 * the handoff route is permanent rather than transitional. See capability.ts
 * Finding 1 for the sourced quotes.
 */
export interface ApplyCredentials {
  greenhouse?: string
  lever?: string
  ashby?: string
}

/**
 * A human's explicit, per-batch authorization to submit — the one condition
 * that can never be derived, defaulted or inferred from a prior run.
 *
 * Shaped to mirror lib/harness/chains.ts#SubmitConfirmedParams, which is where
 * the codebase already encodes this idea: `confirmed` must be the literal
 * `true`, and the approval names the jobs it covered. Passing this object is
 * how a caller asserts "a person looked at this and clicked send"; the engine
 * treats its absence as a refusal, not as a default.
 */
export interface SubmitAuthorization {
  /** Must be the literal `true`. There is no default and no inference. */
  confirmed: true
  /** Where the human's confirmation entered the system (audit trail). */
  source: 'human-approval-route' | 'submit-confirmed-chain'
  /** When the human confirmed, ISO-8601. Older than 24h is refused as stale. */
  at: string
  /**
   * The `jobs.id` values the approval covered. When present, a submission for
   * any other job is refused — an approval for job A never authorizes job B.
   */
  jobIds?: string[]
  /** The run/batch the confirmation belonged to, when there is one. */
  batchId?: string
}

/**
 * Runtime guard for SubmitAuthorization. Callers hand us values that came from
 * JSON (a plan step's journaled input, a request body), so the literal-`true`
 * and ISO-timestamp requirements have to be checked at runtime, not just typed.
 */
export function isSubmitAuthorization(value: unknown): value is SubmitAuthorization {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.confirmed !== true) return false
  if (v.source !== 'human-approval-route' && v.source !== 'submit-confirmed-chain') return false
  if (typeof v.at !== 'string' || !Number.isFinite(Date.parse(v.at))) return false
  if (v.jobIds !== undefined && !(Array.isArray(v.jobIds) && v.jobIds.every((j) => typeof j === 'string'))) {
    return false
  }
  if (v.batchId !== undefined && typeof v.batchId !== 'string') return false
  return true
}

/**
 * A durable record of ONE submission attempt — including the attempts that were
 * refused. The point is evidentiary: a user must be able to prove what left
 * their name, to whom, and on whose say-so.
 *
 * Deliberately excludes the credential and the full document bodies. Scalar
 * answers are kept verbatim (they are short and they are what an employer
 * actually reads); resume and cover letter are kept as {chars, sha256}, which
 * still lets the user prove a specific document is the one that was sent by
 * re-hashing it, without duplicating a resume into every draft row.
 */
export interface ApplyAttemptRecord {
  /** ISO-8601 timestamp of the attempt. */
  at: string
  provider: ApplyProviderId | null
  /** 'official-api' when a POST was made, 'handoff' when the gate refused. */
  route: 'official-api' | 'handoff'
  /** Exact URL POSTed to, with any credential query parameter redacted. */
  endpoint: string | null
  method: 'POST' | null
  contentType: string | null
  /** Scalar fields sent, verbatim. Never contains a credential. */
  sentValues: Record<string, string>
  /** Attachments sent, provable by re-hashing the document. */
  attachments: { field: string; chars: number; sha256: string }[]
  /** SHA-256 of the exact serialized request body, when one was sent. */
  bodySha256: string | null
  /** Whose confirmation authorized this, when one was present. */
  authorization: { source: string; confirmedAt: string; batchId: string | null } | null
  outcome: 'submitted' | 'failed' | 'handoff'
  submissionRef?: string
  error?: string
  /** Why the gate refused, when it did. Safe to show the user. */
  blockers?: { code: string; detail: string }[]
  /** Non-disqualifying facts about the attempt (unverifiable form, rate limits). */
  warnings?: string[]
}

/**
 * Outcome of an attempted submission. Discriminated by `outcome`.
 *
 * `attempt` is optional in the TYPE but guaranteed in PRACTICE for anything
 * that went through submitApplication() — it sets one on every branch, refusals
 * included. It stays optional only because callers also hand-build a handoff
 * result WITHOUT consulting the engine (lib/harness/agents/applier.ts's
 * prepareHandoff, used when a run isn't submitting at all). Those are staged
 * handoffs, not submission attempts, so there is nothing to attest to.
 */
export type ApplyResult =
  | {
      outcome: 'submitted'
      submissionRef: string
      provider: ApplyProviderId
      attempt?: ApplyAttemptRecord
    }
  | {
      outcome: 'handoff'
      provider: ApplyProviderId | null
      prefilledUrl: string
      reason: string
      fields: HandoffField[]
      attempt?: ApplyAttemptRecord
    }
  | {
      outcome: 'failed'
      provider: ApplyProviderId | null
      error: string
      attempt?: ApplyAttemptRecord
    }

/** Shape persisted at application_drafts.answers (jsonb). */
export interface DraftAnswers {
  provider: ApplyProviderId | null
  jobUrl: string
  /** Prefilled standard fields for the human handoff (identity + links). */
  fields: HandoffField[]
  /** Present when human steps are required; the user opens this to finish. */
  handoff?: {
    prefilledUrl: string
    reason: string
  }
  /** Set once an official submit succeeds. */
  submission?: {
    ref: string
    at: string
  }
  /** Fields we deliberately did NOT auto-answer (legal/demographic/etc.). */
  deferredToHuman?: string[]
  /**
   * Append-only log of every submission attempt this draft has made, refusals
   * included. This is the durable evidence a user needs to prove what left
   * their name: newest last, one entry per call into submitApplication().
   * Callers persisting DraftAnswers should concatenate rather than replace —
   * buildDraftAnswers() takes the prior list for exactly that reason.
   */
  attempts?: ApplyAttemptRecord[]
  [key: string]: unknown
}
