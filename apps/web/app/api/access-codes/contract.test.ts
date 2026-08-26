import { describe, expect, it } from 'vitest'
import {
  ACCESS_CODE_COLUMNS,
  describeAccessCodeEvent,
  summarizeAccessCode,
  type AccessCodeEventRow,
  type AccessCodeRow,
} from './contract'

const NOW = new Date('2026-08-03T12:00:00.000Z')

function codeRow(overrides: Partial<AccessCodeRow> = {}): AccessCodeRow {
  return {
    id: 'c1',
    label: 'Acme demo',
    code_prefix: 'P7QK',
    created_at: '2026-08-03T00:00:00.000Z',
    expires_at: '2026-08-06T00:00:00.000Z',
    revoked_at: null,
    first_redeemed_at: null,
    last_used_at: null,
    redemption_count: 0,
    ...overrides,
  }
}

function eventRow(overrides: Partial<AccessCodeEventRow> = {}): AccessCodeEventRow {
  return {
    id: 'e1',
    occurred_at: '2026-08-03T11:00:00.000Z',
    kind: 'action',
    action: 'resume.tailor',
    target: null,
    detail: {},
    client_hint: null,
    ...overrides,
  }
}

describe('ACCESS_CODE_COLUMNS', () => {
  it('never selects the hash', () => {
    // The hash is a SHA-256 of a 12-character code — shipping it to a browser
    // turns a bearer credential into an offline brute-force target.
    expect(ACCESS_CODE_COLUMNS).not.toContain('code_hash')
  })
})

describe('summarizeAccessCode', () => {
  it('reports a live code with the time it has left', () => {
    const summary = summarizeAccessCode(codeRow(), NOW)
    expect(summary.status).toBe('live')
    expect(summary.statusLabel).toBe('Live')
    expect(summary.timeRemaining).toBe('2d 12h left')
  })

  it('reports an expired code and stops claiming time remaining', () => {
    const summary = summarizeAccessCode(codeRow({ expires_at: '2026-08-01T00:00:00.000Z' }), NOW)
    expect(summary.status).toBe('expired')
    expect(summary.timeRemaining).toBeNull()
  })

  it('never shows time remaining for a revoked code that has not yet lapsed', () => {
    // The code is dead now; "1d 12h left" would be a lie about live access.
    const summary = summarizeAccessCode(
      codeRow({ revoked_at: '2026-08-03T09:00:00.000Z' }),
      NOW
    )
    expect(summary.status).toBe('revoked')
    expect(summary.timeRemaining).toBeNull()
  })

  it('fails closed when the expiry is unreadable', () => {
    const summary = summarizeAccessCode(codeRow({ expires_at: 'not-a-date' }), NOW)
    expect(summary.status).toBe('invalid')
    expect(summary.timeRemaining).toBeNull()
  })

  it('normalises a missing redemption count to zero', () => {
    expect(summarizeAccessCode(codeRow({ redemption_count: null }), NOW).redemptionCount).toBe(0)
  })

  it('treats a whitespace-only label as no label', () => {
    expect(summarizeAccessCode(codeRow({ label: '   ' }), NOW).label).toBeNull()
  })
})

