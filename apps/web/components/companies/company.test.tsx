import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }), usePathname: () => '/companies/x' }))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }))
vi.mock('@/app/(app)/companies/actions', () => ({
  setFollow: async () => ({ ok: true, changed: 1 }),
  takeCheck: async () => ({ ok: true }),
  followAnyway: async () => ({ ok: true, companyId: 'c', name: 'x' }),
  findCompaniesAction: async () => ({ employers: [], notChecked: [] }),
  keepPreview: async () => ({ ok: true, id: 'job-1' }),
  previewChance: async () => ({ ok: false, sentence: 'x' }),
  removeCompany: async () => ({ ok: true }),
}))

import { CompanyView } from './company-view'
import { FIXTURE_NOW, fixtureCompany, fixtureLive, fixturePreview } from './fixtures'
import {
  DEFAULT_COMPANY_QUERY,
  checksLine,
  companyPageHref,
  companyQueryString,
  countedLine,
  emailLine,
  fieldLines,
  headlineLine,
  parseCompanyQuery,
  previewHref,
  removeLines,
  type CompanyQuery,
} from './company-logic'
import { PreviewClosed, PreviewView } from './preview-view'
import { employerId } from '@/components/roles/fixtures'

const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ')
const id = employerId(0)
const q = (over: Partial<CompanyQuery> = {}): CompanyQuery => ({ ...DEFAULT_COMPANY_QUERY, ...over })

const view = (data = fixtureCompany(), query = q(), live: ReturnType<typeof fixtureLive> | null = null) =>
  renderToStaticMarkup(<CompanyView data={data} query={query} live={live} now={FIXTURE_NOW} />)

describe('the address', () => {
  it('has no parameters for the plain page and keeps the search, the list, its filters and its page in the address', () => {
    expect(companyPageHref(id, DEFAULT_COMPANY_QUERY)).toBe(`/companies/${id}`)
    const query = parseCompanyQuery({ q: 'forward deployed', all: '1', type: 'ai-engineer', place: 'Paris', p: '3' })
    expect(query).toEqual({ q: 'forward deployed', all: true, type: 'ai-engineer', place: 'Paris', page: 3 })
    expect(parseCompanyQuery(Object.fromEntries(new URLSearchParams(companyQueryString(query))))).toEqual(query)
    expect(companyPageHref(id, query, { page: 4 })).toContain('p=4')
    expect(companyPageHref(id, query, { page: 0 })).not.toContain('p=')
  })

  it('takes what it can read of the address and drops the rest', () => {
    expect(parseCompanyQuery({ q: '   ', all: 'yes', type: 'DROP TABLE', place: '', p: '-4' })).toEqual(DEFAULT_COMPANY_QUERY)
    expect(parseCompanyQuery({ q: 'a'.repeat(500), p: '99999999' }).q).toHaveLength(80)
    expect(parseCompanyQuery({ p: '99999999' }).page).toBe(1000)
    expect(parseCompanyQuery({ q: 'a\u0000b\nc' }).q).toBe('a b c')
  })

  it('opens a posting by the employer\'s own key, never a link, and carries the list\'s query for Back', () => {
    const href = previewHref(id, 'https://boards.example/jobs/1?gh=1', q({ all: true, type: 'ai-engineer', page: 2 }))
    expect(href).toMatch(new RegExp(`^/companies/${id}/roles/[A-Za-z0-9_-]+\\?all=1&type=ai-engineer&p=2$`))
    expect(href).not.toContain('boards.example')
  })
})

describe('the counted line', () => {
  it('adds up: the kept and the others are what the employer listed', () => {
    expect(countedLine({ kept: 12, total: 636, counts: { type: 380, untyped: 20, place: 150, level: 74 } })).toBe('624 others: 380 other role types, 20 type unknown, 150 place, 74 level')
    expect(headlineLine(636, 12)).toBe('636 open, 12 for you.')
    for (const n of [1, 12, 13, 26, 636, 5000]) {
      const l = fixtureLive(n)
      const others = l.total - l.kept
      expect(Object.values(l.counts).reduce((a, b) => a + b, 0)).toBe(others)
      expect(l.kept + others).toBe(n)
    }
    expect(countedLine({ kept: 3, total: 3, counts: {} })).toBeNull()
  })
})

