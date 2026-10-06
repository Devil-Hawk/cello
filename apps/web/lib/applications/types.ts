// Shared types for public.application_attempts — see
// supabase/migrations/20261013000000_application_attempts.sql for the table
// these mirror and the header comment there for why provenance and
// verification_state are two separate, orthogonal fields rather than one.
//
// Framework-free (no next/*) so this can be imported from an API route, a
// client component, or a future script alike — matching lib/sources/*.

/**
 * Which of the three producers wrote an attempt.
 *   manual            — the applicant typed it into the "I already applied"
 *                        form. The ONLY value the public attempts API may
 *                        write today.
 *   ats_direct        — lib/ats-apply submitted through an official ATS API
 *                        (Greenhouse/Lever/Ashby) and got a real
 *                        confirmation back. Not yet wired to a writer in
 *                        this codebase — see attempt-rules.ts's header — but the
 *                        table/type accept it now so that wiring needs no
 *                        migration later.
 *   browser_companion  — a future companion extension witnessed the
 *                        submission directly in the browser. Not built yet;
 *                        this value exists so the shape never needs a
 *                        migration to accept it.
 */
export type AttemptProvenance = 'manual' | 'ats_direct' | 'browser_companion'

/**
 * How much Cello independently witnessed, orthogonal to `provenance` (who
 * typed the row in vs. how sure Cello is that it's true).
 *   unconfirmed      — reserved for a future partial signal (e.g. a
 *                       companion that saw a click but never a success
 *                       page). Nothing writes this today.
 *   user_confirmed   — the applicant asserts this happened. Cello did not
 *                       independently witness it. Default for `manual`.
 *   system_confirmed — Cello's own code executed or observed the submission
 *                       directly (e.g. an ATS API call that returned a real
 *                       submission reference).
 */
export type AttemptVerificationState = 'unconfirmed' | 'user_confirmed' | 'system_confirmed'

export type AttemptDocumentKind = 'resume' | 'cover_letter' | 'other'

export interface AttemptDocument {
  kind: AttemptDocumentKind
  /** Human-readable label, e.g. "Resume — Backend v3" or "Not sure which version". */
  label: string
  /** public.resume_documents.id, when this is one of Cello's own tracked versions. */
  resumeDocumentId?: string | null
}

/** Row shape of public.application_attempts, snake_case to match the DB. */
export interface ApplicationAttemptRow {
  id: string
  /** Null once the application was deleted: what was sent outlives it. */
  application_id: string | null
  user_id: string
  provenance: AttemptProvenance
  verification_state: AttemptVerificationState
  submitted_at: string
  destination: string | null
  documents: AttemptDocument[]
  confirmation_identifier: string | null
  confirmation_note: string | null
  confirmation_attachment_url: string | null
  source_detail: Record<string, unknown> | null
  created_at: string
  updated_at: string
  job_id: string | null
  posting_url_hash: string | null
  company_name: string | null
  title: string | null
  /** Allowlisted fields only; every other field reads {"answered_by_you": true}. */
  values_sent: Record<string, unknown> | null
  resume_artifact_id: string | null
  resume_artifact_version: number | null
  cover_letter_artifact_id: string | null
  /** Path in the private bucket `attempts`. */
  screenshot_path: string | null
  final_url: string | null
  confirmation_text: string | null
  attempt_outcome: AttemptOutcome
  sent_by: 'person' | 'cello'
  /** The rule and cap in force for an automatic send. */
  send_rule: Record<string, unknown> | null
  extension_version: string | null
  cost_usd: number | null
}

export type AttemptOutcome = 'sent' | 'unconfirmed' | 'not_sent' | 'marked' | 'blocked' | 'retracted'

