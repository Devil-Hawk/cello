import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }))

import { NOT_FOUND } from '@/lib/fit/types'
import { fixtureFit, fixturePosting, fixtureRecord } from '../fixtures'
import { checkChance, sendCorrection } from './fit-call'
import { UNREAD, isPartial, needsFold, pastedLine, sourceLine, sponsorshipLines, statusSentence, stripOf, stripSentence, whyKept, whyType } from './logic'
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
    expect(html).toContain(`href="/resume/${data.role.id}"`)
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
    const empty = { items: [], strip: { strengths: 0, gaps: 0, unknown: 0 }, needsModel: false, readAt: null }
    const html = text(render({ people: [], history: [], why: null, typeWhy: null, fit: empty, kinds: {}, role: { ...fixtureRecord().role, pay: null, chance: null, read: null } }))
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

describe('role type on the record', () => {
  it('shows type and level, why the type was set, and Change type', () => {
    const html = text(render())
    expect(html).toContain('AI Engineer, Senior')
    expect(html).toContain('AI Engineer, from the title words "ai engineer".')
    expect(html).toContain('Change type')
    expect(html).not.toContain("Cello's read AI")
  })

  it('marks a type a model set, and says the words it read', () => {
    const base = fixtureRecord()
    const role = { ...base.role, type: { id: 'forward-deployed-engineer', label: 'Forward Deployed Engineer', own: false, origin: 'model' as const } }
    const html = text(render({ role, typeWhy: whyType(role.type, { evidence: [{ quote: 'deploy models inside customers' }] }) }))
    expect(html).toContain('Forward Deployed Engineer, Senior Cello\'s read')
    expect(html).toContain('Forward Deployed Engineer, read from "deploy models inside customers".')
  })

  it('says how a type was set from the stored provenance, and says nothing when nothing does', () => {
    const t = { id: 'ai-engineer', label: 'AI Engineer', own: false, origin: 'code' as const }
    expect(whyType(t, { rule: 'synonym', pattern: 'applied ai engineer' })?.text).toBe('AI Engineer, from the title words "applied ai engineer".')
    expect(whyType(t, { rule: 'department', pattern: 'applied ai' })?.text).toBe('AI Engineer, from the team name "applied ai".')
    expect(whyType({ ...t, own: true, origin: null }, null)?.text).toBe('You chose AI Engineer for titles like this one.')
    expect(whyType(t, null)).toBeNull()
    expect(whyType(null, { rule: 'synonym', pattern: 'x' })).toBeNull()
  })

  it('says a pasted role was pasted, and that it is outside the types when it is', () => {
    const ai = { id: 'ai-engineer', label: 'AI Engineer', own: false, origin: 'code' as const }
    expect(pastedLine(false, ai, ['data-engineer'])).toBeNull()
    expect(pastedLine(true, ai, ['data-engineer'])).toBe('You pasted this. It is outside your role types.')
    expect(pastedLine(true, ai, ['ai-engineer'])).toBe('You pasted this.')
    expect(pastedLine(true, ai, [])).toBe('You pasted this.')
    expect(text(render({ pasted: 'You pasted this. It is outside your role types.' }))).toContain('You pasted this. It is outside your role types.')
  })

  it('keeps "kept because" on the type the person chose', () => {
    const t = { roleTypes: ['ai-engineer'], functions: [], seniority: [], countries: [], remoteOnly: false }
    expect(whyKept({ roleType: { id: 'ai-engineer', label: 'AI Engineer', own: false, origin: 'code' }, jobFunction: null, seniority: null, isRemote: null, country: null }, t)).toBe('Kept: AI Engineer is one of your role types.')
  })
})

