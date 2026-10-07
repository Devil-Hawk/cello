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
  it.each([
    ['missing_key', 'No model key is set. Add an OpenRouter key in Settings and draft again, or edit this one before sending.'],
    ['spend_cap', "This month's spending cap is reached. Raise it in Settings or edit this one before sending."],
    ['provider_error', 'The model did not answer. Draft again in a few minutes, or edit this one before sending.'],
    ['unusable_output', "The model&#x27;s answer could not be used. Draft again, or edit this one before sending."],
  ] as const)('says so in the card, with the next step, for %s', (template_reason, text) => {
    const html = render({ used_llm: false, template_reason })
    expect(html).toContain('Plain template, not a written draft')
    expect(html).toContain(text.replace("'", '&#x27;'))
    // In the DOM as text, not a title attribute a phone never shows.
    expect(html).not.toMatch(/title="[^"]*template/i)
  })

  it('still says what to do for a row saved before the reason was recorded', () => {
    expect(render({ used_llm: false, template_reason: null })).toContain('No model wrote this one. Draft again, or edit this one before sending.')
  })

  it.each([[true], [null], [undefined]])('shows no notice when used_llm is %s', (used_llm) => {
    expect(render({ used_llm })).not.toContain('Plain template')
  })

  it('does not offer a paid check on text no model wrote', () => {
    expect(render({ used_llm: false, template_reason: 'missing_key' })).not.toContain('Check this draft')
  })
})

describe('the checks code runs on the text', () => {
  const clean = ['Hi Jordan,', '', 'I built the idempotent ledger at Halcyon Pay and Acme is hiring a Staff Engineer for it.', '', 'Would you be open to a short chat?', '', 'Thanks,', 'Alex Candidate'].join('\n')
  const base = { body: clean, sender_name: 'Alex Candidate', to_name: 'Jordan Lee', company_name: 'Acme' }

  it('is one quiet line when every check passes', () => {
    const html = render(base)
    expect(html).toMatch(/All \d checks passed/)
  })

  it('shows the failing rule in plain words when the text has two asks', () => {
    const html = render({ ...base, body: clean.replace('Thanks,', 'Happy to send my resume too.\n\nThanks,') })
    expect(html).toContain('2 asks. Keep one so the reply is easy.')
  })

  it('names a sign-off that is not the sender', () => {
    expect(render({ ...base, body: clean.replace('Alex Candidate', 'acandidate') })).toContain('Signed &quot;acandidate&quot;, not your name &quot;Alex Candidate&quot;.')
  })

  it('shows the length that failed', () => {
    const long = ['Hi Jordan,', '', `${'word '.repeat(130)}Acme?`, '', 'Thanks,', 'Alex Candidate'].join('\n')
    expect(render({ ...base, body: long })).toMatch(/\d+ words\. Keep it under 120\./)
  })
})

describe('stored quality-check verdicts', () => {
  const verdicts = [
    { judge: 'groundedness' as const, verdict: 'fail', score: 0.1, rationale: 'Claims a Go background the resume does not show.' },
    { judge: 'specificity' as const, verdict: 'pass', score: 0.9, rationale: 'Names the company and role.' },
  ]

  it('shows them on the pending card instead of offering a first paid check', () => {
    const html = render({ verdicts })
    expect(html).toContain('Claims a Go background the resume does not show.')
    expect(html).toContain('Names the company and role.')
    expect(html).toContain('Backed by your resume')
    expect(html).toContain('Specific to this role')
    expect(html).not.toContain('Check this draft')
    // Re-checking is still possible, and says what it costs.
    expect(html).toContain('Check again (two model calls on your key)')
  })

  it('lists each unsupported claim, quoted, with the next step', () => {
    const html = render({
      verdicts: [{ judge: 'groundedness', verdict: 'fail', score: 0.5, rationale: 'Not in your sources: "led a team of 8" Not in your sources: "10 years at Meta"' }],
    })
    expect(html).toContain('Not in your sources: &quot;led a team of 8&quot;')
    expect(html).toContain('Not in your sources: &quot;10 years at Meta&quot;')
    expect(html).toContain('Edit the draft or remove these lines before sending.')
  })

  it('says a draft that was not checked was not checked, with the reason', () => {
    const html = render({ verdicts: [{ judge: 'groundedness', verdict: 'unjudged', score: null, rationale: 'Not checked: no OpenRouter key is set.' }] })
    expect(html).toContain('Not checked: no OpenRouter key is set.')
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
