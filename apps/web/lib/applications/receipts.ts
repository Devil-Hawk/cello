// Pure logic for application receipts: validation, the destination preset
// list, and the honest "what does Cello actually know" copy the product
// vision demands (see the header of app/api/applications/receipts/route.ts
// for the write path this backs).
//
// THE "SECONDS, NOT CRM DATA ENTRY" CONSTRAINT
// The owner's spec for the manual "I already applied" path is exactly four
// required facts (date, resume used, source/destination, current status)
// plus two optional ones (confirmation text, screenshot). Every validation
// rule below exists to keep a bad/missing value from corrupting the record
// — none of it exists to demand MORE fields than that. Resist the urge to
// add "just one more required field" here.
//
// Framework-free except for the PipelineStage import (a plain type, not a
// runtime dependency) — safe to unit-test without any DB/network.

import type { PipelineStage } from '@/lib/format'
import type {
  ApplicationReceipt,
  NewReceiptInput,
  ReceiptDocument,
  ReceiptPatch,
  ReceiptProvenance,
  ReceiptVerificationState,
} from './types'

/** Short display label for who/what produced a receipt — used anywhere a
 *  receipt is listed (e.g. the pipeline detail dialog). */
export const PROVENANCE_LABELS: Record<ReceiptProvenance, string> = {
  manual: 'Logged by you',
  ats_direct: 'Submitted directly by Cello',
  browser_companion: 'Browser companion',
}

// ---------------------------------------------------------------------------
// Stages a receipt can set
// ---------------------------------------------------------------------------

/** Logging "I already applied" implies at least `applied` — `discovered`
 *  (not yet applied) is deliberately excluded from this list. */
export const RECEIPT_STAGES: readonly PipelineStage[] = [
  'applied',
  'screen',
  'interview',
  'offer',
  'rejected',
  'ghosted',
]

// ---------------------------------------------------------------------------
// Destination presets — a short list + free text, not an open-ended form
// ---------------------------------------------------------------------------

export interface DestinationPreset {
  value: string
  label: string
}

export const DESTINATION_PRESETS: readonly DestinationPreset[] = [
  { value: 'company_site', label: 'Company website' },
  { value: 'ats_direct', label: 'ATS board (Greenhouse/Lever/Ashby)' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'job_board', label: 'Job board (Indeed, ZipRecruiter, etc.)' },
  { value: 'referral', label: 'Referral' },
  { value: 'recruiter', label: 'Recruiter outreach' },
  { value: 'email', label: 'Email' },
  { value: 'other', label: 'Other' },
]

const DESTINATION_PRESET_LABEL: Record<string, string> = Object.fromEntries(
  DESTINATION_PRESETS.map((p) => [p.value, p.label])
)

/** Resolve a preset value + optional custom text into the plain-text
 *  `destination` the row actually stores. `other` requires the custom text;
 *  every other preset ignores it (a stray value in the free-text box next to
 *  an unrelated preset must never silently override the preset). */
export function resolveDestination(presetValue: string, customText: string): string {
  if (presetValue === 'other') return customText.trim()
  return DESTINATION_PRESET_LABEL[presetValue] ?? customText.trim()
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_DESTINATION_LENGTH = 200
export const MAX_CONFIRMATION_IDENTIFIER_LENGTH = 200
export const MAX_CONFIRMATION_NOTE_LENGTH = 4000
export const MAX_DOCUMENT_LABEL_LENGTH = 200
export const MAX_DOCUMENTS = 5
/** Raw image bytes, estimated from the base64 payload length (see
 *  attachmentByteSize). A phone screenshot is comfortably under this. */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024
/** How far into the future a submission date may be — small clock-skew
 *  tolerance only; this is not a way to log a not-yet-sent application. */
const FUTURE_SKEW_MS = 24 * 60 * 60 * 1000
/** Reject a date implausibly far in the past rather than silently accepting
 *  a typo'd year. */
const EARLIEST_SUBMITTED_AT = new Date('2000-01-01T00:00:00Z').getTime()

const DATA_URL_RE = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/]+=*)$/i

