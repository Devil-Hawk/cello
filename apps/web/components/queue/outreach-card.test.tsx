// What the outreach card shows for each state of a message. The failures here
// were all invisible: a failed send had no text and no button, a reply never
// showed, the stored quality verdicts were never read back, and a template draft
// looked like any other. renderToStaticMarkup, no jsdom, like draft-card.test.tsx.

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { OutreachCard, type OutreachRow } from './outreach-card'

function message(over: Partial<OutreachRow> = {}): OutreachRow {
  return {
    id: 'msg-1',
    to_email: 'jordan@acme.com',
    to_name: 'Jordan Lee',
    subject: 'Staff Engineer at Acme',
    body: 'Hello Jordan',
    status: 'pending_review',
    kind: 'initial',
    created_at: '2026-10-01T00:00:00.000Z',
    ...over,
  }
}

function render(over: Partial<OutreachRow> = {}, props: { followUpDue?: boolean } = {}): string {
  return renderToStaticMarkup(createElement(OutreachCard, { message: message(over), onChanged: () => {}, ...props }))
}

describe('a failed send', () => {
  const failed = { status: 'failed' as const, error: 'Gmail send failed (400): invalid To header' }

  it('shows why it failed, in Gmail\'s words, and offers Retry and Dismiss', () => {
    const html = render(failed)
    expect(html).toContain('This email did not go out')
    expect(html).toContain('invalid To header')
    expect(html).toContain('Retry')
    expect(html).toContain('Dismiss')
  })

  it('does not offer a send button directly: it has to come back through review first', () => {
    const html = render(failed)
    expect(html).not.toContain('Approve &amp; send')
    expect(html).not.toContain('Send via Gmail')
  })

  it('still says something when the row carries no error text', () => {
    expect(render({ status: 'failed', error: null })).toContain('Gmail did not accept it.')
  })
})

describe('a sent message', () => {
  const sent = { status: 'sent' as const, sent_at: '2026-10-01T12:00:00.000Z' }

  it('says no reply yet until the sync records one', () => {
    expect(render(sent)).toContain('No reply yet')
  })

  it.each([
    ['positive', 'Replied (positive)'],
    ['neutral', 'Replied'],
    ['negative', 'Replied (declined)'],
    ['bounce', 'Bounced'],
  ] as const)('shows a %s reply as "%s"', (classification, label) => {
    const html = render({ ...sent, replied_at: '2026-10-02T00:00:00.000Z', reply_classification: classification })
    expect(html).toContain(label)
    expect(html).not.toContain('No reply yet')
  })

  it('offers Draft follow-up only when the page says one is due', () => {
    expect(render(sent, { followUpDue: true })).toContain('Draft follow-up')
    expect(render(sent, { followUpDue: false })).not.toContain('Draft follow-up')
    expect(render(sent)).not.toContain('Draft follow-up')
  })

  it('never offers a follow-up on a message that is not sent', () => {
    expect(render({ status: 'pending_review' }, { followUpDue: true })).not.toContain('Draft follow-up')
  })
})

describe('a template draft', () => {
  it('is badged as the generic template', () => {
    expect(render({ used_llm: false })).toContain('Generic template')
  })

  it.each([[true], [null], [undefined]])('is not badged when used_llm is %s', (used_llm) => {
    expect(render({ used_llm })).not.toContain('Generic template')
  })
})

describe('stored quality-check verdicts', () => {
  const verdicts = [
    { judge: 'factuality' as const, verdict: 'fail', score: 0.1, rationale: 'Claims a Go background the resume does not show.' },
    { judge: 'closed_qa' as const, verdict: 'pass', score: 0.9, rationale: 'Names the company and role.' },
  ]

  it('shows them on the pending card instead of offering a first paid check', () => {
    const html = render({ verdicts })
    expect(html).toContain('Claims a Go background the resume does not show.')
    expect(html).toContain('Names the company and role.')
    expect(html).toContain('Groundedness')
    expect(html).toContain('Specificity')
    expect(html).not.toContain('Check this draft')
    // Re-checking is still possible, but labelled as paid.
    expect(html).toContain('Check again')
  })

  it('offers the first check when nothing is stored', () => {
    const html = render({ verdicts: [] })
    expect(html).toContain('Check this draft')
    expect(html).not.toContain('Check again')
  })

  it('does not show verdicts on a sent card', () => {
    expect(render({ status: 'sent', verdicts })).not.toContain('Names the company and role.')
  })
})
