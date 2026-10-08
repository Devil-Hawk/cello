// T32's table on a fixture clock: weekends, a reply on Friday at 19:00, an answered reply, two unanswered
// follow-ups, the person's own rule, snooze, a closed application, a DST change and a zone change.

import { describe, expect, it } from 'vitest'
import { scoreT32, T32_CASES } from './measures'
import { nudgeFor, type ThreadMessage } from './nudge'

const at = (s: string) => new Date(s)
// Monday 2026-03-02
const out = (s: string): ThreadMessage => ({ direction: 'out', sent_at: s })
const inn = (s: string): ThreadMessage => ({ direction: 'in', sent_at: s })

describe('after your message: business days', () => {
  const thread = [out('2026-03-02T10:00:00Z')]
  it('is due exactly 5 business days later, across a weekend', () => {
    expect(nudgeFor({ thread, now: at('2026-03-09T09:59:00Z') })).toMatchObject({ due: false, reason: 'not_yet' })
    const n = nudgeFor({ thread, now: at('2026-03-09T10:00:00Z') })
    expect(n).toMatchObject({ due: true, waitingOn: 'them', fact: 'You wrote last, 5 business days ago.' })
  })
  it('a person\'s own rule wins over the default', () => {
    expect(nudgeFor({ thread, person: { after_yours_bd: 2 }, now: at('2026-03-04T10:00:00Z') })).toMatchObject({ due: true })
    expect(nudgeFor({ thread, now: at('2026-03-04T10:00:00Z') })).toMatchObject({ due: false })
  })
  it('the global rule can be turned off, and a person can be turned off', () => {
    expect(nudgeFor({ thread, rule: { on: false }, now: at('2026-04-01T00:00:00Z') })).toMatchObject({ reason: 'off' })
    expect(nudgeFor({ thread, person: { off: true }, now: at('2026-04-01T00:00:00Z') })).toMatchObject({ reason: 'off' })
  })
  it('snooze holds it until the date', () => {
    const person = { snooze_until: '2026-03-20' }
    expect(nudgeFor({ thread, person, now: at('2026-03-19T23:59:00Z') })).toMatchObject({ reason: 'snoozed' })
    expect(nudgeFor({ thread, person, now: at('2026-03-20T00:00:00Z') })).toMatchObject({ due: true })
  })
  it('never fires on a closed application', () => {
    expect(nudgeFor({ thread, closed: true, now: at('2026-04-01T00:00:00Z') })).toMatchObject({ reason: 'closed' })
  })
})

describe('after their reply: calendar days', () => {
  it('a reply on Friday at 19:00 is due Sunday at 19:00', () => {
    const thread = [out('2026-03-02T10:00:00Z'), inn('2026-03-06T19:00:00Z')]
    expect(nudgeFor({ thread, now: at('2026-03-08T18:59:00Z') })).toMatchObject({ due: false })
    expect(nudgeFor({ thread, firstName: 'Marcus', now: at('2026-03-08T19:00:00Z') })).toMatchObject({
      due: true,
      waitingOn: 'you',
      fact: 'Marcus replied 2 days ago. You have not answered.',
    })
  })
  it('an answered reply clears the nudge that waited on them', () => {
    const waiting = [out('2026-03-02T10:00:00Z')]
    expect(nudgeFor({ thread: waiting, now: at('2026-03-09T10:00:00Z') })).toMatchObject({ due: true, waitingOn: 'them' })
    const answered = [...waiting, inn('2026-03-03T10:00:00Z')]
    expect(nudgeFor({ thread: answered, now: at('2026-03-04T10:00:00Z') })).toMatchObject({ due: false, reason: 'not_yet' })
  })
  it('your own answer clears the nudge that waited on you', () => {
    const thread = [inn('2026-03-02T10:00:00Z'), out('2026-03-03T10:00:00Z')]
    expect(nudgeFor({ thread, now: at('2026-03-05T10:00:00Z') })).toMatchObject({ due: false })
  })
})

describe('two unanswered follow-ups', () => {
  it('stops with the sentence, and says nothing more', () => {
    const thread = [out('2026-03-02T10:00:00Z'), out('2026-03-09T10:00:00Z'), out('2026-03-16T10:00:00Z')]
    expect(nudgeFor({ thread, now: at('2026-04-30T00:00:00Z') })).toEqual({
      due: false,
      reason: 'stopped',
      message: 'No reply after two follow-ups. Cello stopped reminding you.',
    })
  })
  it('one follow-up still gets its reminder', () => {
    const thread = [out('2026-03-02T10:00:00Z'), out('2026-03-09T10:00:00Z')]
    expect(nudgeFor({ thread, now: at('2026-03-16T10:00:00Z') })).toMatchObject({ due: true })
  })
})

describe('zones', () => {
  it('keeps the local time of day across the New York DST change', () => {
    // Friday 12:00 New York (17:00Z, EST); one business day later is Monday 12:00 EDT, which is 16:00Z
    const thread = [out('2026-03-06T17:00:00Z')]
    const rule = { after_yours_bd: 1 }
    expect(nudgeFor({ thread, rule, zone: 'America/New_York', now: at('2026-03-09T15:59:00Z') })).toMatchObject({ due: false })
    expect(nudgeFor({ thread, rule, zone: 'America/New_York', now: at('2026-03-09T16:00:00Z') })).toMatchObject({ due: true })
  })
  it('a zone change moves the due time', () => {
    const thread = [out('2026-03-06T23:00:00Z')]
    const rule = { after_yours_bd: 1 }
    const utc = nudgeFor({ thread, rule, zone: 'UTC', now: at('2026-03-12T00:00:00Z') })
    const tokyo = nudgeFor({ thread, rule, zone: 'Asia/Tokyo', now: at('2026-03-12T00:00:00Z') })
    expect(utc).toMatchObject({ due: true })
    expect(tokyo).toMatchObject({ due: true })
    if (utc.due && tokyo.due) expect(tokyo.dueAt.getTime()).toBeLessThan(utc.dueAt.getTime())
  })
})

describe('T32 scripted threads', () => {
  it('are all due exactly when the rule says', () => {
    const s = scoreT32(T32_CASES)
    expect(s.note).toBe(`All ${T32_CASES.length} scripted threads are due exactly when the rule says.`)
    expect(s.passed).toBe(true)
  })
})
