import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { BACKGROUND_OFF_TEXT } from '@/lib/clock/status'
import { fixtureRoles } from '@/components/roles/fixtures'
import { fixtureSent, fixtureToday } from './fixtures'
import { ago, checkLine, headerSentence, keptSince, quietSentence, sentLine } from './logic'
import { TodayView } from './today-view'

const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ')
const NOW = Date.UTC(2026, 9, 6, 14)
const render = (over = {}) => renderToStaticMarkup(<TodayView data={fixtureToday(over)} />)

const status = (over: Record<string, unknown> = {}) => ({
  backgroundText: null,
  pausedText: null,
  rolesCheck: {
    command: 'roles.check',
    label: 'Checking roles',
    lastSucceededAt: '2026-10-06T11:58:00Z',
    nextDueAt: '2026-10-06T18:00:00Z',
    missed: false,
    missedAt: null,
    missedText: null,
    found: null,
    failure: null,
  },
  ...over,
})

describe('the check line comes from the clock record only', () => {
  it('says when it last checked and when it will next', () => {
    expect(checkLine(status(), NOW)).toBe('Checked 2 hours ago. Next check at 18:00 UTC.')
  })

  it('says a missed check is being retried, ahead of the plain line', () => {
    const missed = status({ rolesCheck: { ...status().rolesCheck, missed: true, missedAt: '2026-10-06T12:00:00Z', missedText: 'Missed at 12:00. Cello is retrying.' } })
    expect(checkLine(missed, NOW)).toBe('Missed at 12:00. Cello is retrying.')
  })

  it('says finding is paused, or that background work is off, ahead of everything', () => {
    const paused = "Finding is paused: Cello's free server used this month's allowance until Nov 1."
    expect(checkLine(status({ pausedText: paused }), NOW)).toBe(paused)
    expect(checkLine(status({ backgroundText: BACKGROUND_OFF_TEXT }), NOW)).toBe('Background work is off on this server.')
  })

  it('says nothing when the clock has said nothing, instead of guessing a schedule', () => {
    expect(checkLine(status({ rolesCheck: null }), NOW)).toBeNull()
  })

  it('reads ages in whole units', () => {
    expect(ago('2026-10-06T13:59:30Z', NOW)).toBe('just now')
    expect(ago('2026-10-06T13:25:00Z', NOW)).toBe('35 minutes ago')
    expect(ago('2026-10-06T13:00:00Z', NOW)).toBe('1 hour ago')
    expect(ago('2026-10-03T14:00:00Z', NOW)).toBe('3 days ago')
  })
})

describe('the sentences', () => {
  it('counts the picks and the new roles, or says there is nothing new', () => {
    expect(headerSentence({ band: { kind: 'picks', count: 6 }, newCount: 41 })).toBe('6 picks from 41 new roles.')
    expect(headerSentence({ band: { kind: 'picks', count: 1 }, newCount: 1 })).toBe('1 pick from 1 new role.')
    expect(headerSentence({ band: { kind: 'newest', count: 6 }, newCount: 41 })).toBe('41 new roles kept for you today.')
    expect(headerSentence({ band: { kind: 'newest', count: 0 }, newCount: 0 })).toBe('Nothing new today.')
    expect(keptSince(0)).toBeNull()
    expect(keptSince(12)).toBe('12 roles were kept for you.')
  })

  it('names replies only when they can be read, and never claims Needs you is empty', () => {
    expect(quietSentence(6, true, 0)).toBe('You sent 6 applications in the last 14 days. No replies yet.')
    expect(quietSentence(6, false, 0)).toBe('You sent 6 applications in the last 14 days. Cello cannot see replies: Gmail is not connected.')
    expect(quietSentence(1, true, 1)).toBe('You sent 1 application in the last 14 days. 1 has moved past applied.')
    expect(quietSentence(0, true, 0)).toBe('')
    expect(sentLine(fixtureSent(2)[1], NOW)).toBe('Sent 3 days ago, still listed')
  })
})

