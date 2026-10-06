// A read that cannot back a claim does not make it: one robots-disallowed page does not condemn a
// site, a list of roles whose pages are empty shells is "could not read" (never "no open roles"),
// a crashed browser step is not "no roles", and a card with a javascript: link does not end a read.

import { describe, expect, it, vi } from 'vitest'
import type { ExistingJob } from '../../ats/index'
import { fakeFetcher, type Route } from './fake-fetcher'
import { readSite } from './index'
import { roleLinks } from './listing'
import { recheckStoredRoles } from './recheck'
import { ReaderError } from './site-fetch'
import { NO_TARGETS, type ReaderTargets } from './targets'

vi.mock('../../security/untrusted', async (orig) => ({
  ...(await orig<typeof import('../../security/untrusted')>()),
  assertSsrfSafe: async () => {},
}))

const targets: ReaderTargets = {
  targeting: { ...NO_TARGETS.targeting, functions: ['engineering', 'data'], seniority: ['junior', 'mid'] },
  titles: [],
}
const input = (careerUrl: string, name = 'Shop', domain = 'shop.test') => ({ company: { name, domain, careerUrl }, targets })

const posting = (title: string, id: number) =>
  `<html><head><title>${title}</title><script type="application/ld+json">${JSON.stringify({
    '@type': 'JobPosting',
    title,
    datePosted: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    hiringOrganization: { name: 'Shop' },
    jobLocation: { address: { addressLocality: 'Austin', addressRegion: 'TX' } },
    identifier: { value: String(id) },
  })}</script></head><body><h1>${title}</h1></body></html>`

const sitemap = (urls: string[]) => `<urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`
const ROBOTS = 'Sitemap: https://shop.test/sitemap-jobs.xml\nUser-agent: *\nDisallow: /jobs/secret/\n'

describe('one robots-disallowed role page does not condemn a site', () => {
  it('a sitemap whose newest entries are disallowed is still read through the allowed ones', async () => {
    const secret = Array.from({ length: 20 }, (_, i) => `https://shop.test/jobs/secret/${9_000_000 + i}`)
    const open = Array.from({ length: 12 }, (_, i) => `https://shop.test/jobs/job/${1_000_000 + i}`)
    const routes: Record<string, Route> = { 'https://shop.test/robots.txt': ROBOTS, 'https://shop.test/sitemap-jobs.xml': sitemap([...secret, ...open]) }
    for (const [i, u] of open.entries()) routes[u] = posting(`Data Engineer ${i}`, i)
    const f = fakeFetcher(routes)
    const read = await readSite(input('https://shop.test/careers'), { fetcher: f })
    expect(read.reason).toBeNull()
    expect(read.tier).toBe('sitemap')
    expect(read.jobs.length).toBeGreaterThan(0)
    expect(f.calls.some((c) => c.includes('/jobs/secret/'))).toBe(false)
    expect(read.listedIds?.some((id) => id.includes('/secret/'))).toBe(false)
  })

  it('a site that disallows every role page it lists is "robots"', async () => {
    const secret = Array.from({ length: 5 }, (_, i) => `https://shop.test/jobs/secret/${9_000_000 + i}`)
    const f = fakeFetcher({ 'https://shop.test/robots.txt': ROBOTS, 'https://shop.test/sitemap-jobs.xml': sitemap(secret) })
    const read = await readSite(input('https://shop.test/careers'), { fetcher: f })
    expect(read).toMatchObject({ tier: null, reason: 'robots' })
  })

  it('a listing whose first links are disallowed is read through the allowed ones', async () => {
    const card = (path: string, id: number, title: string) => `<li><a href="${path}/${id}"><h3>${title}</h3></a></li>`
    const html = `<ul>${[1, 2, 3].map((i) => card('/jobs/secret', 8_000_000 + i, `Data Engineer ${i}`)).join('')}${[1, 2, 3, 4].map((i) => card('/jobs/job', 2_000_000 + i, `Backend Engineer ${i}`)).join('')}</ul>`
    const routes: Record<string, Route> = { 'https://shop.test/robots.txt': ROBOTS, 'https://shop.test/careers': html }
    for (let i = 1; i <= 4; i++) routes[`https://shop.test/jobs/job/${2_000_000 + i}`] = posting(`Backend Engineer ${i}`, i)
    const f = fakeFetcher(routes)
    const read = await readSite(input('https://shop.test/careers'), { fetcher: f })
    expect(read.reason).toBeNull()
    expect(read.tier).toBe('listing')
    expect(read.jobs.length).toBe(4)
    expect(f.calls.some((c) => c.includes('/jobs/secret/'))).toBe(false)
  })
})