describe('All open roles', () => {
  const all = (n: number, page = 0, extra: Partial<ReturnType<typeof fixtureLive>> = {}) => view(fixtureCompany(), q({ all: true, page }), fixtureLive(n, page, extra))

  it('pages 0, 1, 25, 26 and 636 roles in 1, 1, 1, 2 and 26 pages, with no Next on the last', () => {
    expect(text(all(1))).not.toContain('Page 1 of')
    expect(text(all(25))).not.toContain('Page 1 of')
    expect(text(all(26))).toContain('Page 1 of 2')
    expect(all(26)).toContain('>Next<')
    expect(text(all(636))).toContain('Page 1 of 26')
    const last = all(636, 25)
    expect(text(last)).toContain('Page 26 of 26')
    expect(last).not.toContain('>Next<')
    expect(last).toContain('>Previous<')
    expect(all(26, 1)).not.toContain('>Next<')
    // a page past the end is the last page (the read clamps it)
    expect(text(all(26, 5))).toContain('Page 2 of 2')
  })

  it('shows 25 rows of 5,000 and the counted line of the whole read', () => {
    const html = all(5000)
    expect(html.match(/class="r-row /g)).toHaveLength(25)
    expect(text(html)).toContain('5,000 open, 12 for you.')
    expect(text(html)).toContain('4,988 others:')
  })

  it('says 636 open, 12 for you, and gives the counted line under the rows', () => {
    const t = text(all(636))
    expect(t).toContain('636 open, 12 for you.')
    expect(t).toMatch(/624 others: \d+ other role types, \d+ type unknown, \d+ place, \d+ level/)
  })

  it('puts the person\'s own roles first, each opening its record, and every other title opens its preview', () => {
    const html = all(30)
    const first = html.indexOf('href="/roles/10000000-0000-4000-8000-000000000001"')
    const preview = html.indexOf(`href="/companies/${id}/roles/`)
    expect(first).toBeGreaterThan(-1)
    expect(preview).toBeGreaterThan(first)
    expect(html).toContain('Kept for you')
    expect(html).toContain('Outside the places you chose')
    expect(html).toContain('Other role type: Product Manager')
  })

  it('sets every title and the company at one weight', () => {
    const html = all(30)
    const rows = html.split('class="r-row ').slice(1)
    expect(rows).toHaveLength(25)
    for (const row of rows) expect(row.match(/class="r-name hover:underline"/g)!.length).toBeGreaterThanOrEqual(2)
    expect(html).not.toContain('truncate')
  })

  it('has the Role type and Place filters in the address', () => {
    const html = all(30)
    expect(html).toContain('name="type"')
    expect(html).toContain('name="place"')
    expect(html).toContain('name="all" value="1"')
  })

  it('says a word that matches nothing matches nothing', () => {
    const none = view(fixtureCompany(), q({ q: 'zzz' }), fixtureLive(30, 0, { items: [], matched: 0, pages: 1 }))
    expect(text(none)).toContain("No open role at Fixture Employer 001 matches 'zzz'.")
    expect(none).not.toContain('Page 1 of')
  })

  it('shows search results over the whole list, kept first, with the page at the top', () => {
    const html = view(fixtureCompany(), q({ q: 'forward' }), fixtureLive(30))
    expect(text(html)).toContain('Search results')
    expect(text(html)).not.toContain('Kept for you, 12')
  })

  it('says why a site cannot be read, and shows the roles kept before, never 0 open', () => {
    const company = fixtureCompany({ cannotRead: 'no_board', open: null })
    const kept = fixtureCompany().kept
    const html = view(company, q({ all: true }), fixtureLive(0, 0, { keptBefore: kept }))
    const t = text(html)
    expect(t).toContain("Cello cannot read Fixture Employer 001's site: its job board is gone.")
    expect(t).toContain('Open their careers site')
    for (const r of kept) expect(t).toContain(r.title)
    expect(t).not.toContain('0 open')
  })

  it('searches the roles kept before when the site cannot be read, and says so', () => {
    const company = fixtureCompany({ cannotRead: 'cannot_read', open: null })
    const t = text(view(company, q({ q: 'engineer' }), fixtureLive(0, 0, { keptBefore: fixtureCompany().kept })))
    expect(t).toContain("Cello cannot read Fixture Employer 001's site, so this searches the roles it kept before.")
  })

  it('says a site read only in the background cannot be listed here', () => {
    const t = text(view(fixtureCompany({ tier: 'rendered' }), q({ all: true }), fixtureLive(0, 0, { rendered: true })))
    expect(t).toContain('Cello reads this site in the background, so its roles cannot be listed here.')
    expect(t).toContain('Open their careers site')
  })

  it('says why a read that failed listed nothing, with the roles kept before', () => {
    const t = text(view(fixtureCompany(), q({ all: true }), fixtureLive(0, 0, { failure: 'unreachable', keptBefore: fixtureCompany().kept })))
    expect(t).toContain("Cello could not reach Fixture Employer 001's site just now.")
    expect(t).toContain(fixtureCompany().kept[0].title)
  })

  it('says it was asked too often and shows nothing else', () => {
    expect(text(view(fixtureCompany(), q({ all: true }), fixtureLive(0, 0, { limited: true })))).toContain('You opened many pages just now. Try again in a few minutes.')
  })

  it('says the employer lists more than it shows when the read saw only a window', () => {
    expect(text(all(636, 0, { window: true }))).toContain('This employer lists more than it shows at once.')
  })
})

describe('the first screen', () => {
  it('leads with the roles kept for the person, not the open total, and offers the whole list in one link', () => {
    const html = view()
    const t = text(html)
    expect(t).toContain('Kept for you, 12')
    expect(t).toContain('636 open, 12 for you. Show all open roles')
    expect(html).toContain(`href="/companies/${id}?all=1"`)
    expect(html).toContain("Search Fixture Employer 001&#x27;s roles")
    expect(t).not.toMatch(/\bdream\b/i)
  })

  it('has Follow and what it does for an employer the person does not follow, and Check now for one they do', () => {
    const unfollowed = view(fixtureCompany({ following: false, companyId: null, remove: null }))
    expect(text(unfollowed)).toContain('Follow reads its site every 6 hours.')
    expect(text(unfollowed)).toContain("Following reads this employer's site every 6 hours")
    expect(unfollowed).toContain('aria-label="Follow Fixture Employer 001"')
    const followed = text(view())
    expect(followed).toContain('Check now')
    expect(followed).toContain('Stop following')
  })

  it('shows each group only when it has something to say, and no empty heading', () => {
    const t = text(view(fixtureCompany({ field: null, history: [], facts: [], notes: null, check: null, companyId: null, remove: null })))
    for (const h of ['Hiring in your field', 'Your history', 'What Cello knows', 'Your notes', 'Checks', 'People']) expect(t).not.toContain(h)
    const full = text(view(fixtureCompany({ notes: 'Met Dana at the offsite.' })))
    for (const h of ['Hiring in your field', 'People', 'Your history with Fixture Employer 001', 'What Cello knows', 'Your notes', 'Checks']) expect(full).toContain(h)
    expect(full).toContain('Research')
    expect(full).toContain('Read of Fixture Employer 001')
  })

  it('says what it knows about hiring in the person\'s field from counts, with the split and a median only from five closed', () => {
    const lines = fieldLines(fixtureCompany().field!, 'Fixture Employer 001')
    expect(lines).toContain('14 postings in your role types in 90 days, 5 in 30.')
    expect(lines).toContain('ML Engineer 9, AI Engineer 3')
    expect(lines).toContain('A AI Engineer posting stays open a median of 21 days.')
  })

  it('says the reading line from the clock for a followed employer and the rotation for the rest', () => {
    const check = { lastAt: '2026-10-05T09:00:00.000Z', nextAt: '2026-10-05T18:00:00.000Z', missed: null }
    expect(checksLine({ following: true, lastReadAt: null, check }, FIXTURE_NOW)).toBe('Checked 3 hours ago. Next at 18:00 UTC.')
    expect(checksLine({ following: false, lastReadAt: '2026-10-02T09:00:00.000Z', check }, FIXTURE_NOW)).toBe('Read in rotation. Last read 3 days ago.')
    expect(checksLine({ following: true, lastReadAt: null, check: null }, FIXTURE_NOW)).toBeNull()
  })

  it('says the reason a site cannot be read, with a link to it, in place of a count', () => {
    const t = text(view(fixtureCompany({ cannotRead: 'stale', open: null, kept: [], forYou: 0 })))
    expect(t).toContain("Cello cannot read Fixture Employer 001's site: no new role on its board in 120 days.")
    expect(t).not.toContain('Show all open roles')
    expect(t).not.toContain('0 open')
  })

  it('opens an employer known only from email in its own state', () => {
    const data = fixtureCompany({ state: 'email', employerId: null, open: null, forYou: 0, kept: [], field: null, facts: [], following: false, check: null, appliedAt: '2026-03-14T09:00:00.000Z' })
    const html = view(data)
    expect(text(html)).toContain("You applied here in March. Cello has not found this employer's job site yet.")
    expect(html).toContain('aria-label="Add or find a company"')
    expect(html).not.toContain('Follow reads its site')
    expect(html).not.toContain(`Search Fixture Employer 001`)
    expect(emailLine(null)).toBe("Cello has not found this employer's job site yet.")
  })
})

describe('Remove company', () => {
  it('names what stays and what goes, from counts read first', () => {
    const lines = removeLines('Stripe', { applications: 2, conversations: 1, people: 3, notes: true })
    expect(lines.stays).toEqual(['Your 2 applications with Stripe stay.', 'Your 1 conversation stays.', 'The 3 people you know there stay.'])
    expect(lines.goes).toEqual(['You stop following Stripe.', 'Your notes on it are deleted.'])
    expect(removeLines('Stripe', { applications: 0, conversations: 0, people: 0, notes: false }).stays).toEqual([])
  })

  it('is offered on the person\'s own row only', () => {
    expect(text(view())).toContain('Remove company')
    expect(text(view(fixtureCompany({ following: false, companyId: null, remove: null })))).not.toContain('Remove company')
  })
})

describe('the preview of a posting', () => {
  const preview = (query = q({ all: true, page: 2 })) => renderToStaticMarkup(<PreviewView data={fixturePreview} query={query} now={FIXTURE_NOW} />)

  it('says it is not saved, and offers the four things that keep it', () => {
    const html = preview()
    const t = text(html)
    expect(t).toContain('Not saved. Interested or Apply keeps it.')
    for (const k of ['Interested', 'Apply', 'Save', 'Change type', 'Check my chance']) expect(t).toContain(k)
  })

  it('sets the title and the company at one weight, with the facts the employer stated', () => {
    const html = preview()
    expect(html.match(/class="r-name( hover:underline)?"/g)!.length).toBeGreaterThanOrEqual(2)
    expect(text(html)).toContain('ML Engineer · Staff · Remote, US · $210,000 to $260,000 a year')
  })

  it('goes back to the same page of the list with the same filters', () => {
    const html = preview(q({ all: true, type: 'ai-engineer', page: 2 }))
    expect(html).toContain(`href="/companies/${id}?all=1&amp;type=ai-engineer&amp;p=2"`)
    expect(text(html)).toContain('Back to Fixture Employer 001')
  })

  it('reads the requirements by code first: pluses with their quote, the rest not sure', () => {
    const t = text(preview())
    expect(t).toContain('1 plus')
    expect(t).toContain('I ran Python services in production for six years.')
    expect(t).toContain('Not found in your resume, answers or material')
  })

  it('says a posting no longer listed is gone, with a way back', () => {
    const html = renderToStaticMarkup(<PreviewClosed company="Stripe" back="/companies/x?all=1" />)
    expect(text(html)).toContain('This role is no longer listed.')
    expect(html).toContain('href="/companies/x?all=1"')
  })
})
