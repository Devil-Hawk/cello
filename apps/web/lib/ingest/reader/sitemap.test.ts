import { describe, expect, it } from 'vitest'
import { fakeFetcher, fixture } from './fake-fetcher'
import { isPostingUrl, lastmodsMeanSomething, orderEntries, readSitemapEntries, readSitemapRoles } from './sitemap'
import { NO_TARGETS, type ReaderTargets } from './targets'

const targets: ReaderTargets = {
  targeting: { ...NO_TARGETS.targeting, functions: ['engineering', 'data'], seniority: ['junior', 'mid'] },
  titles: [],
}

const meta = () =>
  fakeFetcher({
    'https://www.metacareers.com/robots.txt': fixture('meta-robots.txt'),
    'https://www.metacareers.com/jobsearch/sitemap.xml': fixture('meta-sitemap.xml'),
    'https://www.metacareers.com/profile/job_details/*': '',
  })

describe('sitemap tier: Meta', () => {
  it('finds the job sitemap through robots.txt and keeps only job URLs', async () => {
    const { entries, complete } = await readSitemapEntries('https://www.metacareers.com', meta())
    expect(entries).toHaveLength(50)
    expect(entries.every((e) => e.url.includes('/profile/job_details/'))).toBe(true)
    expect(complete).toBe(true)
  })

  it('says the list is not complete when a job sitemap was left unread', async () => {
    const map = (name: string) => `<sitemap><loc>https://acme.test/${name}-jobs.xml</loc></sitemap>`
    const urls = '<url><loc>https://acme.test/jobs/1234567</loc></url>'
    const routes: Record<string, string> = {
      'https://acme.test/robots.txt': 'Sitemap: https://acme.test/jobs-index.xml\n',
      'https://acme.test/jobs-index.xml': `<sitemapindex>${['a', 'b', 'c', 'd', 'e', 'f'].map(map).join('')}</sitemapindex>`,
    }
    for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) routes[`https://acme.test/${n}-jobs.xml`] = `<urlset>${urls}</urlset>`
    const read = await readSitemapEntries('https://acme.test', fakeFetcher(routes))
    expect(read.entries.length).toBeGreaterThan(0)
    expect(read.complete).toBe(false)
  })

  it('orders by the largest numeric id when lastmod is the same everywhere', async () => {
    const { entries } = await readSitemapEntries('https://www.metacareers.com', meta())
    const ids = orderEntries(entries, targets).map((e) => Number(/details\/(\d+)/.exec(e.url)![1]))
    expect(ids).toEqual([...ids].sort((a, b) => b - a))
  })

  it('reads each page JobPosting, only up to the per-read cap, and remembers what it read', async () => {
    const { entries } = await readSitemapEntries('https://www.metacareers.com', meta())
    const first = orderEntries(entries, targets)[0].url
    const routes: Record<string, string> = {
      'https://www.metacareers.com/robots.txt': fixture('meta-robots.txt'),
      'https://www.metacareers.com/jobsearch/sitemap.xml': fixture('meta-sitemap.xml'),
    }
    for (const e of entries) routes[e.url] = fixture('meta-job.html')
    const f = fakeFetcher(routes)
    const read = await readSitemapRoles('https://www.metacareers.com', f, { targets: { ...targets, titles: [] }, skip: new Set(), max: 3 })
    expect(read.listed).toBe(50)
    expect(read.listedIds).toHaveLength(50)
    expect(read.checked).toHaveLength(3)
    expect(f.calls.filter((c) => c.includes('/profile/job_details/'))).toHaveLength(3)
    expect(f.calls[f.calls.length - 3].startsWith(first.slice(0, 40))).toBe(true)
    // The fixture page is an engineering role at Meta, dated 2026-10-02.
    expect(read.jobs[0]).toMatchObject({ employer: 'Meta', postedAt: '2026-10-02T16:46:48.000Z' })

    // The next pass skips what was read.
    const f2 = fakeFetcher(routes)
    const again = await readSitemapRoles('https://www.metacareers.com', f2, { targets, skip: new Set(read.checked), max: 3 })
    expect(again.checked.some((id) => read.checked.includes(id))).toBe(false)
  })
})