describe('a tier claims success only with a role confirmed on its own page', () => {
  const urls = Array.from({ length: 40 }, (_, i) => `https://shop.test/jobs/job/${3_000_000 + i}`)
  const shell = '<html><head><title>Shop Careers</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>'
  const routes = (): Record<string, Route> => {
    const r: Record<string, Route> = { 'https://shop.test/robots.txt': ROBOTS, 'https://shop.test/sitemap-jobs.xml': sitemap(urls) }
    for (const u of urls) r[u] = shell
    return r
  }

  it('a sitemap of role pages that are script shells is "could not read", with no page marked as checked', async () => {
    const read = await readSite(input('https://shop.test/careers'), { fetcher: fakeFetcher(routes()) })
    expect(read.tier).toBeNull()
    expect(read.jobs).toEqual([])
    expect(read.reason).toBe('role_pages')
    expect(read.reason).not.toBe('no_roles')
    expect(read.checked).toEqual([])
    expect(read.tried.find((t) => t.tier === 'sitemap')?.outcome).toBe('role_pages')
  })

  it('while a browser pass is still to come the same site is "reading", still with nothing marked as checked', async () => {
    const read = await readSite(input('https://shop.test/careers'), { fetcher: fakeFetcher(routes()), renderedLater: true })
    expect(read).toMatchObject({ tier: null, reason: 'reading', checked: [] })
  })

  it('a listing whose role pages are shells is "could not read", not "no roles"', async () => {
    const card = (id: number) => `<li><a href="/jobs/job/${id}"><h3>Data Engineer ${id}</h3></a></li>`
    const r: Record<string, Route> = { 'https://shop.test/careers': `<ul>${[1, 2, 3, 4].map((i) => card(4_000_000 + i)).join('')}</ul>` }
    for (let i = 1; i <= 4; i++) r[`https://shop.test/jobs/job/${4_000_000 + i}`] = shell
    const read = await readSite(input('https://shop.test/careers'), { fetcher: fakeFetcher(r) })
    expect(read).toMatchObject({ tier: null, jobs: [], reason: 'role_pages', checked: [] })
  })

  it('a list of roles whose pages are a different page for every address is not a shell', async () => {
    const r = routes()
    for (const [i, u] of urls.slice(-5).entries()) r[u] = posting(`Data Engineer ${i}`, i)
    const read = await readSite(input('https://shop.test/careers'), { fetcher: fakeFetcher(r) })
    expect(read.tier).toBe('sitemap')
    expect(read.checked.length).toBeGreaterThan(0)
  })

  it('a site that lists nothing at all is still "no roles"', async () => {
    const read = await readSite(input('https://shop.test/careers'), { fetcher: fakeFetcher({ 'https://shop.test/careers': '<p>Nothing here</p>' }) })
    expect(read.reason).toBe('no_roles')
  })
})

describe('a card with a link that is not a page', () => {
  const card = (id: number, extra: string) => `<li><a href="/jobs/job/${id}"><h3>Data Engineer ${id}</h3></a>${extra}<span>Oct 03, 2026</span></li>`

  it.each([
    ['javascript:', '<a href="javascript:void(0)">Save</a>'],
    ['tel:', '<a href="tel:+15551234">Call</a>'],
    ['mailto:', '<a href="mailto:jobs@shop.test">Email</a>'],
    ['a malformed address', '<a href="http://[bad">x</a>'],
  ])('%s inside a role card does not stop roleLinks', (_name, extra) => {
    const html = `<ul>${[1, 2, 3].map((i) => card(5_000_000 + i, extra)).join('')}</ul>`
    expect(() => roleLinks(html, 'https://shop.test/careers')).not.toThrow()
    const links = roleLinks(html, 'https://shop.test/careers')
    expect(links).toHaveLength(3)
    expect(links[0].postedAt).toBe('2026-10-03T00:00:00.000Z')
  })

  it('a rendered page with such a card is read', async () => {
    const html = `<html><body><ul>${[1, 2, 3].map((i) => card(6_000_000 + i, '<a href="javascript:void(0)">Save</a>')).join('')}</ul></body></html>`
    const r: Record<string, Route> = { 'https://shop.test/careers': '<div id="root"></div>' }
    for (let i = 1; i <= 3; i++) r[`https://shop.test/jobs/job/${6_000_000 + i}`] = posting(`Data Engineer ${i}`, i)
    const fetchPage = vi.fn(async (url: string) => ({ html, finalUrl: url, rendered: true }))
    const read = await readSite(input('https://shop.test/careers'), { fetcher: fakeFetcher(r, 'scheduled'), fetchPage, model: null })
    expect(read.tier).toBe('rendered')
    expect(read.jobs.length).toBe(3)
  })
})

