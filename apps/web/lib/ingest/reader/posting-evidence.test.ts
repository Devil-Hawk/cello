// A role needs evidence that its page is a posting, not only a title that matches
// the link. Recorded from careersearch.stanford.edu (Oracle HCM): the home page
// links "School of Engineering" and its sibling departments with the same path
// shape as a role list, and each department page's own title matches its link.

import { describe, expect, it, vi } from 'vitest'
import { fakeFetcher, fixture } from './fake-fetcher'
import { isPostingPage, jobFromDetail, readDetail } from './detail'
import { roleLinks, readListing } from './listing'
import { readSite } from './index'
import { NO_TARGETS } from './targets'

vi.mock('../../security/untrusted', async (orig) => ({
  ...(await orig<typeof import('../../security/untrusted')>()),
  assertSsrfSafe: async () => {},
}))

const HOME = 'https://careersearch.stanford.edu/hcmUI/CandidateExperience/en/sites/stanford/'
const careers = 'https://careersearch.stanford.edu/'

describe('a department page is not a posting', () => {
  const home = fixture('oracle-hcm-home.html')
  const department = fixture('oracle-hcm-department.html')
  const links = roleLinks(home, HOME)

  it('the home page lists its departments as if they were roles', () => {
    expect(links.length).toBeGreaterThanOrEqual(3)
    expect(links.some((l) => l.title === 'School of Engineering')).toBe(true)
  })

  it('the department page has a title that matches its link and no evidence of being a role', () => {
    const detail = readDetail(department, 'https://careersearch.stanford.edu/hcmUI/CandidateExperience/en/sites/Stanford/pages/27010')
    expect(detail.title).toContain('School of Engineering')
    expect(isPostingPage(detail)).toBe(false)
    expect(jobFromDetail('https://x.test/pages/27010', detail, { title: 'School of Engineering' }, { requirePosting: true })).toBeNull()
    // Without the rule the page would have been taken for a role.
    expect(jobFromDetail('https://x.test/pages/27010', detail, { title: 'School of Engineering' })).not.toBeNull()
  })

  it('readListing stores none of them', async () => {
    const routes: Record<string, string> = {}
    for (const l of links) routes[l.url] = department
    const read = await readListing(careers, [{ url: HOME, html: home }], fakeFetcher(routes), { targets: NO_TARGETS, max: 20 })
    expect(read.listed).toBeGreaterThanOrEqual(3)
    expect(read.jobs).toEqual([])
  })

  it('the rendered tier ends as "could not read", not as one open role', async () => {
    const routes: Record<string, string> = {}
    for (const l of links) routes[l.url] = department
    const fetchPage = vi.fn(async () => ({ html: home, finalUrl: HOME, rendered: true }))
    const read = await readSite(
      { company: { name: 'Stanford University', domain: 'stanford.edu', careerUrl: careers }, targets: NO_TARGETS },
      { fetcher: fakeFetcher({ ...routes, [careers]: '<html><body></body></html>' }, 'scheduled'), fetchPage, model: null }
    )
    expect(read.jobs).toEqual([])
    expect(read.reason).toBeTruthy()
  })
})

describe('what counts as a posting', () => {
  const page = (body: string) => `<html><head><title>Data Engineer</title></head><body><h1>Data Engineer</h1>${body}</body></html>`
  const terms = '<p>Responsibilities: you will build pipelines. Qualifications: five years of experience.</p>'

  it('a declared JobPosting is enough', () => {
    const html = '<html><head><script type="application/ld+json">{"@type":"JobPosting","title":"Data Engineer","description":"x"}</script></head></html>'
    expect(isPostingPage(readDetail(html, 'https://a.test/jobs/1'))).toBe(true)
  })

  it('job language alone is one piece of evidence, with a date it is two', () => {
    expect(isPostingPage(readDetail(page(terms), 'https://a.test/jobs/1'))).toBe(false)
    expect(isPostingPage(readDetail(page(`<time datetime="2026-09-20">Sep 20</time>${terms}`), 'https://a.test/jobs/1'))).toBe(true)
  })

  it('a place from the card the link sat in counts', () => {
    expect(isPostingPage(readDetail(page(terms), 'https://a.test/jobs/1'), { location: 'Berlin' })).toBe(true)
  })
})