/** Estimated decoded byte size of a base64 payload, without allocating a Buffer. */
function base64ByteSize(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

function isPlainHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean
  errors: string[]
}

function ok(): ValidationResult {
  return { ok: true, errors: [] }
}
function fail(errors: string[]): ValidationResult {
  return { ok: false, errors }
}

function validateSubmittedAt(value: unknown, errors: string[]): void {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push('Application date is required.')
    return
  }
  const t = new Date(value).getTime()
  if (Number.isNaN(t)) {
    errors.push('Application date is not a valid date.')
    return
  }
  if (t > Date.now() + FUTURE_SKEW_MS) {
    errors.push('Application date cannot be in the future.')
  }
  if (t < EARLIEST_SUBMITTED_AT) {
    errors.push('Application date is implausibly far in the past.')
  }
}

function validateDestination(value: unknown, errors: string[]): void {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push('Where you applied is required.')
    return
  }
  if (value.trim().length > MAX_DESTINATION_LENGTH) {
    errors.push(`Where you applied must be ${MAX_DESTINATION_LENGTH} characters or fewer.`)
  }
}

function validateDocuments(value: unknown, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push('Resume used is required.')
    return
  }
  if (value.length > MAX_DOCUMENTS) {
    errors.push(`No more than ${MAX_DOCUMENTS} documents per receipt.`)
    return
  }
  let hasResume = false
  for (const doc of value as ReceiptDocument[]) {
    if (!doc || typeof doc !== 'object') {
      errors.push('Each document entry must be an object.')
      continue
    }
    if (doc.kind !== 'resume' && doc.kind !== 'cover_letter' && doc.kind !== 'other') {
      errors.push(`Unrecognized document kind: ${String((doc as { kind?: unknown }).kind)}.`)
      continue
    }
    if (doc.kind === 'resume') hasResume = true
    if (typeof doc.label !== 'string' || !doc.label.trim()) {
      errors.push('Each document needs a label.')
    } else if (doc.label.length > MAX_DOCUMENT_LABEL_LENGTH) {
      errors.push(`Document label must be ${MAX_DOCUMENT_LABEL_LENGTH} characters or fewer.`)
    }
  }
  if (!hasResume) {
    errors.push('Resume used is required — include a document with kind "resume" (use "Not sure which version" if unknown).')
  }
}

function validateOptionalText(value: unknown, max: number, fieldLabel: string, errors: string[]): void {
  if (value === undefined || value === null) return
  if (typeof value !== 'string') {
    errors.push(`${fieldLabel} must be text.`)
    return
  }
  if (value.length > max) {
    errors.push(`${fieldLabel} must be ${max} characters or fewer.`)
  }
}

function validateAttachment(value: unknown, errors: string[]): void {
  if (value === undefined || value === null || value === '') return
  if (typeof value !== 'string') {
    errors.push('Confirmation attachment must be a URL or data URL.')
    return
  }
  if (isPlainHttpsUrl(value)) return
  const match = DATA_URL_RE.exec(value)
  if (!match) {
    errors.push('Confirmation attachment must be an https:// URL or a PNG/JPEG/GIF/WEBP data URL.')
    return
  }
  const bytes = base64ByteSize(match[2])
  if (bytes > MAX_ATTACHMENT_BYTES) {
    errors.push(`Confirmation attachment is too large (max ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB).`)
  }
}

function validateStage(value: unknown, errors: string[]): void {
  if (value === undefined || value === null) return
  if (typeof value !== 'string' || !RECEIPT_STAGES.includes(value as PipelineStage)) {
    errors.push(`Stage must be one of: ${RECEIPT_STAGES.join(', ')}.`)
  }
}

