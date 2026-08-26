// The safety properties of the morning review, tested at the level a user
// experiences them: what the markup actually contains.
//
// The three claims worth pinning, in the order they can hurt someone:
//   1. NOTHING ARRIVES SELECTED. Fifty pre-ticked irreversible actions behind
//      one button is the failure mode this surface exists to avoid, and it is
//      the kind of regression a refactor introduces by accident (a `defaultAll`
//      prop, a "helpful" initial state). Asserting on the rendered markup
//      catches it whatever the mechanism.
//   2. AN ITEM NEEDING A HUMAN HAS NO CHECKBOX AT ALL. Not a disabled one —
//      none. A disabled control is one prop away from being enabled; a list
//      that never renders an input cannot be selected by any future select-all.
//   3. THE CONFIRMATION COUNTS OUT LOUD. It names the number, the companies and
//      the address, and says what cannot be undone. "Are you sure?" is not a
//      confirmation, it is a speed bump.
//
// renderToStaticMarkup rather than a DOM renderer: no jsdom environment is
// configured in vitest.config.ts, and the pieces under test hold no state and
// touch no browser API — same approach as components/contacts/ranked-contacts.test.tsx.

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import {
  BatchReviewList,
  ConfirmationBody,
  NeedsAttentionList,
  confirmActionLabel,
  confirmationHeadline,
  selectableIds,
  summarizeSelection,
  type BatchReviewItem,
} from './batch-approve'

function item(over: Partial<BatchReviewItem> & { draftId: string }): BatchReviewItem {
  return {
    jobId: `job-${over.draftId}`,
    jobTitle: 'Senior Backend Engineer',
    jobUrl: 'https://boards.greenhouse.io/acme/jobs/4001',
    location: 'Remote',
    companyName: 'Acme',
    matchScore: 88,
    matchWhy: 'Strong Go overlap.',
    matchHighlights: ['Go', 'Postgres'],
    matchGaps: ['Kubernetes'],
    tailoredSummary: 'Rewritten toward distributed systems.',
    hasCoverLetter: true,
    knockouts: [],
    batchable: true,
    mode: 'submit',
    provider: 'greenhouse',
    blockers: [],
    createdAt: '2026-08-03T06:00:00.000Z',
    ...over,
  }
}

const THREE: BatchReviewItem[] = [
  item({ draftId: 'd1' }),
  item({ draftId: 'd2', companyName: 'Beta', mode: 'handoff' }),
  item({ draftId: 'd3', companyName: 'Gamma' }),
]

const BLOCKED: BatchReviewItem[] = [
  item({
    draftId: 'd9',
    companyName: 'Delta',
    jobTitle: 'Cleared Systems Engineer',
    batchable: false,
    knockouts: ['visa/sponsorship', 'security clearance'],
    blockers: [
      'Asks about visa/sponsorship, security clearance — only you can answer that, so this one is not batchable.',
    ],
  }),
]

function renderList(items: BatchReviewItem[], selected: string[] = []): string {
  return renderToStaticMarkup(
    createElement(BatchReviewList, {
      items,
      selected: new Set(selected),
      onToggle: () => {},
    })
  )
}

describe('BatchReviewList — nothing is selected until the user acts', () => {
  it('renders a checkbox per row and ticks none of them', () => {
    const html = renderList(THREE)
    expect(html.match(/type="checkbox"/g)).toHaveLength(3)
    expect(html).not.toContain('checked')
  })

  // Positive control: without this, the assertion above would pass even if the
  // component had stopped rendering the checked state entirely.
  it('does mark a row checked once it is in the selection', () => {
    const html = renderList(THREE, ['d2'])
    expect(html.match(/checked=""/g)).toHaveLength(1)
  })

  it('labels every checkbox and points it at the row it controls', () => {
    const html = renderList(THREE)
    expect(html).toContain('id="batch-item-d1"')
    expect(html).toContain('for="batch-item-d1"')
    expect(html).toContain('aria-describedby="batch-detail-d1"')
  })

  it('shows what a person needs to judge the row in seconds', () => {
    const html = renderList([THREE[0]])
    expect(html).toContain('Senior Backend Engineer')
    expect(html).toContain('Acme')
    expect(html).toContain('88 match')
    expect(html).toContain('Strong Go overlap.')
    expect(html).toContain('Rewritten toward distributed systems.')
    expect(html).toContain('Cover letter written')
  })

  it('distinguishes an application that may be sent from one that becomes a link', () => {
    expect(renderList([item({ draftId: 'a', mode: 'submit' })])).toContain('May submit directly')
    expect(renderList([item({ draftId: 'b', mode: 'handoff' })])).toContain('Prefilled link')
  })
})