describe('the fit strip and the requirements', () => {
  it('counts pluses, minuses and not sure from the items, one pill each', () => {
    const { fit } = fixtureFit(9)
    expect(stripSentence(stripOf(fit.items))).toBe('4 pluses, 3 minuses, 2 not sure')
    expect(stripSentence({ strengths: 1, gaps: 1, unknown: 0 })).toBe('1 plus, 1 minus, 0 not sure')
    const html = render()
    expect(text(html)).toContain('4 pluses, 3 minuses, 2 not sure')
    expect((html.match(/aria-expanded="false" aria-label="(Plus|Minus|Not sure):/g) ?? []).length).toBe(9)
  })

  it('reads the requirements as Pluses, Minuses and Not sure, each with its evidence or its reason', () => {
    const html = text(render())
    expect(html).toContain('Pluses, 4')
    expect(html).toContain('Minuses, 3')
    expect(html).toContain('Not sure, 2')
    expect(html).toContain('“Led the ranking rewrite in Python” Your resume')
    expect(html).toContain('“I built the evaluation harness” Your saved answer')
    // a minus says what is missing and where code looked; a plus has its quote
    expect(html).toContain('Not shown in your resume, answers or material.')
    // a fact about where code looked, or that nothing was read yet
    expect(html).toContain(NOT_FOUND)
    expect(html).toContain(UNREAD)
  })

  it('marks a model verdict, and not a code one, and reads a correction as "You said"', () => {
    const base = fixtureFit(1)
    const one = (over: object) => ({ fit: { ...base.fit, items: [{ ...base.fit.items[0], ...over }] }, kinds: base.kinds })
    expect(text(render(one({ origin: 'model' })))).toContain("Cello's read")
    expect(text(render(one({ origin: 'code' })))).not.toContain("Cello's read")
    expect(text(render(one({ verdict: 'gap', evidence: [], origin: 'person', note: 'I have not used it' })))).toContain('You said: I have not used it')
  })

  it('shows 80 requirements and a 400-character one whole', () => {
    const { fit, kinds } = fixtureFit(80, true)
    const html = render({ fit, kinds })
    expect(fit.items[0].requirement).toHaveLength(400)
    expect(html).toContain(fit.items[0].requirement)
    expect((html.match(/id="req-/g) ?? []).length).toBe(80)
    expect(html).not.toMatch(/truncate|line-clamp/)
  })

  it('lists must have before nice to have, in the posting order, and offers Correct only where a correction is stored', () => {
    const { fit, kinds } = fixtureFit(9)
    const html = render({ fit, kinds })
    expect(html).not.toContain('Correct')
    expect(text(render({ fit, kinds, correctUrl: '/api/roles/x/evidence' }))).toContain('Correct')
    expect(text(html).indexOf('Requirement 1')).toBeLessThan(text(html).indexOf('Requirement 7'))
  })

  it('shows no strip and no group for a posting that lists no requirements, and says so', () => {
    const empty = { items: [], strip: { strengths: 0, gaps: 0, unknown: 0 }, needsModel: false, readAt: null }
    const html = text(render({ fit: empty, kinds: {} }))
    expect(html).not.toContain('pluses')
    expect(html).not.toContain('Requirements')
    expect(html).toContain('The posting does not list requirements, so Cello cannot check your chances.')
  })
})

describe('checking the chance from the record', () => {
  it('offers Check my chance only while the chance is unchecked', () => {
    const base = fixtureRecord().role
    expect(text(render({ role: { ...base, chance: null, read: null } }))).toContain('Check my chance')
    expect(text(render())).not.toContain('Check my chance')
  })

  it('posts to the fit route and hands back what Cello concluded, or the words of a refusal', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const fit = { jobId: 'j', assessedAt: null, blocked: [], want: null, chance: { label: 'possible', checks: [], gaps: [], confirm: [], note: null } }
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => fit })
    expect(await checkChance('4f5ad7eb-912c-4e15-ab3c-0f8248113d69')).toEqual({ ok: true, fit })
    expect(fetchMock).toHaveBeenCalledWith('/api/roles/4f5ad7eb-912c-4e15-ab3c-0f8248113d69/fit', { method: 'POST' })
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'No resume uploaded. Add one in Settings first.' }) })
    expect(await checkChance('x')).toEqual({ ok: false, message: 'No resume uploaded. Add one in Settings first.' })
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    expect((await checkChance('x')).ok).toBe(false)
    vi.unstubAllGlobals()
  })

  it('shows "How Cello read your chance" once there is a chance to read', () => {
    expect(text(render())).not.toContain('How Cello read your chance')
    const chanceFit = { jobId: 'j', assessedAt: null, blocked: [], want: null, chance: { label: 'possible' as const, checks: [], gaps: [], confirm: [], note: null } }
    expect(text(render({ chanceFit }))).toContain('How Cello read your chance')
  })

  it('sends a correction to the route that stores it, and says whether it was stored', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce({ ok: true })
    expect(await sendCorrection('/api/x', 'req-1', 'gap', ' I have not used it ')).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('/api/x', expect.objectContaining({ method: 'POST', body: JSON.stringify({ requirementId: 'req-1', verdict: 'gap', note: 'I have not used it' }) }))
    fetchMock.mockResolvedValueOnce({ ok: false })
    expect(await sendCorrection('/api/x', 'req-1', 'gap', '')).toBe(false)
    vi.unstubAllGlobals()
  })
})