/** Validate a fresh receipt submission. Never throws. */
export function validateNewReceipt(input: Partial<NewReceiptInput>): ValidationResult {
  const errors: string[] = []
  if (typeof input.applicationId !== 'string' || !input.applicationId.trim()) {
    errors.push('applicationId is required.')
  }
  validateSubmittedAt(input.submittedAt, errors)
  validateDestination(input.destination, errors)
  validateDocuments(input.documents, errors)
  validateOptionalText(input.confirmationIdentifier, MAX_CONFIRMATION_IDENTIFIER_LENGTH, 'Confirmation number', errors)
  validateOptionalText(input.confirmationNote, MAX_CONFIRMATION_NOTE_LENGTH, 'Confirmation note', errors)
  validateAttachment(input.confirmationAttachmentUrl, errors)
  validateStage(input.stage, errors)
  return errors.length === 0 ? ok() : fail(errors)
}

/** Validate an edit to an existing receipt. Every field is optional (a PATCH
 *  only sends what changed) but whatever IS present must still pass the same
 *  rules as at creation. */
export function validateReceiptPatch(patch: Partial<ReceiptPatch>): ValidationResult {
  const errors: string[] = []
  if (patch.submittedAt !== undefined) validateSubmittedAt(patch.submittedAt, errors)
  if (patch.destination !== undefined) validateDestination(patch.destination, errors)
  if (patch.documents !== undefined) validateDocuments(patch.documents, errors)
  validateOptionalText(patch.confirmationIdentifier, MAX_CONFIRMATION_IDENTIFIER_LENGTH, 'Confirmation number', errors)
  validateOptionalText(patch.confirmationNote, MAX_CONFIRMATION_NOTE_LENGTH, 'Confirmation note', errors)
  validateAttachment(patch.confirmationAttachmentUrl, errors)
  return errors.length === 0 ? ok() : fail(errors)
}

// ---------------------------------------------------------------------------
// Honest presentation copy
// ---------------------------------------------------------------------------

export interface MonitoringNotice {
  /** True when Cello's background Gmail monitoring (the "monitor" permission
   *  tier — see lib/gmail/permissions.ts) is actually on for this user. */
  active: boolean
  message: string
}

/**
 * "A limitation stated is not a broken product; a limitation hidden is." —
 * builds the plain-language sentence for whether Cello can auto-detect a
 * reply on this application, given whether Gmail monitoring is actually on.
 * Never claims monitoring is active without confirmation, and never omits
 * the limitation when it's off.
 */
export function buildMonitoringNotice(monitoringActive: boolean): MonitoringNotice {
  return {
    active: monitoringActive,
    message: monitoringActive
      ? 'Inbox monitoring is on — Cello will watch for recruiter replies automatically.'
      : "Inbox monitoring is off, so Cello may not automatically detect recruiter replies. Update the stage yourself as things move.",
  }
}

/** One-sentence, honest summary of a receipt's verification_state — never
 *  implies Cello confirmed something it was only told. */
export function receiptStatusSentence(verificationState: ReceiptVerificationState): string {
  switch (verificationState) {
    case 'system_confirmed':
      return 'Application submitted — confirmed directly by Cello.'
    case 'user_confirmed':
      return 'Application submitted — you confirmed this yourself.'
    case 'unconfirmed':
      return 'Application logged, not yet confirmed.'
  }
}

/** Combine a receipt's own honesty with the monitoring notice into the full
 *  banner sentence, e.g. "Application submitted — you confirmed this
 *  yourself. Inbox monitoring is off, so Cello may not automatically detect
 *  recruiter replies." Pass `receipt: null` for an application with no
 *  receipt on file yet — still returns the honest monitoring half. */
export function buildApplicationStatusMessage(
  receipt: Pick<ApplicationReceipt, 'verificationState'> | null,
  monitoring: MonitoringNotice
): string {
  const parts: string[] = []
  if (receipt) parts.push(receiptStatusSentence(receipt.verificationState))
  parts.push(monitoring.message)
  return parts.join(' ')
}

/** Default "resume used" entry for when the user genuinely doesn't know
 *  which version they sent — keeps the required field satisfiable without
 *  forcing a guess. */
export const UNKNOWN_RESUME_DOCUMENT: ReceiptDocument = {
  kind: 'resume',
  label: 'Not sure which version',
  resumeDocumentId: null,
}
