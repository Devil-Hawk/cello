// Official-ATS application submission — shared contract.
//
// This module (lib/ats-apply/*) is the WRITE side of the ATS integration: it
// takes an approved application_draft and submits it through an official ATS
// application API (Greenhouse boards, Lever postings, Ashby applicationForm).
//
// HARD BOUNDARIES (enforced in code, not just prompts):
//   - Submissions ONLY via official ATS application APIs. No headless-browser
//     form stuffing, no captcha solving/bypass.
//   - A submit is attempted ONLY when an explicit employer/API credential is
//     configured for that provider. Absent a credential (the common case), or
//     when the form needs human-only steps, we produce a prefilled HANDOFF link
//     and leave the draft in the review queue — never a blind POST.
//   - Legal / demographic / work-authorization / visa-sponsorship / salary
//     fields are NEVER auto-answered; they are surfaced for the human.
//
// Kept framework-free (global fetch/URL/Buffer only) so it can be called from
// both API routes and the autopilot engine.

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

/** Per-provider apply credential, when a power user has configured one. */
export interface ApplyCredentials {
  greenhouse?: string
  lever?: string
  ashby?: string
}

/** Outcome of an attempted submission. Discriminated by `outcome`. */
export type ApplyResult =
  | { outcome: 'submitted'; submissionRef: string; provider: ApplyProviderId }
  | { outcome: 'handoff'; provider: ApplyProviderId | null; prefilledUrl: string; reason: string; fields: HandoffField[] }
  | { outcome: 'failed'; provider: ApplyProviderId | null; error: string }

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
  [key: string]: unknown
}
