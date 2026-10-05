import { describe, expect, it } from 'vitest'
import { fakeFetcher, fixture } from './fake-fetcher'
import { isPostingUrl, orderEntries, readSitemapEntries, readSitemapRoles } from './sitemap'
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
})
