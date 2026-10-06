// Network on fixtures of 0, 1, 50 and 5,000 people: states, the facts on a row, the role title at the company's
// weight, Review follow-up as a link (nothing sends), the map's one line per person, and pagination.

import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NetworkView, type NetworkViewProps } from './network-view'
import { layout } from './map'
import type { PersonRow } from '@/lib/network/people'
import type { DueNudge } from '@/lib/network/nudges'
import { lastInTouch, replyEvidence } from '@/lib/network/format'
import { leftOutSentence } from '@/lib/network/filter'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }))

const person = (i: number, over: Partial<PersonRow> = {}): PersonRow => ({
  id: `p${i}`,
  name: `Person ${i}`,
  email: `p${i}@example.com`,
  title: 'Recruiter',
  kind: 'recruiter',
  addressKind: 'employer',
  employerId: `e${i % 10}`,
  employer: `Employer ${i % 10}`,
  agency: null,
  lastAt: new Date(Date.now() - 6 * 86_400_000).toISOString(),
  lastFrom: 'you',
  waitingOn: 'them',
  sentN: 4,
  receivedN: 3,
  threadsN: 2,
  band: 'In touch',
  bandWhy: 'Direct contact, last in touch 6 days ago',
  ties: [],
  from: 'From your email: 7 messages.',
  ...over,
})

const base: NetworkViewProps = {
  people: [],
  total: 0,
  page: 1,
  pages: 1,
  due: [],
  rule: { on: true, after_yours_bd: 5, after_theirs_d: 2 },
  leftOutSentence: null,
  leftOut: [],
  gmailRead: false,
  gmailConnected: false,
  query: { view: 'list', q: '', kind: '', address: '', waiting: false, quiet: false, hasApp: '', order: 'last' },
}
// React marks text boundaries with comments; the person reads none of them.
const html = (over: Partial<NetworkViewProps>) => renderToStaticMarkup(<NetworkView {...base} {...over} />).replace(/<!-- -->/g, '')

describe('the states', () => {
  it('with no one and no Gmail, says where people come from and offers the three ways in', () => {
    const out = html({})
    expect(out).toContain('Cello builds your network from your email.')
    expect(out).toContain('Connect Gmail')
    expect(out).toContain('Import contacts (CSV)')
    expect(out).toContain('Add a person')
  })
  it('says the first read is coming, then that nobody was found', () => {
    expect(html({ gmailConnected: true })).toContain('The first names arrive in a few minutes.')
    expect(html({ gmailConnected: true, gmailRead: true })).toContain('Nobody from your mail yet.')
  })
  it('says nobody is waiting when nothing is due', () => {
    expect(html({ people: [person(1)], total: 1 })).toContain('Nobody is waiting on you.')
  })
})

