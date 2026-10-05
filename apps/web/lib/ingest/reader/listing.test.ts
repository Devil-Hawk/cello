import { describe, expect, it } from 'vitest'
import { fakeFetcher, fixture } from './fake-fetcher'
import { listingSiteFor, readListing, roleLinks, templateOf } from './listing'
import { NO_TARGETS, type ReaderTargets } from './targets'

const engData: ReaderTargets = { targeting: { ...NO_TARGETS.targeting, functions: ['engineering', 'data'] }, titles: [] }

const APPLE = 'https://jobs.apple.com/en-us/search?sort=newest&location=united-states-USA'
const GOOGLE = 'https://www.google.com/about/careers/applications/jobs/results?q=data%20engineer&location=United%20States'

describe('roleLinks', () => {
  it('Apple: 20 distinct roles with titles and the card date, the duplicate anchors folded', () => {
    const links = roleLinks(fixture('apple-search.html'), APPLE)
    expect(links).toHaveLength(20)
    expect(links[0]).toMatchObject({
      title: 'Front End Web Accessibility Engineer, Retail Engineering',
      url: 'https://jobs.apple.com/en-us/details/200684990-3956/front-end-web-accessibility-engineer-retail-engineering?team=SFTWR',
      postedAt: '2026-10-05T00:00:00.000Z',
    })
    // The page's nav links (no ids) are not roles.
    expect(links.every((l) => l.url.includes('/details/'))).toBe(true)
  })

  it('Google: 20 roles from relative links, resolved against the page base, titles from aria-label', () => {
    const links = roleLinks(fixture('google-search.html'), GOOGLE)
    expect(links).toHaveLength(20)
    expect(links[0].url).toBe('https://www.google.com/about/careers/applications/jobs/results/120374375760175814-senior-data-engineer-gtech-users-and-products?q=data+engineer&location=United+States')
    expect(links[0].title).toBe('Senior Data Engineer, gTech Users and Products')
    expect(links[0].postedAt).toBeUndefined()
    // The card says where each role is, under its heading: that is the role's place (no detail page carries it as data).
    expect(links.every((l) => (l.location ?? '').length > 2)).toBe(true)
    expect(links[0].location).toBe('Boulder, CO, USA')
    expect(links.some((l) => /\+\d+ more/.test(l.location ?? ''))).toBe(false)
  })

  it('NYT: the job-listings page lists roles by id-and-slug', () => {
    const links = roleLinks(fixture('nyt-listing.html'), 'https://www.nytco.com/careers/job-listings/')
    expect(links.length).toBeGreaterThan(30)
    expect(links[0]).toMatchObject({ title: 'Art Director', url: 'https://www.nytco.com/careers/job-listings/4721503005-art-director' })
  })

  it('a navigation menu of links with no ids yields nothing', () => {
    const nav = '<nav><a href="/careers/teams">Teams</a><a href="/careers/benefits">Benefits</a><a href="/careers/locations">Locations</a><a href="/careers/students">Students</a></nav>'
    expect(roleLinks(nav, 'https://acme.test/careers')).toEqual([])
  })

  it('two links with ids is a pair of articles, not a list of roles', () => {
    const html = '<a href="/news/123456-a">One thing</a><a href="/news/234567-b">Another</a>'
    expect(roleLinks(html, 'https://acme.test/')).toEqual([])
  })

  it('templates an id segment, ignoring a slug after it', () => {
    expect(templateOf('/en-us/details/200684990-3956/front-end-engineer')).toBe('/en-us/details/:id')
    expect(templateOf('/careers/teams')).toBeNull()
  })
})

