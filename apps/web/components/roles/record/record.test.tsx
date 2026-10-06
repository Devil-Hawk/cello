import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }))

import { fixturePosting, fixtureRecord } from '../fixtures'
import { isPartial, needsFold, sourceLine, sponsorshipLines, statusSentence, whyKept } from './logic'
import { RecordView } from './record-view'

const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ')
const render = (over = {}) => renderToStaticMarkup(<RecordView data={fixtureRecord(over)} />)

describe('the words of the record', () => {
  it('says why a role was kept from the person own search, or nothing', () => {
    const t = { functions: ['engineering'], seniority: ['senior'], countries: ['US'], remoteOnly: true }
    expect(whyKept({ jobFunction: 'engineering', seniority: 'senior', isRemote: true, country: 'US' }, t)).toBe(
      'Kept: Engineering is one of your role types, Senior is your level, US is where you work, and remote is how you want to work.',
    )
    expect(whyKept({ jobFunction: 'engineering', seniority: 'junior', isRemote: false, country: 'DE' }, t)).toBe('Kept: Engineering is one of your role types.')
    expect(whyKept({ jobFunction: 'sales', seniority: null, isRemote: null, country: null }, t)).toBeNull()
  })

  it('names past H-1B filings only for a person who needs sponsorship, and never says an employer does not sponsor', () => {
    expect(sponsorshipLines(false, true, 'We sponsor visas.')).toEqual([])
    expect(sponsorshipLines(true, true, 'Nothing about it.')).toEqual(['The posting does not mention sponsorship.', 'Past H-1B filings.'])
    expect(sponsorshipLines(true, false, 'We offer visa sponsorship.')).toEqual(['The posting mentions sponsorship.'])
    for (const l of [...sponsorshipLines(true, false, ''), ...sponsorshipLines(true, true, '')]) expect(l).not.toMatch(/does not sponsor|no sponsorship/i)
  })

  it('reads status and source from stored facts', () => {
    expect(statusSentence({ stage: 'applied', appliedAt: '2026-09-12T10:00:00Z' })).toBe('You applied on Sep 12.')
    expect(statusSentence({ stage: 'discovered', appliedAt: null })).toBeNull()
    expect(statusSentence(null)).toBeNull()
    const now = Date.UTC(2026, 9, 5, 12)
    expect(sourceLine('Stripe', 'board', false, new Date(now - 3 * 3_600_000).toISOString(), now)).toBe("From Stripe's job board. Still listed as of 3 hours ago.")
    expect(sourceLine('Stripe', 'sitemap', true, null, now)).toBe("From Stripe's careers site. The posting is closed.")
    expect(sourceLine('Stripe', null, false, null, now)).toBeNull()
  })

  it('folds a long posting and shows a short one whole; a stub is partial', () => {
    expect(needsFold('a short posting')).toBe(false)
    expect(needsFold(fixturePosting(2400))).toBe(true)
    expect(needsFold(Array.from({ length: 13 }, () => 'x').join('\n'))).toBe(true)
    expect(isPartial('https://vantageloom.example/jobs/1')).toBe(true)
    expect(isPartial(fixturePosting())).toBe(false)
  })
})

describe('the record', () => {
  it('opens with the company and title at one weight, each linking where it should', () => {
    const data = fixtureRecord()
    const html = renderToStaticMarkup(<RecordView data={data} />)
    expect(html).toContain(`href="/roles/${data.role.id}"`)
    expect(html).toContain(`href="/companies/${data.role.companyId}"`)
    expect(text(html)).toContain("Cello's read Possible. Looks like what you go for.")
    expect(html).not.toMatch(/truncate|line-clamp/)
  })

  it('keeps a 60-character title whole beside its company', () => {
    const title = 'Staff Software Engineer, Applied AI and Developer Experience'
    expect(title).toHaveLength(60)
    const html = renderToStaticMarkup(<RecordView data={fixtureRecord({ role: { ...fixtureRecord().role, title } })} />)
    expect(html).toMatch(new RegExp(`class="r-name[^"]*"[^>]*>${title}</a>`))
  })

  it('renders a 60,000-character posting whole and shows a script tag as text', () => {
    const body = `${fixturePosting(60_000)}\n\n<script>alert('x')</script>\n\nTHE LAST LINE`
    const html = render({ description: body })
    expect(html.length).toBeGreaterThan(60_000)
    expect(text(html)).toContain('THE LAST LINE')
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('r-fold-input')
    expect(text(html)).toContain('Read the whole posting')
  })

  it('shows a posting that is only a link as partial, with the link to the employer', () => {
    const html = render({ description: 'https://vantageloom.example/jobs/1' })
    expect(text(html)).toContain('Cello has only part of this posting.')
    expect(text(html)).toContain("Open on Vantage Loom's site")
    expect(html).not.toContain('r-fold-input')
  })

  it('hides every group that is empty and says when a posting is silent', () => {
    const html = text(render({ people: [], history: [], why: null, role: { ...fixtureRecord().role, pay: null, chance: null, read: null } }))
    expect(html).not.toContain('People there')
    expect(html).not.toContain('Your history with')
    expect(html).not.toContain('Why this role')
    expect(html).not.toContain("Cello's read")
    expect(html).toContain('The posting does not state pay.')
  })

  it('shows the counts from the stored row beside the company, never a fit number', () => {
    const html = text(render())
    expect(html).toContain('636 open, 12 for you')
    expect(html).toContain('Your history with Vantage Loom')
    expect(html).toContain('Priya Nair')
    expect(html).not.toMatch(/\d+%|receipt|unscored|!/)
  })

  it('asks "Did you apply" only after Apply, and offers the three reactions', () => {
    const html = text(render())
    expect(html).toContain('Apply')
    expect(html).toContain('Cello prepares this from your resume. You send it.')
    expect(html).toContain('Interested')
    expect(html).toContain('Not for me')
    expect(html).not.toContain('Did you apply?')
  })

  it('says the status once acted', () => {
    expect(text(render({ status: 'You applied on Sep 12.' }))).toContain('You applied on Sep 12.')
  })
})
