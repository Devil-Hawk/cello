// Validation for POST /api/gmail/share — the "read selected shared threads"
// permission's actual mechanism. The user pastes/forwards ONE thread's text
// in directly; Cello never connects to their mailbox for this. Kept as a
// pure function so the shape/limits are unit-testable without a request.

export interface RawShareInput {
  subject?: unknown
  from?: unknown
  body?: unknown
  receivedAt?: unknown
}

export interface ShareInput {
  subject: string
  from: string
  body: string
  receivedAt: Date
}

export const MAX_SHARE_FIELD_LENGTH = 500
export const MAX_SHARE_BODY_LENGTH = 20_000

export type ShareValidationResult =
  | { ok: true; value: ShareInput }
  | { ok: false; error: string }

function trimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Validate a pasted/forwarded thread. Deliberately strict: this is
 * user-supplied free text with no OAuth trust boundary behind it, so bad
 * shapes are rejected outright rather than coerced.
 */
export function validateShareInput(raw: RawShareInput): ShareValidationResult {
  const subject = trimmedString(raw.subject)
  if (!subject) return { ok: false, error: 'subject is required' }
  if (subject.length > MAX_SHARE_FIELD_LENGTH) {
    return { ok: false, error: `subject must be ${MAX_SHARE_FIELD_LENGTH} characters or fewer` }
  }

  const from = trimmedString(raw.from)
  if (!from) return { ok: false, error: 'from is required (the sender\'s email or "Name <email>")' }
  if (from.length > MAX_SHARE_FIELD_LENGTH) {
    return { ok: false, error: `from must be ${MAX_SHARE_FIELD_LENGTH} characters or fewer` }
  }

  const body = trimmedString(raw.body)
  if (!body) return { ok: false, error: 'body is required' }
  if (body.length > MAX_SHARE_BODY_LENGTH) {
    return { ok: false, error: `body must be ${MAX_SHARE_BODY_LENGTH.toLocaleString()} characters or fewer` }
  }

  let receivedAt = new Date()
  if (raw.receivedAt !== undefined && raw.receivedAt !== null && raw.receivedAt !== '') {
    if (typeof raw.receivedAt !== 'string') return { ok: false, error: 'receivedAt must be an ISO date string' }
    const parsed = new Date(raw.receivedAt)
    if (isNaN(parsed.getTime())) return { ok: false, error: 'receivedAt is not a valid date' }
    receivedAt = parsed
  }

  return { ok: true, value: { subject, from, body, receivedAt } }
}
