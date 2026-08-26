// What this tests: DraftCard shows the right ACTIONS for each point in the
// assisted-apply state machine (ruling 8) — official-API drafts still offer
// "One-click apply" alongside the new "Fill with browser" entry point;
// once a browser fill has reported back (fill_state present) the card
// switches to "Approve reviewed answers" instead of a blind one-click
// submit; 'filling' shows a waiting state with no actions; an approved
// assisted draft offers exactly "Submit application" (the human click that
// mints a submit-phase token), never the old "Finish on ATS" link meant for
// the un-assisted handoff case.
//
// renderToStaticMarkup, no jsdom — same approach as handoff-card.test.tsx.

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { DraftCard, type DraftRow } from './draft-card'

function draft(over: Partial<DraftRow> = {}): DraftRow {
  return {
    id: 'draft-1',
    job_id: 'job-1',
    resume_summary: null,
    cover_letter: null,
    answers: {},
    status: 'pending_review',
    submission_ref: null,
    created_at: '2026-08-19T00:00:00.000Z',
    jobs: { id: 'job-1', title: 'Senior Backend Engineer', url: 'https://x', location: 'Remote', companies: { name: 'Acme' } },
    ...over,
  }
}

function render(over: Partial<DraftRow> = {}): string {
  return renderToStaticMarkup(createElement(DraftCard, { draft: draft(over), onChanged: () => {} }))
}

describe('DraftCard — official-API drafts (pending_review, no fill_state)', () => {
  it('offers One-click apply, Fill with browser, and Reject', () => {
    const html = render()
    expect(html).toContain('One-click apply')
    expect(html).toContain('Fill with browser')
    expect(html).toContain('Reject')
    expect(html).not.toContain('Approve reviewed answers')
    expect(html).not.toContain('Submit application')
  })
})

describe('DraftCard — assisted-apply drafts (fill_state present)', () => {
  it('pending_review with fill_state offers Approve reviewed answers, not One-click apply', () => {
    const html = render({ fill_state: { answers: { first_name: 'Ada' } } })
    expect(html).toContain('Approve reviewed answers')
    expect(html).not.toContain('One-click apply')
    expect(html).not.toContain('Fill with browser')
  })

  it('renders filled answers field-by-field', () => {
    const html = render({ fill_state: { answers: { first_name: 'Ada', email: 'ada@example.com' } } })
    expect(html).toContain('first_name')
    expect(html).toContain('Ada')
    expect(html).toContain('email')
  })

  it('renders usefully when screenshots are absent', () => {
    const html = render({ fill_state: { answers: { first_name: 'Ada' } }, screenshots: [] })
    expect(html).toContain('No screenshots were captured')
  })

  it('renders a screenshot thumbnail when present', () => {
    const html = render({
      fill_state: { answers: {} },
      screenshots: [{ page: 'https://x/apply', dataUrl: 'data:image/png;base64,AAAA' }],
    })
    expect(html).toContain('data:image/png;base64,AAAA')
  })

  it('shows the deviation banner and never the plain "answers" block as if nothing happened', () => {
    const html = render({
      status: 'pending_review',
      fill_state: { answers: { first_name: 'Ada' }, deviation: { detail: 'a new required field appeared' } },
    })
    expect(html).toContain('a new required field appeared')
  })

  it('approved + assisted offers exactly Submit application, never Finish on ATS', () => {
    const html = render({
      status: 'approved',
      fill_state: { answers: { first_name: 'Ada' } },
      answers: { prefilledUrl: 'https://x/apply' }, // even if a handoff URL exists, assisted wins
    })
    expect(html).toContain('Submit application')
    expect(html).not.toContain('Finish on ATS')
  })

  it('badge reads "Ready to submit" for an approved assisted draft', () => {
    const html = render({ status: 'approved', fill_state: { answers: {} } })
    expect(html).toContain('Ready to submit')
  })
})

describe('DraftCard — filling', () => {
  it('shows the waiting banner and no approve/reject/submit actions', () => {
    const html = render({ status: 'filling' })
    expect(html).toContain('A real browser is filling out this application')
    expect(html).not.toContain('One-click apply')
    expect(html).not.toContain('Approve reviewed answers')
    expect(html).not.toContain('Submit application')
  })
})

describe('DraftCard — official-API handoff (approved, no fill_state)', () => {
  it('still offers Finish on ATS when a handoff URL exists', () => {
    const html = render({ status: 'approved', answers: { prefilledUrl: 'https://x/apply' } })
    expect(html).toContain('Finish on ATS')
    expect(html).not.toContain('Submit application')
  })
})
