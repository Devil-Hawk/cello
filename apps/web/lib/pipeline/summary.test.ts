import { describe, expect, it } from 'vitest'
import { buildSummary, type SummaryEvent } from './summary'

const ev = (kind: string, company: string, over: Partial<SummaryEvent> = {}): SummaryEvent => ({ kind, actor: 'extension', trust: 'proven', company_name: company, ...over })

describe('buildSummary', () => {
  it('is empty on a day with nothing to say', () => {
    const s = buildSummary({ events: [], needsYouCount: 0, paused: false })
    expect(s).toEqual({ subject: 'Nothing new in Cello', lines: ['Nothing new since yesterday.'], empty: true })
  })

  it('is thin on a quiet day: one line for what waits', () => {
    const s = buildSummary({ events: [], needsYouCount: 2, paused: false })
    expect(s.empty).toBe(false)
    expect(s.lines).toEqual(['2 things need you.'])
    expect(s.subject).toBe('2 things need you in Cello')
  })

  it('says only what happened on the night of 2 automatic sends, 1 stop and 1 unconfirmed', () => {
    const s = buildSummary({
      events: [ev('submission.sent', 'Acme'), ev('submission.sent', 'Stripe'), ev('fill.blocked', 'Amazon'), ev('submission.unconfirmed', 'Ramp')],
      needsYouCount: 2,
      paused: false,
    })
    const text = s.lines.join('\n')
    expect(text).toContain('Cello sent 2 applications from your browser: Acme, Stripe.')
    expect(text).toContain('1 application stopped on the site and waits for you: Amazon.')
    expect(text).toContain('1 application could not be confirmed: Ramp.')
    // the unconfirmed one is never called sent
    expect(text).not.toMatch(/sent[^.]*Ramp/)
    expect(text).not.toMatch(/Ramp[^.]*was sent/)
  })

  it('counts an automatic send that came back unconfirmed as unconfirmed, not sent', () => {
    const s = buildSummary({ events: [ev('submission.sent', 'Ramp', { trust: 'unconfirmed' })], needsYouCount: 0, paused: false })
    expect(s.lines.join('\n')).not.toContain('Cello sent')
    expect(s.lines.join('\n')).toContain('could not be confirmed: Ramp')
  })

  it('ignores mail that could not be verified, and counts verified replies', () => {
    const s = buildSummary({ events: [ev('message.received', 'Acme', { actor: 'email', trust: 'unconfirmed' }), ev('message.received', 'Stripe', { actor: 'email' })], needsYouCount: 0, paused: false })
    expect(s.lines).toEqual(['1 reply from employers: Stripe.'])
  })

  it('says when Cello is paused', () => {
    expect(buildSummary({ events: [], needsYouCount: 1, paused: true }).lines).toContain('Cello is paused, so nothing is being prepared or sent.')
  })

  it('stays short on a busy day', () => {
    const events = [ev('submission.sent', 'A'), ev('submission.unconfirmed', 'B'), ev('fill.blocked', 'C'), ev('application.created', 'D', { actor: 'rule' }), ev('message.received', 'E', { actor: 'email' })]
    const s = buildSummary({ events, needsYouCount: 4, paused: true })
    expect(s.lines.length).toBeLessThanOrEqual(6)
    expect(s.lines.join('\n')).toMatch(/And 2 more updates in Cello\./)
  })

  it('writes plain sentences: no em dash, no exclamation mark', () => {
    const s = buildSummary({ events: [ev('submission.sent', 'Acme'), ev('fill.blocked', 'Amazon')], needsYouCount: 1, paused: false })
    expect(s.lines.join(' ') + s.subject).not.toMatch(/—|!/)
  })
})