describe('a browser step that fails is not "no roles"', () => {
  const careers = 'https://shop.test/careers'
  const shell = '<html><body><div id="root"></div></body></html>'
  const scheduled = (fetchPage: NonNullable<Parameters<typeof readSite>[1]['fetchPage']>) =>
    readSite(input(careers), { fetcher: fakeFetcher({ [careers]: shell }, 'scheduled'), fetchPage, model: null })

  it('keeps the fetcher error class and records "render_failed"', async () => {
    const read = await scheduled(async () => {
      throw new Error('fetcher_ModuleNotFoundError')
    })
    expect(read.tier).toBeNull()
    expect(read.reason).toBe('render_failed')
    expect(read.reason).not.toBe('no_roles')
    expect(read.tried.find((t) => t.tier === 'rendered')).toMatchObject({ outcome: 'render_failed', detail: 'fetcher_ModuleNotFoundError' })
  })

  it('a timeout is the same', async () => {
    const read = await scheduled(async () => {
      throw new Error('fetcher_failed')
    })
    expect(read.reason).toBe('render_failed')
  })

  it("a bot check the browser step met is the site's answer, not a crash", async () => {
    const read = await scheduled(async () => {
      throw new ReaderError('bot_check')
    })
    expect(read.reason).toBe('bot_check')
  })

  it('when the browser step works and finds nothing the answer is still "no roles"', async () => {
    const read = await scheduled(async (url) => ({ html: '<html><body><p>Hello</p></body></html>', finalUrl: url, rendered: true }))
    expect(read.reason).toBe('no_roles')
  })
})