describe('roleLinks: a role id in the query', () => {
  it('DigitalOcean: when the link says only the place, the card own first line is the title', () => {
    const card = (id: number, title: string, place: string) =>
      `<li><div><span>${title}</span></div><div><span>Local from:</span><span><a href="/careers/position/apply?gh_jid=${id}">${place}</a></span></div></li>`
    const html = `<ul>${card(7536702, 'Cloud Operations Administrator - II', 'Seattle')}${card(7975203, 'Director of Engineering, Managed Database Service', 'Bengaluru')}${card(8193121, 'Senior Data Engineer', 'Seattle')}</ul>`
    expect(roleLinks(html, 'https://www.digitalocean.com/careers').map((l) => l.title)).toEqual([
      'Cloud Operations Administrator - II',
      'Director of Engineering, Managed Database Service',
      'Senior Data Engineer',
    ])
  })

  it('DigitalOcean: Greenhouse job-id links on the company own site are a role list, titled by their cards', () => {
    const cards = [7536702, 7586091, 7586093]
      .map((id, i) => `<li><a href="/careers/position/apply?gh_jid=${id}"><h3>Cloud Engineer ${i + 1}</h3><span>Remote</span></a></li>`)
      .join('')
    const links = roleLinks(`<html><body><ul>${cards}</ul></body></html>`, 'https://www.digitalocean.com/careers')
    expect(links.map((l) => l.title)).toEqual(['Cloud Engineer 1', 'Cloud Engineer 2', 'Cloud Engineer 3'])
    expect(links[0].url).toBe('https://www.digitalocean.com/careers/position/apply?gh_jid=7536702')
    expect(templateOf('/careers/position/apply', '?gh_jid=7536702')).toBe('/careers/position/apply?gh_jid=:id')
    expect(templateOf('/careers', '?page=2')).toBeNull()
  })
})