describe('NeedsAttentionList — a knock-out item cannot be batch-approved', () => {
  it('renders no checkbox at all, so no select-all can ever reach it', () => {
    const html = renderToStaticMarkup(createElement(NeedsAttentionList, { items: BLOCKED }))
    expect(html).not.toContain('type="checkbox"')
    expect(html).not.toContain('<input')
  })

  it('says why, in the words the server used', () => {
    const html = renderToStaticMarkup(createElement(NeedsAttentionList, { items: BLOCKED }))
    expect(html).toContain('visa/sponsorship, security clearance')
    expect(html).toContain('Cleared Systems Engineer')
  })
})

describe('selectableIds — select-all is incapable of reaching a blocked item', () => {
  it('excludes anything not batchable, even when it is handed the same list', () => {
    expect(selectableIds([...THREE, ...BLOCKED])).toEqual(['d1', 'd2', 'd3'])
  })

  it('returns nothing when nothing may be batched', () => {
    expect(selectableIds(BLOCKED)).toEqual([])
  })
})

describe('summarizeSelection — the numbers the confirmation quotes', () => {
  it('counts only what is both selected and batchable', () => {
    // A selection carrying a blocked id — the shape a stale client state or a
    // tampered payload would have. It contributes nothing to the count.
    const summary = summarizeSelection([...THREE, ...BLOCKED], new Set(['d1', 'd2', 'd9']))
    expect(summary.count).toBe(2)
    expect(summary.submitCount).toBe(1)
    expect(summary.handoffCount).toBe(1)
    expect(summary.companies).toEqual(['Acme', 'Beta'])
  })

  it('is empty for an empty selection — the state the surface opens in', () => {
    const summary = summarizeSelection(THREE, new Set())
    expect(summary).toEqual({ count: 0, submitCount: 0, handoffCount: 0, companies: [] })
  })

  it('counts each company once however many roles it has open', () => {
    const twoAtAcme = [item({ draftId: 'x' }), item({ draftId: 'y', jobTitle: 'Staff Engineer' })]
    const summary = summarizeSelection(twoAtAcme, new Set(['x', 'y']))
    expect(summary.count).toBe(2)
    expect(summary.companies).toEqual(['Acme'])
  })
})

describe('the confirmation names the consequence, not "are you sure"', () => {
  it('counts roles and companies in the title and repeats the action on the button', () => {
    const summary = summarizeSelection(THREE, new Set(['d1', 'd2', 'd3']))
    expect(confirmationHeadline(summary)).toBe('Apply to 3 roles at 3 companies')
    expect(confirmActionLabel(summary)).toBe('Apply to 3 roles')
  })

  it('reads correctly for a single application', () => {
    const summary = summarizeSelection(THREE, new Set(['d1']))
    expect(confirmationHeadline(summary)).toBe('Apply to 1 role at 1 company')
  })

  it('states the count, the irreversibility and the address applications carry', () => {
    const summary = summarizeSelection(THREE, new Set(['d1', 'd2', 'd3']))
    const html = renderToStaticMarkup(
      createElement(ConfirmationBody, {
        summary,
        applyEmail: 'ada@personal.dev',
        applyEmailSource: 'settings',
        accountEmail: 'login@university.edu',
      })
    )
    expect(html).toContain('2 applications')
    expect(html).toContain('cannot be undone')
    expect(html).toContain('ada@personal.dev')
    // The apply address is not the login address, and the confirmation says so
    // rather than letting the user assume it is the one they signed up with.
    expect(html).toContain('login@university.edu')
    expect(html).toContain('Acme, Beta, Gamma')
    expect(html).not.toMatch(/are you sure/i)
  })

  it('does not claim anything is irreversible when nothing will be sent', () => {
    const handoffOnly = [item({ draftId: 'h1', mode: 'handoff' })]
    const summary = summarizeSelection(handoffOnly, new Set(['h1']))
    const html = renderToStaticMarkup(
      createElement(ConfirmationBody, {
        summary,
        applyEmail: 'ada@personal.dev',
        applyEmailSource: 'account',
        accountEmail: 'ada@personal.dev',
      })
    )
    expect(html).not.toContain('cannot be undone')
    expect(html).toContain('Nothing is sent for those')
  })

  it('names a long company list by count rather than printing all of it', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      item({ draftId: `m${i}`, companyName: `Company ${i}` })
    )
    const summary = summarizeSelection(many, new Set(many.map((m) => m.draftId)))
    const html = renderToStaticMarkup(
      createElement(ConfirmationBody, {
        summary,
        applyEmail: 'ada@personal.dev',
        applyEmailSource: 'account',
        accountEmail: 'ada@personal.dev',
      })
    )
    expect(html).toContain('12 companies')
    expect(html).toContain('and 4 more')
  })
})
