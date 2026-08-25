// Shared types for public.application_receipts — see
// supabase/migrations/20260729000001_application_receipts.sql for the table
// these mirror and the header comment there for why provenance and
// verification_state are two separate, orthogonal fields rather than one.
//
// Framework-free (no next/*) so this can be imported from an API route, a
// client component, or a future script alike — matching lib/sources/*.

/**
 * Which of the three producers wrote a receipt.
 *   manual            — the applicant typed it into the "I already applied"
 *                        form. The ONLY value the public receipts API may
 *                        write today.
 *   ats_direct        — lib/ats-apply submitted through an official ATS API
 *                        (Greenhouse/Lever/Ashby) and got a real
 *                        confirmation back. Not yet wired to a writer in
 *                        this codebase — see receipts.ts's header — but the
 *                        table/type accept it now so that wiring needs no
 *                        migration later.
 *   browser_companion  — a future companion extension witnessed the
 *                        submission directly in the browser. Not built yet;
 *                        this value exists so the shape never needs a
 *                        migration to accept it.
 */
export type ReceiptProvenance = 'manual' | 'ats_direct' | 'browser_companion'

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
export type ReceiptVerificationState = 'unconfirmed' | 'user_confirmed' | 'system_confirmed'

export type ReceiptDocumentKind = 'resume' | 'cover_letter' | 'other'

export interface ReceiptDocument {
  kind: ReceiptDocumentKind
  /** Human-readable label, e.g. "Resume — Backend v3" or "Not sure which version". */
  label: string
  /** public.resume_documents.id, when this is one of Cello's own tracked versions. */
  resumeDocumentId?: string | null
}

/** Row shape of public.application_receipts, snake_case to match the DB. */
export interface ApplicationReceiptRow {
  id: string
  application_id: string
  user_id: string
  provenance: ReceiptProvenance
  verification_state: ReceiptVerificationState
  submitted_at: string
  destination: string | null
  documents: ReceiptDocument[]
  confirmation_identifier: string | null
  confirmation_note: string | null
  confirmation_attachment_url: string | null
  source_detail: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

/** camelCase projection used by the API/UI layer. */
export interface ApplicationReceipt {
  id: string
  applicationId: string
  userId: string
  provenance: ReceiptProvenance
  verificationState: ReceiptVerificationState
  submittedAt: string
  destination: string | null
  documents: ReceiptDocument[]
  confirmationIdentifier: string | null
  confirmationNote: string | null
  confirmationAttachmentUrl: string | null
  sourceDetail: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
}

export function toApplicationReceipt(row: ApplicationReceiptRow): ApplicationReceipt {
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
  }
}

/** Payload the public "I already applied" form submits. Provenance and
 *  verification_state are NEVER accepted from this shape — the API layer
 *  forces them (see receipts.ts / app/api/applications/receipts/route.ts)
 *  so a client can never self-declare a stronger verification state than
 *  "I'm asserting this". */
export interface NewReceiptInput {
  applicationId: string
  /** ISO 8601 timestamp — when the application was actually submitted. */
  submittedAt: string
  destination: string
  documents: ReceiptDocument[]
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
export interface ReceiptPatch {
  submittedAt?: string
  destination?: string
  documents?: ReceiptDocument[]
  confirmationIdentifier?: string | null
  confirmationNote?: string | null
  confirmationAttachmentUrl?: string | null
}