describe('describeAccessCodeEvent', () => {
  it('names a redemption in plain words', () => {
    const entry = describeAccessCodeEvent(eventRow({ kind: 'redeemed', action: 'code.redeem' }))
    expect(entry.title).toBe('Signed in with this code')
    expect(entry.kind).toBe('redeemed')
  })

  // The rows below are exactly what app/api/access/redeem/route.ts writes. If
  // that vocabulary changes, these fail before the owner sees a log dump.
  it('calls out the first redemption — the moment the demo actually began', () => {
    const entry = describeAccessCodeEvent(
      eventRow({
        kind: 'redeemed',
        action: 'code.redeem',
        target: '/dashboard',
        detail: { first_redemption: true },
      })
    )
    expect(entry.title).toBe('Signed in with this code for the first time')
    // Neither the landing route nor the flag it already spoke belongs in the note.
    expect(entry.note).toBeNull()
  })

  it('reads the refusal reason the redemption path records', () => {
    const entry = describeAccessCodeEvent(
      eventRow({ kind: 'denied', action: 'code.denied', detail: { reason: 'revoked' } })
    )
    expect(entry.title).toBe('Turned away — the code had been revoked')
    expect(entry.note).toBeNull()
  })

  it('does not render the generic page.view verb as a page name', () => {
    const entry = describeAccessCodeEvent(
      eventRow({ kind: 'page_view', action: 'page.view', target: null })
    )
    expect(entry.title).toBe('Opened a page')
  })

  it("gives the sanitiser's 'unknown' action a sentence", () => {
    // lib/access/audit.ts writes 'unknown' rather than dropping the event.
    const entry = describeAccessCodeEvent(eventRow({ action: 'unknown' }))
    expect(entry.title).toBe('An unnamed action')
  })

  it('names the page a demo user opened', () => {
    const entry = describeAccessCodeEvent(
      eventRow({ kind: 'page_view', action: 'page_view', target: '/pipeline' })
    )
    expect(entry.title).toBe('Opened Pipeline')
    // The raw path adds nothing once the page is named.
    expect(entry.note).toBeNull()
  })

  it('names an unmapped page instead of dropping the row', () => {
    const entry = describeAccessCodeEvent(
      eventRow({ kind: 'page_view', action: 'page_view', target: '/talent-pool' })
    )
    expect(entry.title).toBe('Opened Talent pool')
  })

  it('folds a count into the sentence', () => {
    const entry = describeAccessCodeEvent(
      eventRow({ action: 'jobs.score_batch', detail: { count: 40 } })
    )
    expect(entry.title).toBe('Scored 40 jobs')
    // The count is already spoken; repeating it in the note is noise.
    expect(entry.note).toBeNull()
  })

  it('gets singular agreement right', () => {
    const entry = describeAccessCodeEvent(
      eventRow({ action: 'jobs.score_batch', detail: { count: 1 } })
    )
    expect(entry.title).toBe('Scored 1 job')
  })

  it('falls back to the uncounted phrase when no count was journalled', () => {
    const entry = describeAccessCodeEvent(eventRow({ action: 'jobs.refresh', detail: {} }))
    expect(entry.title).toBe('Refreshed the job list')
  })

  it('renders an action nobody wrote a phrase for', () => {
    const entry = describeAccessCodeEvent(eventRow({ action: 'kb.sync_source' }))
    expect(entry.title).toBe('Sync source')
    expect(entry.note).toBe('Kb')
  })

  it('says what a refusal was and why', () => {
    const entry = describeAccessCodeEvent(eventRow({ kind: 'denied', action: 'code.expired' }))
    expect(entry.title).toBe('Turned away — the code had expired')
    expect(entry.kind).toBe('denied')
  })

  it('still renders a refusal with an unmapped reason', () => {
    const entry = describeAccessCodeEvent(eventRow({ kind: 'denied', action: 'demo.no_sending' }))
    expect(entry.title).toBe('Blocked — no sending')
  })

  it('keeps an unrecognised kind on the timeline', () => {
    const entry = describeAccessCodeEvent(eventRow({ kind: 'weird' }))
    expect(entry.kind).toBe('other')
    expect(entry.title).toBe('Tailored a resume')
  })

  it('shows the thing that was acted on', () => {
    const entry = describeAccessCodeEvent(
      eventRow({ action: 'resume.tailor', target: 'Senior Engineer at Acme' })
    )
    expect(entry.note).toBe('Senior Engineer at Acme')
  })

  it('surfaces simple detail fields and skips nested ones', () => {
    const entry = describeAccessCodeEvent(
      eventRow({ action: 'resume.tailor', detail: { score: 82, nested: { a: 1 } } })
    )
    expect(entry.note).toBe('score: 82')
  })

  it('caps how much of detail reaches the timeline', () => {
    const entry = describeAccessCodeEvent(
      eventRow({ action: 'resume.tailor', detail: { a: 1, b: 2, c: 3, d: 4, e: 5 } })
    )
    expect(entry.note?.split(' · ')).toHaveLength(3)
  })

  it('truncates a long value rather than letting it run', () => {
    const entry = describeAccessCodeEvent(
      eventRow({ action: 'resume.tailor', detail: { note: 'x'.repeat(200) } })
    )
    expect(entry.note!.length).toBeLessThan(80)
    expect(entry.note).toContain('…')
  })

  it('survives detail that is not an object at all', () => {
    for (const detail of [null, 'a string', 42, ['a'], undefined]) {
      expect(() => describeAccessCodeEvent(eventRow({ detail }))).not.toThrow()
    }
  })

  it('survives a null action', () => {
    const entry = describeAccessCodeEvent(eventRow({ action: null }))
    expect(entry.title).toBe('Activity')
  })

  it('carries the client hint through so two people sharing a code are visible', () => {
    const entry = describeAccessCodeEvent(eventRow({ client_hint: 'Chrome on macOS' }))
    expect(entry.clientHint).toBe('Chrome on macOS')
  })
})
