import { describe, expect, it } from 'vitest'
import { jobFromDetail, readDetail } from './detail'
import { fixture } from './fake-fetcher'

describe('readDetail: what a role page says about itself', () => {
  it('Meta: the declared JobPosting gives title, date, employer and a description', () => {
    const url = 'https://www.metacareers.com/profile/job_details/1616812923224613/'
    const d = readDetail(fixture('meta-job.html'), url)
    expect(d.title).toBe('ASIC Validation Engineer, Network Validation & Characterization')
    expect(d.postedAt).toBe('2026-10-02T16:46:48.000Z')
    expect(d.employer).toBe('Meta')
    expect((d.description ?? '').length).toBeGreaterThan(200)
  })

  it('Apple: no JobPosting, so the title comes from the page and the date from its embedded postDateInGMT', () => {
    const url = 'https://jobs.apple.com/en-us/details/200684990-3956/front-end-web-accessibility-engineer-retail-engineering'
    const d = readDetail(fixture('apple-detail.html'), url)
    expect(d.title).toBe('Front End Web Accessibility Engineer, Retail Engineering')
    expect(d.postedAt).toBe('2026-10-05T03:38:33.059Z')
  })

  it('Walmart: the title is the heading and the date is the embedded createdAt', () => {
    const d = readDetail(fixture('walmart-job.html'), 'https://careers.walmart.com/us/en/jobs/R-2666785')
    expect(d.title).toBe('(USA) Merchandising Lead')
    expect(d.postedAt).toBe('2026-10-02T23:55:26.015Z')
  })

  it('Google: the page names the role, and has no date to give', () => {
    const d = readDetail(fixture('google-detail.html'), 'https://www.google.com/about/careers/applications/jobs/results/120374375760175814-senior-data-engineer-gtech-users-and-products')
    expect(d.title).toBe('Senior Data Engineer, gTech Users and Products')
    expect(d.postedAt).toBeUndefined()
  })

  it('collects the links on the page', () => {
    const d = readDetail(fixture('nyt-detail.html'), 'https://www.nytco.com/careers/job-listings/4721503005-art-director')
    expect(d.hrefs).toContain('https://job-boards.greenhouse.io/thenewyorktimes/jobs/4721503005#app')
  })
})

describe('jobFromDetail', () => {
  it('builds a role keyed by its own address, with the date and employer the page declared', () => {
    const url = 'https://www.metacareers.com/profile/job_details/1616812923224613/?utm_source=x'
    const job = jobFromDetail(url, readDetail(fixture('meta-job.html'), url))
    expect(job).toMatchObject({ employer: 'Meta', externalId: 'https://www.metacareers.com/profile/job_details/1616812923224613' })
  })

  it('refuses a page that does not name the role the listing promised (a redirect to somewhere generic)', () => {
    const url = 'https://www.google.com/about/careers/applications/jobs/results/1-x'
    const d = readDetail('<html><head><title>Careers</title></head><body><h1>Welcome</h1></body></html>', url)
    expect(jobFromDetail(url, d, { title: 'Senior Data Engineer' })).toBeNull()
  })
})
