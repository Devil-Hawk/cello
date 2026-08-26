// What this tests: that every card in the review queue actually shows a WHY,
// not just a status — that is the one thing DraftCard never had, and its
// absence is what made a pile of handoffs read as "just pending" instead of
// "here's what's stopping each one" (see this component's header and
// app/(app)/queue/page.tsx's).
//
// renderToStaticMarkup, not a DOM renderer: no jsdom is configured in
// vitest.config.ts, so this pins the markup HandoffCard produces for a given
// item rather than simulating a click — same approach as
// components/queue/batch-approve.test.tsx.

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { HandoffCard } from './handoff-card'
import type { ReviewQueueItem } from '@/lib/notifications/queue'

function item(over: Partial<ReviewQueueItem> = {}): ReviewQueueItem {
  return {
    draftId: 'd1',
    jobId: 'job-1',
    title: 'Senior Backend Engineer',
    companyName: 'Acme',
    location: 'Remote',
    jobUrl: 'https://boards.greenhouse.io/acme/jobs/4001',
    reason: 'No employer apply credential on file — opens as a prefilled link for you to finish.',
    mode: 'handoff',
    createdAt: '2026-08-03T06:00:00.000Z',
    ...over,
  }
}

function render(over: Partial<ReviewQueueItem> = {}): string {
  return renderToStaticMarkup(createElement(HandoffCard, { item: item(over), onResolved: () => {} }))
}

describe('HandoffCard — the WHY is always on screen', () => {
  it('shows the company, role and the reason sentence together', () => {
    const html = render()
    expect(html).toContain('Senior Backend Engineer')
    expect(html).toContain('Acme')
    expect(html).toContain('No employer apply credential on file')
  })

  it('carries a knock-out reason verbatim — never paraphrased into something vaguer', () => {
    const html = render({
      reason: 'Asks about visa/sponsorship — only you can answer that, so this one is not batchable.',
    })
    expect(html).toContain('Asks about visa/sponsorship')
  })

  it('offers exactly one primary action, worded for what approving will do', () => {
    expect(render({ mode: 'handoff' })).toContain('Approve &amp; open link')
    expect(render({ mode: 'submit' })).toContain('Approve &amp; submit')
  })

  it('always offers a way out — reject — next to the primary action', () => {
    expect(render()).toContain('Reject')
  })

  it('links to the live posting when one is on file, and omits the link when it is not', () => {
    expect(render({ jobUrl: 'https://boards.greenhouse.io/acme/jobs/4001' })).toContain('View role')
    expect(render({ jobUrl: null })).not.toContain('View role')
  })

  it('renders neither button disabled before any action has been taken', () => {
    const html = render()
    expect(html).not.toContain('disabled=""')
  })
})