describe('the Today page', () => {
  it('opens with one header sentence and the check line', () => {
    const html = text(render())
    expect(html).toContain('41 new roles kept for you today.')
    expect(html).toContain('Checked 2 hours ago. Next check at 18:00 UTC.')
    expect(html).toContain('Open Roles')
  })

  it('shows each role title at the company weight, opening its record, in the picks and in the sent rows', () => {
    const items = fixtureRoles(6, 6)
    const sent = fixtureSent(2)
    const html = render({ band: { kind: 'picks', items: items.map((i) => ({ ...i, explanation: 'Because.', kind: 'top' as const })) }, sent })
    for (const id of [items[0].id, items[2].id, sent[0].jobId]) expect(html).toContain(`href="/roles/${id}"`)
    expect(html).not.toMatch(/truncate|line-clamp/)
    // three picks as rows, not six
    expect((html.match(/class="r-name/g) ?? []).length).toBeGreaterThanOrEqual(6)
    expect(html).not.toContain(`href="/roles/${items[3].id}"`)
  })

  it('shows Working now only while a check runs', () => {
    expect(text(render())).not.toContain('Working now')
    expect(text(render({ working: true }))).toContain('Working now')
  })

  it('says what the quiet state carries, with and without Gmail read access', () => {
    const sent = fixtureSent(6)
    expect(text(render({ band: { kind: 'newest', items: [] }, newCount: 0, sent }))).toContain('You sent 6 applications in the last 14 days. No replies yet.')
    const blind = text(render({ band: { kind: 'newest', items: [] }, newCount: 0, sent, canReadReplies: false }))
    expect(blind).toContain('Cello cannot see replies: Gmail is not connected.')
    expect(blind).not.toContain('No replies yet.')
    expect(blind).toContain('Sent 2 days ago')
    expect(blind).toContain('Widen your search')
  })

  it('says the first use state, a failed load, and a missing model in the words of 4.4', () => {
    expect(text(render({ state: 'first', band: { kind: 'newest', items: [] }, newCount: 0, check: null, since: null }))).toContain('Cello is reading roles for your search. Your first roles arrive in a few minutes.')
    const failed = text(render({ state: 'failed' }))
    expect(failed).toContain('Could not load Today.')
    expect(failed).toContain('Try again')
    expect(text(render({ hasModel: false }))).toContain('Roles are listed by title and date. Cello can rank them with a free model.')
    expect(text(render())).not.toContain('Roles are listed by title and date.')
  })

  it('lists what changed since the last visit, and nothing on a first visit', () => {
    const [r] = fixtureRoles(1, 1)
    const since = { kept: 3, changes: [{ jobId: r.id, title: r.title, company: r.company, companyId: r.companyId, domain: null, logoUrl: null, text: 'Moved to interview.' }] }
    const html = text(render({ since }))
    expect(html).toContain('Since you were last here')
    expect(html).toContain('3 roles were kept for you.')
    expect(html).toContain('Moved to interview.')
    expect(text(render({ since: null }))).not.toContain('Since you were last here')
  })

  it('has no stat tiles and none of the forbidden words', () => {
    const html = text(render({ sent: fixtureSent(6), working: true }))
    expect(html).not.toMatch(/unscored|Not scored|Completed|receipt|agent runs|Last run|!/i)
    expect(html).not.toMatch(/\b(runs?|steps?)\b/i)
  })

  it('puts the first action in the DOM before the later groups', () => {
    const html = render({ since: { kept: 3, changes: [] }, sent: fixtureSent(2) })
    expect(html.indexOf('Open Roles')).toBeGreaterThan(-1)
    expect(html.indexOf('Open Roles')).toBeLessThan(html.indexOf('Since you were last here'))
    expect(html.indexOf('Since you were last here')).toBeLessThan(html.indexOf('You sent 2 applications'))
  })
})