describe('a row', () => {
  it('shows last in touch, who wrote last, the reply evidence and a personal address as one', () => {
    const out = html({ people: [person(1, { addressKind: 'personal', employerId: null, employer: null })], total: 1 })
    expect(out).toContain('6 days ago, you wrote last')
    expect(out).toContain('You wrote 4 times, they replied 3')
    expect(out).toContain('Personal address')
    expect(out).toContain('Recruiter')
  })
  it('sets the tied role title in the same class as the company, and opens the record', () => {
    const out = html({ people: [person(1, { ties: [{ applicationId: 'a1', roleId: 'r1', roleTitle: 'Staff Machine Learning Engineer, Applied Research and Platform', company: 'Petrichor Labs', stage: 'applied' }] })], total: 1 })
    expect(out).toContain('href="/roles/r1"')
    expect(out).toContain('Staff Machine Learning Engineer, Applied Research and Platform')
    expect((out.match(/class="r-name/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
  it('the sentences are counts and dates', () => {
    expect(replyEvidence(0, 0)).toBeNull()
    expect(replyEvidence(1, 0)).toBe('You wrote once, they replied never')
    expect(lastInTouch(null, null)).toBe('No mail yet')
  })
})

describe('Follow up', () => {
  const due: DueNudge = { contactId: 'p1', name: 'Marcus Reed', firstName: 'Marcus', email: 'm@x.com', title: 'Recruiter', employer: 'Petrichor Labs', agency: null, waitingOn: 'them', fact: 'You wrote last, 6 business days ago.', dueAt: new Date().toISOString(), threadId: 't', tie: { applicationId: 'a1', roleId: 'r1', roleTitle: 'Data Engineer', company: 'Petrichor Labs', stage: 'applied' }, draftId: 'd1' }
  it('shows the person, the role title, the fact, and Review follow-up as a link to the draft', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const out = html({ people: [person(1)], total: 1, due: [due] })
    expect(out).toContain('Marcus Reed')
    expect(out).toContain('Recruiter at Petrichor Labs')
    expect(out).toContain('href="/roles/r1"')
    expect(out).toContain('You wrote last, 6 business days ago.')
    expect(out).toMatch(/<a [^>]*href="\/conversations\?draft=d1"[^>]*>Review follow-up<\/a>/)
    expect(out).toContain('Snooze')
    expect(out).toContain('Not needed')
    // rendering a follow-up row sends nothing and calls nothing
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
  it('shows at most 5 rows and says how many more', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...due, contactId: `c${i}` }))
    const out = html({ people: [person(1)], total: 1, due: many })
    expect((out.match(/Review follow-up/g) ?? []).length).toBe(5)
    expect(out).toContain('3 more are due.')
  })
})

describe('Everyone at 50 and 5,000', () => {
  it('lists 50 people, one row each', () => {
    const out = html({ people: Array.from({ length: 50 }, (_, i) => person(i)), total: 50 })
    expect((out.match(/Person \d+<\/a>/g) ?? []).length).toBe(50)
  })
  it('paginates 5,000 people at 100 a page and keeps the filters in the next link', () => {
    const out = html({ people: Array.from({ length: 100 }, (_, i) => person(i)), total: 5000, pages: 50, page: 3, query: { ...base.query, q: 'ramp', waiting: true } })
    expect(out).toContain('Page 3 of 50')
    expect(out).toMatch(/href="\/network\?[^"]*page=4/)
    expect(out).toMatch(/href="\/network\?[^"]*page=2/)
    expect(out).toContain('q=ramp')
  })
  it('groups by company', () => {
    const out = html({ people: Array.from({ length: 12 }, (_, i) => person(i)), total: 12, query: { ...base.query, view: 'company' } })
    expect(out).toContain('Employer 1</h3>')
  })
})

describe('left out', () => {
  it('says how many were left out by rule, with Show them', () => {
    const s = leftOutSentence({ automated: 160, bulk: 38, no_name: 16 })
    const out = html({ people: [person(1)], total: 1, leftOutSentence: s, leftOut: [{ email: 'a@b.com', rule: 'bulk' }] })
    expect(out).toContain('Cello left out 214 senders: 160 automated, 38 bulk, 16 with no name.')
    expect(out).toContain('Show them')
  })
})

describe('the map', () => {
  it('draws one line per person and a line from each employer to you, for 300 people', () => {
    const people = Array.from({ length: 300 }, (_, i) => person(i))
    const { nodes, links } = layout(people)
    const employers = new Set(people.map((p) => p.employerId)).size
    expect(links).toHaveLength(300 + employers)
    expect(nodes.filter((n) => n.kind === 'person')).toHaveLength(300)
    expect(nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true)
  })
  it('a more recent touch is a shorter line, and more replies a heavier one', () => {
    const recent = person(1, { lastAt: new Date().toISOString(), receivedN: 8 })
    const old = person(2, { lastAt: new Date(Date.now() - 200 * 86_400_000).toISOString(), receivedN: 0 })
    const { links } = layout([recent, old])
    const idOf = (x: unknown) => (typeof x === 'string' ? x : (x as { id: string }).id)
    const lr = links.find((l) => idOf(l.target) === 'p1')!
    const lo = links.find((l) => idOf(l.target) === 'p2')!
    expect(lr.dist).toBeLessThan(lo.dist)
    expect(lr.width).toBeGreaterThan(lo.width)
  })
})
