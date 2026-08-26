// What this tests: that the review-queue "why" is always the SAME sentence
// decideBatchEligibility would give the batch review for the identical draft —
// never a friendlier or vaguer paraphrase invented for the notification
// surfaces. See this file's header for why that agreement is the point.

import { describe, it, expect } from 'vitest'
import { buildQueueItem, summarizeQueueReason, toQueueVerdict, type QueueDraftRow, type QueueProfileRow } from './queue'

const COMPLETE_PROFILE: QueueProfileRow = {
  full_name: 'Ada Lovelace',
  email: 'ada@example.com',
  resume_text: 'Ada Lovelace — engineer with five years of distributed systems.',
  preferences: {},
}

const GREENHOUSE_URL = 'https://boards.greenhouse.io/acme/jobs/4001'

function row(over: Partial<QueueDraftRow> = {}): QueueDraftRow {
  return {
    id: 'draft-1',
    jobId: 'job-1',
    resumeSummary: 'Tailored for backend roles.',
    answers: {},
    createdAt: '2026-08-03T06:00:00.000Z',
    job: {
      title: 'Senior Backend Engineer',
      url: GREENHOUSE_URL,
      description: 'Build services. Ship them.',
      location: 'Remote',
      companyName: 'Acme',
      companyMetadata: {},
    },
    ...over,
  }
}

describe('summarizeQueueReason', () => {
  it('leads with the blocker when one exists — the specific reason beats the generic one', () => {
    const reason = summarizeQueueReason(
      { blockers: ['Asks about visa/sponsorship — only you can answer that, so this one is not batchable.'], mode: 'handoff' },
      false
    )
    expect(reason).toBe('Asks about visa/sponsorship — only you can answer that, so this one is not batchable.')
  })

  it('names the missing employer credential as the default reason for a clean handoff', () => {
    expect(summarizeQueueReason({ blockers: [], mode: 'handoff' }, false)).toContain(
      'No employer apply credential on file'
    )
  })

  it('does not blame a missing credential when one is actually configured', () => {
    const reason = summarizeQueueReason({ blockers: [], mode: 'handoff' }, true)
    expect(reason).not.toContain('No employer apply credential')
    expect(reason).toContain('Ready')
  })

  it('says "ready to submit" for the submit-mode ceiling, never "no credential"', () => {
    expect(summarizeQueueReason({ blockers: [], mode: 'submit' }, true)).toBe(
      'Ready to submit — approve to send it to the employer.'
    )
  })
})

describe('buildQueueItem', () => {
  it('surfaces a knock-out question found in the live job description', () => {
    const item = buildQueueItem(
      row({ job: { ...row().job!, description: 'Must have current work authorization / visa sponsorship needed.' } }),
      COMPLETE_PROFILE
    )
    expect(item.reason).toMatch(/visa\/sponsorship/)
    expect(item.mode).toBe('handoff')
  })

  it('surfaces a knock-out the preparing run already deferred, even if the live JD no longer mentions it', () => {
    const item = buildQueueItem(
      row({ answers: { deferredToHuman: ['salary expectation'] } }),
      COMPLETE_PROFILE
    )
    expect(item.reason).toMatch(/salary expectation/)
  })

  it('surfaces an incomplete identity ahead of the generic "no credential" reason', () => {
    const item = buildQueueItem(row(), { ...COMPLETE_PROFILE, email: null })
    expect(item.reason).toMatch(/email/i)
  })

  it('falls back to "no employer credential" — the ordinary case for every candidate', () => {
    const item = buildQueueItem(row(), COMPLETE_PROFILE)
    expect(item.reason).toBe('No employer apply credential on file — opens as a prefilled link for you to finish.')
    expect(item.mode).toBe('handoff')
  })

  it('reports a configured employer credential as submit-mode, not a blocker', () => {
    const item = buildQueueItem(
      row(),
      { ...COMPLETE_PROFILE, preferences: { autopilot: { atsKeys: { greenhouse: 'employer-key' } } } }
    )
    expect(item.mode).toBe('submit')
    expect(item.reason).toBe('Ready to submit — approve to send it to the employer.')
  })

  it('falls back to placeholder title/company rather than throwing when the job join is missing', () => {
    const item = buildQueueItem(row({ job: null }), COMPLETE_PROFILE)
    expect(item.title).toBe('Untitled role')
    expect(item.companyName).toBe('Unknown company')
    expect(item.jobUrl).toBeNull()
  })

  it('carries the draft and job ids through unchanged, for the caller to act on', () => {
    const item = buildQueueItem(row({ id: 'draft-9', jobId: 'job-9' }), COMPLETE_PROFILE)
    expect(item.draftId).toBe('draft-9')
    expect(item.jobId).toBe('job-9')
  })
})

describe('toQueueVerdict — refuse-over-guess collapse to the queue chip', () => {
  it('passes pass/fail through unchanged', () => {
    expect(toQueueVerdict('pass')).toBe('pass')
    expect(toQueueVerdict('fail')).toBe('fail')
  })

  it('every refusal outcome (and anything unrecognized) reads as unjudged, never a substituted score', () => {
    for (const raw of ['insufficient-data', 'insufficient-budget', 'unjudged', 'error', 'something-new']) {
      expect(toQueueVerdict(raw)).toBe('unjudged')
    }
  })
})
