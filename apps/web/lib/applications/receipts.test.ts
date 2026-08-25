// Tests for lib/applications/receipts.ts — pure validation + the honest
// monitoring/status copy. No DB, no network: everything here is synchronous
// and framework-free (see that file's header).

import { describe, expect, it } from 'vitest'
import {
  DESTINATION_PRESETS,
  MAX_ATTACHMENT_BYTES,
  MAX_CONFIRMATION_NOTE_LENGTH,
  MAX_DESTINATION_LENGTH,
  RECEIPT_STAGES,
  UNKNOWN_RESUME_DOCUMENT,
  buildApplicationStatusMessage,
  buildMonitoringNotice,
  receiptStatusSentence,
  resolveDestination,
  validateNewReceipt,
  validateReceiptPatch,
} from './receipts'
import type { NewReceiptInput, ReceiptDocument } from './types'

const RESUME_DOC: ReceiptDocument = { kind: 'resume', label: 'Base resume v2', resumeDocumentId: 'doc-1' }

function validInput(overrides: Partial<NewReceiptInput> = {}): Partial<NewReceiptInput> {
  return {
    applicationId: 'app-1',
    submittedAt: new Date().toISOString(),
    destination: 'Company website',
    documents: [RESUME_DOC],
    ...overrides,
  }
}

// Small helper to build a data: URL of a given raw byte size without
// depending on Buffer's exact base64 framing.
function dataUrlOfSize(rawBytes: number): string {
  const base64Length = Math.ceil(rawBytes / 3) * 4
  return `data:image/png;base64,${'A'.repeat(base64Length)}`
}

describe('validateNewReceipt — the four required fields (date, resume, destination, and implicitly application id)', () => {
  it('accepts a minimal, fully-populated manual receipt', () => {
    const result = validateNewReceipt(validInput())
    expect(result).toEqual({ ok: true, errors: [] })
  })

  it('rejects a missing applicationId', () => {
    const result = validateNewReceipt(validInput({ applicationId: undefined }))
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/applicationId/)
  })

  it('rejects a missing submission date', () => {
    const result = validateNewReceipt(validInput({ submittedAt: undefined }))
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/date is required/i)
  })

  it('rejects an unparseable submission date', () => {
    const result = validateNewReceipt(validInput({ submittedAt: 'not-a-date' }))
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/not a valid date/i)
  })

  it('rejects a submission date more than a day in the future', () => {
    const tomorrow = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
    const result = validateNewReceipt(validInput({ submittedAt: tomorrow }))
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/cannot be in the future/i)
  })

  it('rejects an implausibly old submission date', () => {
    const result = validateNewReceipt(validInput({ submittedAt: '1990-01-01T00:00:00Z' }))
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/implausibly far in the past/i)
  })

  it('rejects a missing destination', () => {
    const result = validateNewReceipt(validInput({ destination: '' }))
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/where you applied/i)
  })

  it('rejects a destination longer than the cap', () => {
    const result = validateNewReceipt(validInput({ destination: 'x'.repeat(MAX_DESTINATION_LENGTH + 1) }))
    expect(result.ok).toBe(false)
  })

  it('rejects an empty documents array — "resume used" is required, not optional', () => {
    const result = validateNewReceipt(validInput({ documents: [] }))
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/resume used is required/i)
  })

  it('rejects documents with no "resume" kind entry, even if non-empty', () => {
    const result = validateNewReceipt(
      validInput({ documents: [{ kind: 'cover_letter', label: 'Cover letter' }] })
    )
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/resume used is required/i)
  })

  it('accepts the "not sure" fallback resume document — the required field must always be satisfiable', () => {
    const result = validateNewReceipt(validInput({ documents: [UNKNOWN_RESUME_DOCUMENT] }))
    expect(result.ok).toBe(true)
  })

  it('rejects a document with an empty label', () => {
    const result = validateNewReceipt(validInput({ documents: [{ kind: 'resume', label: '' }] }))
    expect(result.ok).toBe(false)
  })

  it('rejects an unrecognized stage (discovered is deliberately excluded)', () => {
    const result = validateNewReceipt(validInput({ stage: 'discovered' }))
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/stage must be one of/i)
  })

  it('accepts every stage in RECEIPT_STAGES', () => {
    for (const stage of RECEIPT_STAGES) {
      const result = validateNewReceipt(validInput({ stage }))
      expect(result.ok).toBe(true)
    }
  })

  it('leaves stage optional — a receipt without one is still valid', () => {
    const result = validateNewReceipt(validInput({ stage: undefined }))
    expect(result.ok).toBe(true)
  })
})