/** camelCase projection used by the API/UI layer. */
export interface ApplicationAttempt {
  id: string
  applicationId: string | null
  userId: string
  provenance: AttemptProvenance
  verificationState: AttemptVerificationState
  submittedAt: string
  destination: string | null
  documents: AttemptDocument[]
  confirmationIdentifier: string | null
  confirmationNote: string | null
  confirmationAttachmentUrl: string | null
  sourceDetail: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
  jobId: string | null
  postingUrlHash: string | null
  companyName: string | null
  title: string | null
  valuesSent: Record<string, unknown> | null
  resumeArtifactId: string | null
  resumeArtifactVersion: number | null
  coverLetterArtifactId: string | null
  screenshotPath: string | null
  finalUrl: string | null
  confirmationText: string | null
  attemptOutcome: AttemptOutcome
  sentBy: 'person' | 'cello'
  sendRule: Record<string, unknown> | null
  extensionVersion: string | null
  costUsd: number | null
}

export function toApplicationAttempt(row: ApplicationAttemptRow): ApplicationAttempt {
  return {
    id: row.id,
    applicationId: row.application_id,
    userId: row.user_id,
    provenance: row.provenance,
    verificationState: row.verification_state,
    submittedAt: row.submitted_at,
    destination: row.destination,
    documents: Array.isArray(row.documents) ? row.documents : [],
    confirmationIdentifier: row.confirmation_identifier,
    confirmationNote: row.confirmation_note,
    confirmationAttachmentUrl: row.confirmation_attachment_url,
    sourceDetail: row.source_detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    jobId: row.job_id ?? null,
    postingUrlHash: row.posting_url_hash ?? null,
    companyName: row.company_name ?? null,
    title: row.title ?? null,
    valuesSent: row.values_sent ?? null,
    resumeArtifactId: row.resume_artifact_id ?? null,
    resumeArtifactVersion: row.resume_artifact_version ?? null,
    coverLetterArtifactId: row.cover_letter_artifact_id ?? null,
    screenshotPath: row.screenshot_path ?? null,
    finalUrl: row.final_url ?? null,
    confirmationText: row.confirmation_text ?? null,
    attemptOutcome: row.attempt_outcome ?? 'marked',
    sentBy: row.sent_by ?? 'person',
    sendRule: row.send_rule ?? null,
    extensionVersion: row.extension_version ?? null,
    costUsd: row.cost_usd ?? null,
  }
}

/** Payload the public "I already applied" form submits. Provenance and
 *  verification_state are NEVER accepted from this shape — the API layer
 *  forces them (see attempt-rules.ts / app/api/applications/attempts/route.ts)
 *  so a client can never self-declare a stronger verification state than
 *  "I'm asserting this". */
export interface NewAttemptInput {
  applicationId: string
  /** ISO 8601 timestamp — when the application was actually submitted. */
  submittedAt: string
  destination: string
  documents: AttemptDocument[]
  confirmationIdentifier?: string | null
  confirmationNote?: string | null
  /** A size-capped `data:image/...;base64,...` URL, or an already-hosted `https:` URL. */
  confirmationAttachmentUrl?: string | null
  /** Target pipeline stage to move the application to, if provided. */
  stage?: string | null
}

/** Fields a user may correct after the fact. Provenance/verification_state
 *  are immutable once written — a correction to an asserted fact is still
 *  an assertion, never promoted to "system confirmed" after the fact. */
export interface AttemptPatch {
  submittedAt?: string
  destination?: string
  documents?: AttemptDocument[]
  confirmationIdentifier?: string | null
  confirmationNote?: string | null
  confirmationAttachmentUrl?: string | null
}

// ponytail: the old names, kept for the pipeline components that are not this lane's. PG5 moves them
// to the new names and deletes these two lines and receipts.ts. The retired-word scan allows both.
export type ApplicationReceipt = ApplicationAttempt
export type ReceiptDocument = AttemptDocument

/** Row shape of public.activities — the real conversation history behind an
 *  application (Gmail-detected signal today; type is free text, see
 *  lib/access/fixtures/pipeline.ts's DemoActivity for the vocabulary in
 *  use). No user_id column — ownership is via the parent application, which
 *  every reader here has already checked with getOwnedApplication. */
export interface ApplicationActivity {
  id: string
  application_id: string
  type: string
  title: string
  description: string | null
  metadata: Record<string, unknown> | null
  occurred_at: string
}