describe('a role that has left a site is closed by its own page', () => {
  const stored = (id: string, over: Partial<ExistingJob> = {}): ExistingJob => ({
    externalId: `https://shop.test/jobs/${id}`,
    title: `Role ${id}`,
    location: 'Austin',
    salaryRange: null,
    descriptionMd5: 'x',
    source: 'listing',
    open: true,
    url: `https://shop.test/jobs/${id}`,
    lastSeenAt: `2026-09-${id.padStart(2, '0')}T00:00:00Z`,
    ...over,
  })
  const run = async (jobs: ExistingJob[], routes: Record<string, Route>, opts: { limit?: number; seen?: string[]; byTitle?: boolean } = {}) => {
    const closed: string[] = []
    const store = {
      updateJobs: async (u: { externalId: string; fields: Record<string, unknown> }[]) => {
        for (const x of u) {
          expect(x.fields.still_open).toBe(false)
          closed.push(x.externalId)
        }
        return u.length
      },
    }
    const f = fakeFetcher({ 'https://shop.test/robots.txt': 'User-agent: *\nDisallow: /jobs/blocked\n', ...routes }, 'scheduled')
    const out = await recheckStoredRoles(store, 'c1', new Map(jobs.map((j) => [j.externalId, j])), f, { sources: ['listing'], seen: new Set(opts.seen ?? []), limit: opts.limit, byTitle: opts.byTitle })
    return { out, closed, f }
  }

  it('closes a role whose page is 404 or 410 and keeps one that still answers', async () => {
    const jobs = [stored('1'), stored('2'), stored('3')]
    const { closed, out } = await run(jobs, {
      'https://shop.test/jobs/1': { status: 404 },
      'https://shop.test/jobs/2': { status: 410 },
      'https://shop.test/jobs/3': posting('Role 3', 3),
    })
    expect(closed.sort()).toEqual(['https://shop.test/jobs/1', 'https://shop.test/jobs/2'])
    expect(out).toEqual({ asked: 3, closed: 2 })
  })

  it('closes a role whose page says validThrough has passed', async () => {
    const past = `<html><head><title>Role 4</title><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Role 4', validThrough: '2026-01-01' })}</script></head></html>`
    const { closed } = await run([stored('4')], { 'https://shop.test/jobs/4': past })
    expect(closed).toEqual(['https://shop.test/jobs/4'])
  })

  it('closes a role whose page answers 200 but no longer names it, only for roles a page confirmed', async () => {
    const notFound = '<html><head><title>Careers</title></head><body><h1>Page not found.</h1></body></html>'
    const routes = { 'https://shop.test/jobs/5': notFound, 'https://shop.test/jobs/6': posting('Role 6', 6) }
    const jobs = [stored('5'), stored('6')]
    const withTitle = await run(jobs, routes, { byTitle: true })
    expect(withTitle.closed).toEqual(['https://shop.test/jobs/5'])
    // A role found through a JSON search was never confirmed by its page, so a page that answers is left alone.
    expect((await run(jobs, routes)).closed).toEqual([])
  })

  it('asks the oldest sighting first, only a few at a time, and never one this read just listed', async () => {
    const jobs = ['1', '2', '3', '4', '5'].map((i) => stored(i))
    const { f } = await run(jobs, {}, { limit: 2, seen: ['https://shop.test/jobs/1'] })
    expect(f.calls.filter((c) => c.includes('/jobs/'))).toEqual(['https://shop.test/jobs/2', 'https://shop.test/jobs/3'])
  })

  it('leaves a role alone when its page is disallowed by robots.txt, fails, or the role belongs to another source', async () => {
    const jobs = [stored('blocked'), stored('9'), stored('8', { source: 'greenhouse' }), stored('7', { open: false })]
    const { closed } = await run(jobs, { 'https://shop.test/jobs/9': { error: 'unreachable' } })
    expect(closed).toEqual([])
  })
})

describe('a board that answers with an error is "did not answer", not "reading"', () => {
  it('keeps the reason through to the answer', async () => {
    const url = 'https://acme.test/careers'
    const page = '<a href="https://boards.greenhouse.io/acmehq">Roles</a>'
    const read = await readSite(input(url, 'Acme', 'acme.test'), {
      fetcher: fakeFetcher({ [url]: page }),
      renderedLater: true,
      readBoard: async () => {
        throw new ReaderError('unreachable')
      },
    })
    expect(read).toMatchObject({ tier: null, reason: 'unreachable' })
  })
})

describe('a card is not a role until its own page names it', () => {
  it('a card whose role page has no title of its own is not stored from the card alone', async () => {
    const card = (id: number) => `<li><a href="/jobs/job/${id}"><h3>Data Engineer ${id}</h3></a></li>`
    const r: Record<string, Route> = { 'https://shop.test/careers': `<ul>${[1, 2, 3].map((i) => card(7_000_000 + i)).join('')}</ul>` }
    for (let i = 1; i <= 3; i++) r[`https://shop.test/jobs/job/${7_000_000 + i}`] = '<html><body><div id="root"></div></body></html>'
    const read = await readSite(input('https://shop.test/careers'), { fetcher: fakeFetcher(r) })
    expect(read).toMatchObject({ tier: null, jobs: [], reason: 'role_pages' })
  })

  it('styles and icons inside a card link are not part of the title', () => {
    const card = (id: number) => `<li><a href="/jobs/job/${id}"><style>.st0{fill:none;}</style><svg><title>icon</title></svg><h3>Data Engineer ${id}</h3><p>Austin, TX</p></a></li>`
    const links = roleLinks(`<ul>${[1, 2, 3].map((i) => card(8_100_000 + i)).join('')}</ul>`, 'https://shop.test/careers')
    expect(links.map((l) => l.title)).toEqual(['Data Engineer', 'Data Engineer', 'Data Engineer'])
    expect(JSON.stringify(links)).not.toContain('fill')
  })
})