describe('sitemap tier: Walmart', () => {
  const f = () =>
    fakeFetcher({
      'https://careers.walmart.com/robots.txt': fixture('walmart-robots.txt'),
      'https://careers.walmart.com/sitemap.xml': fixture('walmart-sitemap.xml'),
    })

  it('keeps R-<n> role URLs and drops the department and landing pages', async () => {
    const { entries } = await readSitemapEntries('https://careers.walmart.com', f())
    expect(entries.length).toBe(50)
    expect(entries.every((e) => /\/us\/en\/jobs\/R-\d+$/.test(e.url))).toBe(true)
  })

  it('never fetches a role page robots.txt disallows (/results, /api)', async () => {
    const g = f()
    expect(await g.allowed('https://careers.walmart.com/us/en/results?q=data')).toBe(false)
    expect(await g.allowed('https://careers.walmart.com/us/en/jobs/R-2666785')).toBe(true)
  })

  it('reads a role page: title from the heading, date from the embedded createdAt', async () => {
    const routes: Record<string, string> = {
      'https://careers.walmart.com/robots.txt': fixture('walmart-robots.txt'),
      'https://careers.walmart.com/sitemap.xml': fixture('walmart-sitemap.xml'),
    }
    const { entries } = await readSitemapEntries('https://careers.walmart.com', f())
    for (const e of entries) routes[e.url] = fixture('walmart-job.html')
    const read = await readSitemapRoles('https://careers.walmart.com', fakeFetcher(routes), { targets: NO_TARGETS, skip: new Set(), max: 5 })
    expect(read.jobs).toHaveLength(5)
    expect(read.jobs[0]).toMatchObject({ title: '(USA) Merchandising Lead', postedAt: '2026-10-02T23:55:26.015Z' })
  })
})

describe('sitemap tier: a lastmod that is only the time the sitemap was made', () => {
  const origin = 'https://jobs.zalando.com'
  const routes = (): Record<string, string> => ({
    [`${origin}/robots.txt`]: `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`,
    [`${origin}/sitemap.xml`]: fixture('zalando-sitemap.xml'),
  })

  it('Zalando stamps every role within a millisecond of the fetch: that is not a posting date', async () => {
    const { entries } = await readSitemapEntries(origin, fakeFetcher(routes()))
    expect(entries.length).toBeGreaterThan(30)
    expect(new Set(entries.map((e) => e.lastmod)).size).toBe(2)
    expect(lastmodsMeanSomething(entries)).toBe(false)
    // Read two weeks later it is still one moment, not a spread of dates.
    expect(lastmodsMeanSomething(entries, Date.parse('2026-10-19T00:00:00Z'))).toBe(false)
    // So order is by the numeric id, newest first.
    const ids = orderEntries(entries, NO_TARGETS).map((e) => Number(/jobs\/(\d+)/.exec(e.url)![1]))
    expect(ids).toEqual([...ids].sort((a, b) => b - a))
  })

  it('a role from such a sitemap is stored undated, never as posted today', async () => {
    const r = routes()
    const { entries } = await readSitemapEntries(origin, fakeFetcher(r))
    for (const e of entries) r[e.url] = '<html><head><title>Data Engineer - Jobs at Zalando</title><script type="application/ld+json">{"@type":"JobPosting","title":"Data Engineer","jobLocation":{"address":{"addressLocality":"Berlin"}},"description":"Build pipelines."}</script></head><body><h1>Data Engineer</h1></body></html>'
    const read = await readSitemapRoles(origin, fakeFetcher(r), { targets: NO_TARGETS, skip: new Set(), max: 3 })
    expect(read.jobs).toHaveLength(3)
    expect(read.jobs.every((j) => j.postedAt === undefined)).toBe(true)
  })

  it('stamps spread over weeks are posting dates, unless they cluster at the fetch time', () => {
    const now = Date.parse('2026-10-05T12:00:00Z')
    const day = (n: number) => new Date(now - n * 86_400_000).toISOString()
    const spread = [1, 4, 9, 20].map((n) => ({ url: `https://x.test/jobs/${4000000 + n}`, lastmod: day(n) }))
    expect(lastmodsMeanSomething(spread, now)).toBe(true)
    const clustered = [...Array.from({ length: 20 }, (_, i) => ({ url: `https://x.test/jobs/${5000000 + i}`, lastmod: new Date(now - i * 1000).toISOString() })), { url: 'https://x.test/jobs/4000001', lastmod: day(40) }]
    expect(lastmodsMeanSomething(clustered, now)).toBe(false)
    expect(lastmodsMeanSomething([{ url: 'https://x.test/jobs/4000001', lastmod: day(3) }], now)).toBe(false)
    expect(lastmodsMeanSomething([{ url: 'https://x.test/jobs/4000001' }, { url: 'https://x.test/jobs/4000002' }], now)).toBe(false)
  })
})