describe('readListing: every role is confirmed on its own page', () => {
  const appleDetail = fixture('apple-detail.html')
  const first = 'https://jobs.apple.com/en-us/details/200684990-3956/front-end-web-accessibility-engineer-retail-engineering?team=SFTWR'

  it('Apple: reads the list, keeps the titles inside the targets, confirms and dates each on its page', async () => {
    const f = fakeFetcher({ [APPLE]: fixture('apple-search.html'), [first]: appleDetail })
    const read = await readListing('https://jobs.apple.com/en-us/search', [], f, { targets: engData, max: 20 })
    expect(read.listed).toBeGreaterThanOrEqual(20)
    expect(read.jobs.map((j) => j.title)).toContain('Front End Web Accessibility Engineer, Retail Engineering')
    const job = read.jobs.find((j) => j.title.startsWith('Front End Web'))!
    expect(job.postedAt).toBe('2026-10-05T03:38:33.059Z')
    // Titles outside the targets were never fetched.
    const fetched = f.calls.filter((c) => c.includes('/details/'))
    expect(fetched.length).toBeLessThan(read.listed)
    // Only the one page the fixture serves exists; a page that does not answer 200 is not a role.
    expect(read.jobs).toHaveLength(1)
  })

  it('drops a role whose own page does not name it', async () => {
    const f = fakeFetcher({ [APPLE]: fixture('apple-search.html'), [first]: '<html><head><title>Careers</title></head><body><h1>Welcome</h1></body></html>' })
    const read = await readListing('https://jobs.apple.com/en-us/search', [], f, { targets: engData, max: 1 })
    expect(read.jobs).toEqual([])
    expect(read.rejected).toBe(1)
  })

  it('Google: only the first page of results is requested (robots.txt disallows page=), 20 roles, no date anywhere', async () => {
    const f = fakeFetcher({
      'https://www.google.com/robots.txt': fixture('google-robots.txt'),
      [GOOGLE]: fixture('google-search.html'),
    })
    const links = roleLinks(fixture('google-search.html'), GOOGLE)
    const detailRoutes: Record<string, string> = {}
    for (const l of links) detailRoutes[l.url] = `<html><head><title>${l.title} \u2014 Google Careers</title></head><body><main>${l.title}</main></body></html>`
    const g = fakeFetcher({ 'https://www.google.com/robots.txt': fixture('google-robots.txt'), [GOOGLE]: fixture('google-search.html'), ...detailRoutes })
    const read = await readListing(GOOGLE, [], g, { targets: { ...engData, titles: ['data engineer'] }, max: 20 })
    expect(read.jobs.length).toBeGreaterThan(5)
    expect(read.jobs.every((j) => j.postedAt === undefined)).toBe(true)
    expect(g.calls.some((c) => /[?&]page=/.test(c))).toBe(false)
    expect(f.calls).toEqual([])
    expect(await g.allowed(`${GOOGLE}&page=2`)).toBe(false)
  })

  it('NYT: confirms roles on the company site and reports the Greenhouse board a role page links to', async () => {
    const list = fixture('nyt-listing.html')
    const detail = fixture('nyt-detail.html')
    const links = roleLinks(list, 'https://www.nytco.com/careers/job-listings/')
    const routes: Record<string, string> = {}
    for (const l of links) routes[l.url] = detail.replace('Art Director', l.title)
    const f = fakeFetcher(routes)
    const read = await readListing('https://www.nytco.com/careers/', [{ url: 'https://www.nytco.com/careers/job-listings/', html: list }], f, { targets: NO_TARGETS, max: 5 })
    // The first role page names the applicant system, which ends the read: the board is the better source.
    expect(read.jobs.length).toBeGreaterThan(0)
    expect(read.jobs.length).toBeLessThanOrEqual(2)
    expect(read.board).toEqual({ provider: 'greenhouse', token: 'thenewyorktimes' })
  })

  it('never fetches a role link that leaves the employer own site', async () => {
    const card = (host: string, id: number) => `<li><a href="https://${host}/careers/job/${id}"><h3>Data Engineer ${id}</h3></a></li>`
    const html = `<ul>${card('acme.test', 1000001)}${card('acme.test', 1000002)}${card('acme.test', 1000003)}${card('evil.test', 1000004)}</ul>`
    const f = fakeFetcher({ 'https://acme.test/careers': html })
    const read = await readListing('https://acme.test/careers', [{ url: 'https://acme.test/careers', html }], f, { targets: NO_TARGETS, ownSite: (u) => new URL(u).hostname === 'acme.test' })
    expect(read.listed).toBe(3)
    expect(f.calls.some((c) => c.includes('evil.test'))).toBe(false)
  })

  it('a list whose roles all sit on another site is never requested, even though it is the biggest list on the page', async () => {
    const card = (host: string, id: number) => `<li><a href="https://${host}/careers/job/${id}"><h3>Data Engineer ${id}</h3></a></li>`
    const own = `<ul>${card('acme.test', 1000001)}${card('acme.test', 1000002)}${card('acme.test', 1000003)}</ul>`
    const foreign = `<ul>${[1, 2, 3, 4, 5].map((i) => card('evil.test', 2000000 + i)).join('')}</ul>`
    const routes: Record<string, string> = {}
    for (const i of [1, 2, 3, 4, 5]) routes[`https://evil.test/careers/job/${2000000 + i}`] = '<html><head><title>Data Engineer</title></head></html>'
    const f = fakeFetcher(routes)
    const pages = [
      { url: 'https://acme.test/careers', html: own },
      { url: 'https://acme.test/careers/more', html: foreign },
    ]
    const read = await readListing('https://acme.test/careers', pages, f, { targets: NO_TARGETS, ownSite: (u) => new URL(u).hostname === 'acme.test' })
    expect(read.listed).toBe(3)
    expect(read.listedIds.every((u) => u.startsWith('https://acme.test/'))).toBe(true)
    expect(f.calls.filter((c) => c.includes('evil.test'))).toEqual([])
  })

  it('knows the search sites it has parameters for, and no others', () => {
    expect(listingSiteFor('https://jobs.apple.com/en-us/search')).not.toBeNull()
    expect(listingSiteFor('https://www.google.com/about/careers/applications/jobs/results/')).not.toBeNull()
    expect(listingSiteFor('https://www.google.com/search?q=x')).toBeNull()
    expect(listingSiteFor('https://stripe.com/jobs')).toBeNull()
  })
})
