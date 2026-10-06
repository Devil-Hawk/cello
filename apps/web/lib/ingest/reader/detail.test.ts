import { describe, expect, it } from 'vitest'
import { isPostingPage, jobFromDetail, readDetail } from './detail'
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

  it('Apple: the embedded page data gives the place, the summary, the description and the qualifications', () => {
    const url = 'https://jobs.apple.com/en-us/details/200679684-0157/ios-engineer-cloud-media-and-collaboration'
    const d = readDetail(fixture('apple-detail-embedded.html'), url)
    expect(d.title).toBe('iOS Engineer: Cloud Media and Collaboration')
    expect(d.location).toBe('Austin, Texas, United States')
    expect(d.postedAt).toBe('2026-10-05T17:36:32.310Z')
    expect(d.description).toContain('What if the media management infrastructure')
    expect(d.description).toContain('Minimum Qualifications')
    expect(d.description).toContain('3+ years shipping production code on Apple platforms')
    expect(d.description).toContain('Preferred Qualifications')
    const job = jobFromDetail(url, d, { title: 'iOS Engineer: Cloud Media and Collaboration' })
    expect(job).toMatchObject({ location: 'Austin, Texas, United States' })
    expect((job?.description ?? '').length).toBeGreaterThan(500)
  })

  it('Walmart: the page data (__NEXT_DATA__) gives the store, the text and the qualifications', () => {
    const url = 'https://careers.walmart.com/us/en/jobs/R-2666783'
    const d = readDetail(fixture('walmart-job-data.html'), url)
    expect(d.title).toBe('(USA) Overnight Stocking Coach, Non-Complex')
    expect(d.location).toBe('ZANESVILLE, OH, United States')
    expect(d.postedAt).toBe('2026-10-02T23:47:00.285Z')
    expect(d.description).toContain('Minimum Qualifications')
    expect(d.description).toContain('retail experience')
    expect(d.description).toContain('Preferred Qualifications')
    expect((d.description ?? '').length).toBeGreaterThan(800)
  })

  it('a page whose data names another role does not lend it its place or text', () => {
    const html = '<html><head><title>Data Engineer - Jobs - Careers at Acme</title></head><body><script type="application/json">{"job":{"title":"Chef de Cuisine","description":"Lead the kitchen of our flagship restaurant for many years to come.","locations":[{"name":"Paris","countryName":"France"}]}}</script></body></html>'
    const d = readDetail(html, 'https://acme.test/jobs/1')
    expect(d.title).toBe('Data Engineer')
    expect(d.location).toBeUndefined()
    expect(d.description ?? '').not.toContain('kitchen')
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

  it("UMich: a role page's fact panel in its sidebar gives the reference, the place and the posting window", () => {
    const d = readDetail(fixture('umich-job.html'), 'https://careers.umich.edu/job_detail/282948/atlas-platform-developer')
    expect(d.title).toBe('Atlas Platform Developer')
    expect(d.requisitionId).toBe('282948')
    expect(d.location).toBe('Ann Arbor Campus / Ann Arbor, MI')
    expect(d.postedAt?.slice(0, 10)).toBe('2026-09-13')
    expect(d.validThrough?.slice(0, 10)).toBe('2026-10-13')
    expect(isPostingPage(d)).toBe(true)
  })

  it("Google: a pasted role page's place beside its place icon", () => {
    const d = readDetail(fixture('google-role.html'), 'https://www.google.com/about/careers/applications/jobs/results/94350111848440518-senior-software-engineer-infrastructure-platforms-infrastructure-engineering')
    expect(d.location).toBe('Sunnyvale, CA, USA')
  })

  it('a department page is still not a posting', () => {
    expect(isPostingPage(readDetail(fixture('oracle-hcm-department.html'), 'https://acme.test/careers/department'))).toBe(false)
  })
})
