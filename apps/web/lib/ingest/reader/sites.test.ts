import { describe, expect, it } from 'vitest'
import { fakeFetcher, fixture } from './fake-fetcher'
import { amazonJobs, siteFor, tiktokJobs } from './sites'
import { NO_TARGETS, type ReaderTargets } from './targets'
import { judgeRole } from './legit'

const targets: ReaderTargets = {
  targeting: { ...NO_TARGETS.targeting, functions: ['engineering', 'data'], seniority: ['junior', 'mid'] },
  titles: [],
}

describe('site search recipes', () => {
  it('finds a recipe by careers host only', () => {
    expect(siteFor('https://www.amazon.jobs/en/search')?.id).toBe('amazon')
    expect(siteFor('https://lifeattiktok.com/')?.id).toBe('tiktok')
    expect(siteFor('https://stripe.com/jobs')).toBeNull()
    expect(siteFor('https://amazon.jobs.evil.example/')).toBeNull()
  })

  it('Amazon: reads title, url, employer, location, date and requisition id', () => {
    const jobs = amazonJobs(JSON.parse(fixture('amazon-search.json')))
    expect(jobs).toHaveLength(5)
    expect(jobs[2]).toMatchObject({
      title: 'Bus Intel Eng II AMZ1242164, Reputation Marketing & Insights',
      url: 'https://www.amazon.jobs/en/jobs/10567500/bus-intel-eng-ii-amz1242164-reputation-marketing-insights',
      employer: 'Amazon.com Services LLC - A57',
      postedAt: '2026-10-01T00:00:00.000Z',
    })
    expect(jobs[2].requisitionId).toMatch(/^\d+$/)
    expect(jobs[2].description?.length).toBeGreaterThan(50)
  })

  it('Amazon: every role is the employer own (amazon.jobs agrees, IMDb included)', () => {
    const ctx = { company: { name: 'Amazon', domain: 'amazon.com', careerUrl: 'https://www.amazon.jobs/en/search' }, now: Date.parse('2026-10-06T00:00:00Z') }
    for (const job of amazonJobs(JSON.parse(fixture('amazon-search.json')))) expect(judgeRole(job, ctx)).toEqual({ keep: true })
  })

  it('Amazon: asks for the person target on the site search, 100 per page, newest first', async () => {
    const f = fakeFetcher({ 'https://www.amazon.jobs/en/search.json*': fixture('amazon-search.json') })
    const jobs = await siteFor('https://www.amazon.jobs/en/search')!.read(f, targets)
    expect(jobs.length).toBeGreaterThan(0)
    expect(f.jsonCalls.map((c) => c.url)).toEqual([
      'https://www.amazon.jobs/en/search.json?base_query=software%20engineer&loc_query=&result_limit=100&offset=0&sort=recent',
      'https://www.amazon.jobs/en/search.json?base_query=data&loc_query=&result_limit=100&offset=0&sort=recent',
    ])
  })

  it('TikTok: posts the search with the site static headers and builds the role address from its id', async () => {
    const jobs = tiktokJobs(JSON.parse(fixture('tiktok-search.json')))
    expect(jobs).toHaveLength(5)
    expect(jobs[0]).toMatchObject({ title: 'Data Engineer, E-Commerce', url: 'https://lifeattiktok.com/search/7117084434700110094' })
    expect(jobs[0].location).toContain('San Jose')
    expect(jobs[0].postedAt).toBeUndefined()

    const f = fakeFetcher({ 'https://api.lifeattiktok.com/api/v1/public/supplier/search/job/posts': fixture('tiktok-search.json') })
    await siteFor('https://lifeattiktok.com/')!.read(f, targets)
    expect(JSON.parse(f.jsonCalls[0].body ?? '{}')).toMatchObject({ keyword: 'software engineer', limit: 50, offset: 0 })
  })

  it('a site that refuses the request is an error for the tier, not a crash', async () => {
    const f = fakeFetcher({ 'https://www.amazon.jobs/en/search.json*': { error: 'bot_check' } })
    await expect(siteFor('https://www.amazon.jobs/')!.read(f, targets)).rejects.toMatchObject({ reason: 'bot_check' })
  })
})