describe('sitemap tier: only the employer own pages are fetched', () => {
  it('an entry on another site is never requested', async () => {
    const f = fakeFetcher({
      'https://acme.test/robots.txt': 'User-agent: *\nAllow: /\nSitemap: https://acme.test/jobs-sitemap.xml\n',
      'https://acme.test/jobs-sitemap.xml':
        '<urlset><url><loc>https://acme.test/jobs/4000001-data-engineer</loc></url><url><loc>https://evil.test/jobs/4000002-data-engineer</loc></url></urlset>',
      'https://acme.test/jobs/4000001-data-engineer': '<html><head><title>Data Engineer</title><script type="application/ld+json">{"@type":"JobPosting","title":"Data Engineer","jobLocation":{"address":{"addressLocality":"Berlin"}},"description":"Build pipelines."}</script></head><body><h1>Data Engineer</h1></body></html>',
    })
    const own = (u: string) => new URL(u).hostname === 'acme.test'
    const read = await readSitemapRoles('https://acme.test', f, { targets: NO_TARGETS, skip: new Set(), ownSite: own })
    expect(read.jobs.map((j) => j.url)).toEqual(['https://acme.test/jobs/4000001-data-engineer'])
    expect(f.calls.some((c) => c.includes('evil.test'))).toBe(false)
  })
})

describe('sitemap tier: a role page that names the applicant system ends the read', () => {
  it('returns the board and stops fetching pages', async () => {
    const urls = Array.from({ length: 8 }, (_, i) => `https://acme.test/jobs/400000${i}-data-engineer`)
    const routes: Record<string, string> = {
      'https://acme.test/robots.txt': 'User-agent: *\nAllow: /\nSitemap: https://acme.test/jobs-sitemap.xml\n',
      'https://acme.test/jobs-sitemap.xml': `<urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`,
    }
    for (const u of urls) routes[u] = '<html><head><title>Data Engineer</title></head><body><h1>Data Engineer</h1><a href="https://boards.greenhouse.io/acmeco/jobs/1">Apply</a></body></html>'
    const f = fakeFetcher(routes)
    const read = await readSitemapRoles('https://acme.test', f, { targets: NO_TARGETS, skip: new Set(), max: 8 })
    expect(read.board).toEqual({ provider: 'greenhouse', token: 'acmeco' })
    expect(f.calls.filter((c) => c.includes('/jobs/4')).length).toBeLessThanOrEqual(2)
  })
})

describe('sitemap helpers', () => {
  it('tells a role URL from a policy, department or landing page', () => {
    expect(isPostingUrl('https://www.metacareers.com/profile/job_details/1616812923224613/')).toBe(true)
    expect(isPostingUrl('https://careers.walmart.com/us/en/jobs/R-2666785')).toBe(true)
    expect(isPostingUrl('https://careers.walmart.com/us/en/sams-home/careers-areas/Corporate')).toBe(false)
    expect(isPostingUrl('https://www.metacareers.com/privacy')).toBe(false)
  })

  it('with targets, an entry whose slug names another role is dropped before any fetch; one with no slug stays', () => {
    const e = [
      { url: 'https://x.test/jobs/4000001-senior-data-engineer' },
      { url: 'https://x.test/jobs/4000002-pastry-chef' },
      { url: 'https://x.test/jobs/4000003' },
    ]
    expect(orderEntries(e, targets).map((x) => x.url)).toEqual(['https://x.test/jobs/4000001-senior-data-engineer', 'https://x.test/jobs/4000003'])
  })

  it('a slug that comes before the ids is read for its words (Kaiser), a bare section word is not', () => {
    const e = [
      { url: 'https://x.test/job/oakland/data-analyst/641/101619510336' },
      { url: 'https://x.test/job/oakland/medical-assistant/641/101619510337' },
      { url: 'https://x.test/jobs/4000009' },
    ]
    expect(orderEntries(e, targets).map((x) => x.url)).toEqual(['https://x.test/job/oakland/data-analyst/641/101619510336', 'https://x.test/jobs/4000009'])
  })
})