describe('validateNewReceipt — optional confirmation fields', () => {
  it('accepts a receipt with no confirmation at all', () => {
    const result = validateNewReceipt(validInput())
    expect(result.ok).toBe(true)
  })

  it('rejects a confirmation note over the length cap', () => {
    const result = validateNewReceipt(
      validInput({ confirmationNote: 'x'.repeat(MAX_CONFIRMATION_NOTE_LENGTH + 1) })
    )
    expect(result.ok).toBe(false)
  })

  it('accepts an https:// confirmation attachment URL', () => {
    const result = validateNewReceipt(
      validInput({ confirmationAttachmentUrl: 'https://example.com/screenshot.png' })
    )
    expect(result.ok).toBe(true)
  })

  it('rejects a non-https confirmation attachment URL that is also not a valid data URL', () => {
    const result = validateNewReceipt(validInput({ confirmationAttachmentUrl: 'not a url' }))
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/https:\/\/ URL or a PNG\/JPEG\/GIF\/WEBP data URL/i)
  })

  it('accepts a small image data: URL', () => {
    const result = validateNewReceipt(validInput({ confirmationAttachmentUrl: dataUrlOfSize(1024) }))
    expect(result.ok).toBe(true)
  })

  it('rejects a data: URL over the attachment size cap', () => {
    const result = validateNewReceipt(
      validInput({ confirmationAttachmentUrl: dataUrlOfSize(MAX_ATTACHMENT_BYTES + 1024) })
    )
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/too large/i)
  })

  it('rejects a non-image data: URL (e.g. an html payload smuggled in as a "screenshot")', () => {
    const result = validateNewReceipt(
      validInput({ confirmationAttachmentUrl: 'data:text/html;base64,PHNjcmlwdD4=' })
    )
    expect(result.ok).toBe(false)
  })
})

describe('validateReceiptPatch — corrections only validate what changed', () => {
  it('accepts an empty patch (the route itself rejects "nothing to update" separately)', () => {
    expect(validateReceiptPatch({})).toEqual({ ok: true, errors: [] })
  })

  it('validates a present field the same way creation does', () => {
    const result = validateReceiptPatch({ destination: '' })
    expect(result.ok).toBe(false)
  })

  it('leaves untouched fields alone', () => {
    const result = validateReceiptPatch({ confirmationIdentifier: 'ABC-123' })
    expect(result.ok).toBe(true)
  })
})

describe('resolveDestination — presets vs free text', () => {
  it('resolves every non-"other" preset to its fixed label, ignoring stray custom text', () => {
    for (const preset of DESTINATION_PRESETS) {
      if (preset.value === 'other') continue
      expect(resolveDestination(preset.value, 'unrelated stray text')).toBe(preset.label)
    }
  })

  it('"other" uses the custom text, trimmed', () => {
    expect(resolveDestination('other', '  Referral from a friend  ')).toBe('Referral from a friend')
  })

  it('an unrecognized preset value falls back to the custom text', () => {
    expect(resolveDestination('not-a-real-preset', 'whatever the user typed')).toBe('whatever the user typed')
  })
})

describe('buildMonitoringNotice — the honest limitation statement', () => {
  it('when monitoring is off, says so plainly and never claims automatic detection', () => {
    const notice = buildMonitoringNotice(false)
    expect(notice.active).toBe(false)
    expect(notice.message).toMatch(/inbox monitoring is off/i)
    expect(notice.message).toMatch(/may not automatically detect/i)
  })

  it('when monitoring is on, says so and does not carry the "off" caveat', () => {
    const notice = buildMonitoringNotice(true)
    expect(notice.active).toBe(true)
    expect(notice.message).toMatch(/inbox monitoring is on/i)
    expect(notice.message).not.toMatch(/off/i)
  })
})

describe('receiptStatusSentence — never claims more confirmation than actually happened', () => {
  it('user_confirmed reads as self-reported, not Cello-verified', () => {
    expect(receiptStatusSentence('user_confirmed')).toMatch(/you confirmed this yourself/i)
  })

  it('system_confirmed reads as Cello having witnessed it directly', () => {
    expect(receiptStatusSentence('system_confirmed')).toMatch(/confirmed directly by Cello/i)
  })

  it('unconfirmed reads as logged-but-not-confirmed, not as a success claim', () => {
    expect(receiptStatusSentence('unconfirmed')).toMatch(/not yet confirmed/i)
  })
})

describe('buildApplicationStatusMessage — the owner\'s example composition', () => {
  it('matches the shape of the owner-supplied example sentence', () => {
    const message = buildApplicationStatusMessage(
      { verificationState: 'user_confirmed' },
      buildMonitoringNotice(false)
    )
    expect(message).toBe(
      'Application submitted — you confirmed this yourself. Inbox monitoring is off, so Cello may not automatically detect recruiter replies. Update the stage yourself as things move.'
    )
  })

  it('with no receipt on file, still surfaces the honest monitoring half alone', () => {
    const message = buildApplicationStatusMessage(null, buildMonitoringNotice(true))
    expect(message).toMatch(/^Inbox monitoring is on/)
    expect(message).not.toMatch(/Application submitted/)
  })
})
