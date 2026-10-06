import { describe, expect, it, vi } from 'vitest'
import type { AtsJob } from '../../ats/types'
import { eightfold } from '../../ats/eightfold'
import { fakeFetcher, fixture, type Route } from './fake-fetcher'
import { readSite, type SiteDeps } from './index'
import { amazonJobs } from './sites'
import { NO_TARGETS, type ReaderTargets } from './targets'

vi.mock('../../security/untrusted', async (orig) => ({
  ...(await orig<typeof import('../../security/untrusted')>()),
  assertSsrfSafe: async () => {},
}))

const targets: ReaderTargets = {
  targeting: { ...NO_TARGETS.targeting, functions: ['engineering', 'data'], seniority: ['junior', 'mid'] },
  titles: [],
}
const company = (name: string, domain: string, careerUrl: string) => ({ company: { name, domain, careerUrl }, targets })

const notCalled = (what: string) => vi.fn(async () => {
  throw new Error(`${what} must not be called`)
})

/** A board reader that returns what the Eightfold fixture says, as the verified adapter would. */
const eightfoldBoard: SiteDeps['readBoard'] = async (c) => {
  if (c.provider !== 'eightfold') return null
  const real = globalThis.fetch
  const file = c.token.includes('netflix') ? 'netflix-v2.json' : 'ms-pcsx.json'
  globalThis.fetch = (async (u: unknown) => {
    const url = String(u)
    // Microsoft answers the pcsx search and refuses v2; Netflix is the reverse.
    if (url.includes('/api/apply/v2/jobs?') && file === 'ms-pcsx.json') return new Response('no', { status: 403 })
    if (url.includes('/api/pcsx/search') && file === 'netflix-v2.json') return new Response('no', { status: 403 })
    if (url.includes('/api/apply/v2/jobs?') || url.includes('/api/pcsx/search')) return new Response(fixture(file))
    return new Response('{}')
  }) as typeof fetch
  try {
    const jobs: AtsJob[] = await eightfold.fetch(c.token, { query: ['data'], hasDescription: () => true })
    return { provider: 'eightfold', token: c.token, via: c.via, jobs, verifiedBy: 'careers_page_link' }
  } finally {
    globalThis.fetch = real
  }
}

/** A role page with the body of a posting added at the end: a title, then what the role asks for. */
const withLanguage = (html: string, title: string) =>
  html.replace(/<\/body>(?![\s\S]*<\/body>)/, `<section><h1>${title}</h1><h2>Responsibilities</h2><p>You will build and ship data pipelines for the team, work with partners across the business and own your projects from design to launch. Minimum qualifications: 3 years of experience with distributed systems and a degree or equivalent practical experience.</p></section></body>`)

describe('readSite: each of the big employers resolves to its tier, with no model and no browser', () => {
  it('Amazon: the site search', async () => {
    const f = fakeFetcher({ 'https://www.amazon.jobs/en/search.json*': fixture('amazon-search.json') })
    const model = notCalled('the model')
    const fetchPage = notCalled('the rendered fetch')
    const read = await readSite(company('Amazon', 'amazon.com', 'https://www.amazon.jobs/en/search'), { fetcher: f, model, fetchPage })
    expect(read.tier).toBe('site_search')
    expect(read.jobs.length).toBe(5)
    expect(read.reason).toBeNull()
    expect(model).not.toHaveBeenCalled()
    expect(fetchPage).not.toHaveBeenCalled()
  })

  it('Meta: the sitemap and each page JobPosting', async () => {
    const routes: Record<string, Route> = {
      'https://www.metacareers.com/robots.txt': fixture('meta-robots.txt'),
      'https://www.metacareers.com/jobs/': '<html><body><div id="root"></div></body></html>',
      'https://www.metacareers.com/jobsearch/sitemap.xml': fixture('meta-sitemap.xml'),
    }
    for (const m of fixture('meta-sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)) routes[m[1]] = fixture('meta-job.html')
    const f = fakeFetcher(routes)
    const read = await readSite(company('Meta', 'meta.com', 'https://www.metacareers.com/jobs/'), { fetcher: f })
    expect(read.tier).toBe('sitemap')
    expect(read.jobs.length).toBe(10)
    expect(read.jobs[0].employer).toBe('Meta')
    expect(read.listedIds).toHaveLength(50)
    expect(read.checked).toHaveLength(10)
    expect(read.complete).toBe(true)
  })

  it('Apple: a server-rendered listing, each role confirmed on its page', async () => {
    const first = 'https://jobs.apple.com/en-us/details/200684990-3956/front-end-web-accessibility-engineer-retail-engineering?team=SFTWR'
    const f = fakeFetcher({
      'https://jobs.apple.com/en-us/search': fixture('apple-search.html'),
      'https://jobs.apple.com/en-us/search?sort=newest&location=united-states-USA': fixture('apple-search.html'),
      [first]: withLanguage(fixture('apple-detail.html'), 'Front End Web Accessibility Engineer, Retail Engineering'),
    })
    const read = await readSite(company('Apple', 'apple.com', 'https://jobs.apple.com/en-us/search'), { fetcher: f })
    expect(read.tier).toBe('listing')
    expect(read.jobs.map((j) => j.title)).toContain('Front End Web Accessibility Engineer, Retail Engineering')
    expect(read.complete).toBe(false)
  })

  it('Google: a server-rendered search, one page only', async () => {
    const q = 'https://www.google.com/about/careers/applications/jobs/results?q=data%20engineer&location=United%20States'
    const first = 'https://www.google.com/about/careers/applications/jobs/results/120374375760175814-senior-data-engineer-gtech-users-and-products?q=data+engineer&location=United+States'
    const f = fakeFetcher({ 'https://www.google.com/robots.txt': fixture('google-robots.txt'), [q]: fixture('google-search.html'), [first]: fixture('google-detail.html') })
    const read = await readSite(
      { company: { name: 'Google', domain: 'google.com', careerUrl: 'https://www.google.com/about/careers/applications/jobs/results/' }, targets: { ...targets, titles: ['data engineer'] } },
      { fetcher: f }
    )
    expect(read.tier).toBe('listing')
    expect(read.tried.find((t) => t.tier === 'listing')?.outcome).toBe('roles')
    expect(f.calls.some((c) => /[?&]page=/.test(c))).toBe(false)
  })

  it('Netflix: a board through the company page config (Eightfold)', async () => {
    const f = fakeFetcher({ 'https://explore.jobs.netflix.net/careers': fixture('netflix-careers.html') })
    const read = await readSite(company('Netflix', 'netflix.com', 'https://explore.jobs.netflix.net/careers'), { fetcher: f, readBoard: eightfoldBoard })
    expect(read.tier).toBe('board')
    expect(read.board).toMatchObject({ provider: 'eightfold', token: 'explore.jobs.netflix.net_netflix.com', via: 'eightfold' })
    expect(read.jobs.length).toBeGreaterThan(0)
  })

  it('Microsoft: the old careers address redirects to the Eightfold site', async () => {
    const f = fakeFetcher({
      'https://jobs.careers.microsoft.com/global/en/search': { location: 'https://apply.careers.microsoft.com/careers' },
      'https://apply.careers.microsoft.com/careers': fixture('ms-careers.html'),
    })
    const read = await readSite(company('Microsoft', 'microsoft.com', 'https://jobs.careers.microsoft.com/global/en/search'), { fetcher: f, readBoard: eightfoldBoard })
    expect(read.tier).toBe('board')
    expect(read.board?.token).toBe('apply.careers.microsoft.com_microsoft.com')
  })
})

describe('readSite: any link a person pastes', () => {
  it('a single pasted Meta posting becomes one role', async () => {
    const url = 'https://www.metacareers.com/profile/job_details/1616812923224613/'
    const f = fakeFetcher({ [url]: fixture('meta-job.html') })
    const read = await readSite(company('Meta', 'meta.com', url), { fetcher: f })
    expect(read.single).toBe(true)
    expect(read.jobs).toHaveLength(1)
    expect(read.jobs[0]).toMatchObject({ employer: 'Meta', title: 'ASIC Validation Engineer, Network Validation & Characterization' })
  })

  it('a single pasted board posting reads the whole board', async () => {
    const readBoard = vi.fn(async (c: { provider: string; token: string; via: string }) => ({
      provider: 'greenhouse' as const,
      token: c.token,
      via: 'url' as const,
      jobs: [{ title: 'Data Engineer', url: 'https://x.test/1', externalId: 'https://x.test/1' }],
    }))
    const f = fakeFetcher({})
    const read = await readSite(company('Acme', 'acme.com', 'https://job-boards.greenhouse.io/acme/jobs/4567890'), { fetcher: f, readBoard })
    expect(read.tier).toBe('board')
    expect(readBoard).toHaveBeenCalledWith({ provider: 'greenhouse', token: 'acme', via: 'url' }, expect.any(Array))
    expect(f.calls).toEqual([])
  })

  it('a posting page that links its applicant board upgrades to that board', async () => {
    const url = 'https://www.nytco.com/careers/job-listings/4721503005-art-director'
    const readBoard = vi.fn(async (c: { provider: string; token: string }) => ({
      provider: 'greenhouse' as const,
      token: c.token,
      via: 'posting' as const,
      jobs: [{ title: 'Art Director', url: 'https://x.test/1', externalId: 'https://x.test/1' }],
    }))
    const read = await readSite(company('The New York Times', 'nytco.com', url), { fetcher: fakeFetcher({ [url]: fixture('nyt-detail.html') }), readBoard })
    expect(read.tier).toBe('board')
    expect(read.board?.token).toBe('thenewyorktimes')
  })

  it('a posting from a staffing agency is labelled, never returned as the employer role', async () => {
    const url = 'https://acme.test/jobs/12345678'
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      title: 'Data Engineer',
      hiringOrganization: { name: 'Robert Half' },
      datePosted: '2026-10-01',
    })}</script></head></html>`
    const read = await readSite(company('Acme', 'acme.com', url), { fetcher: fakeFetcher({ [url]: html }) })
    expect(read.jobs).toEqual([])
    expect(read.message).toBe('This posting is from Robert Half, a staffing agency, not Acme.')
  })
})

describe('readSite: a link on a reposting site is not the employer\'s careers site', () => {
  it('a listing on builtin.com is not read, nothing is requested, and the person is told why', async () => {
    const url = 'https://builtin.com/company/acme/jobs'
    const jobs = [1, 2, 3, 4].map((n) => `<a href="/job/acme/${n}0000${n}">Data Engineer ${n}</a>`).join('')
    const f = fakeFetcher({ [url]: `<html><body>${jobs}</body></html>` })
    const read = await readSite(company('Acme', 'acme.com', url), { fetcher: f })
    expect(read).toMatchObject({ tier: null, jobs: [], reason: 'no_roles', message: "This link is on builtin.com, a reposting site, not Acme's own careers site." })
    expect(f.calls).toEqual([])
  })

  it('a pasted LinkedIn posting is labelled as a posting on a reposting site', async () => {
    const read = await readSite(company('Acme', 'acme.com', 'https://www.linkedin.com/jobs/view/123456'), { fetcher: fakeFetcher({}) })
    expect(read.jobs).toEqual([])
    expect(read.message).toBe("This posting is on linkedin.com, a reposting site, not Acme's own careers site.")
  })

  it('a sitemap on a reposting host stores nothing either', async () => {
    const url = 'https://builtin.com/company/acme/jobs'
    const f = fakeFetcher({
      'https://builtin.com/robots.txt': 'Sitemap: https://builtin.com/sitemap.xml',
      'https://builtin.com/sitemap.xml': '<urlset><url><loc>https://builtin.com/job/acme/123456</loc></url></urlset>',
    })
    const read = await readSite(company('Acme', 'acme.com', url), { fetcher: f })
    expect(read.jobs).toEqual([])
    expect(read.message).toContain('reposting site')
  })
})

describe('readSite: could not read, with the reason', () => {
  const careers = 'https://jobs.uber.com/'
  const read = (routes: Record<string, Route>) => readSite(company('Uber', 'uber.com', careers), { fetcher: fakeFetcher(routes), renderedLater: true })

  it('a Cloudflare challenge is a bot check', async () => {
    const r = await read({ [careers]: { error: 'bot_check' } })
    expect(r).toMatchObject({ tier: null, jobs: [], reason: 'bot_check' })
  })

  it('a login wall needs a login', async () => {
    expect((await read({ [careers]: { error: 'login_required' } })).reason).toBe('login_required')
  })

  it('a site whose robots.txt disallows the page is not read', async () => {
    const r = await read({ 'https://jobs.uber.com/robots.txt': 'User-agent: *\nDisallow: /\n', [careers]: '<p>roles</p>' })
    expect(r).toMatchObject({ jobs: [], reason: 'robots' })
  })

  it('a page with nothing to read is "reading" while a browser pass is still to come, and no roles once it is not', async () => {
    const prose = `<html><body><p>${'We are a company that cares about people. '.repeat(40)}</p></body></html>`
    expect((await read({ [careers]: prose })).reason).toBe('reading')
    expect((await readSite(company('Uber', 'uber.com', careers), { fetcher: fakeFetcher({ [careers]: prose }) })).reason).toBe('no_roles')
    const shell = '<html><body><div id="root"></div><script src="/app.js"></script></body></html>'
    expect((await read({ [careers]: shell })).reason).toBe('reading')
  })

  it('scheduled, a shell is rendered and its JobPosting data read; inline never calls the browser', async () => {
    const shell = '<html><body><div id="root"></div></body></html>'
    const rendered = `<html><body><div id="root"><h1>Jobs</h1>${'<p>text</p>'.repeat(60)}<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      title: 'Data Engineer',
      url: 'https://uber.test/jobs/1',
      datePosted: '2026-10-01',
    })}</script></div></body></html>`
    const fetchPage = vi.fn(async (url: string) => ({ html: rendered, finalUrl: url, rendered: true }))
    const sched = await readSite(company('Uber', 'uber.com', careers), { fetcher: fakeFetcher({ [careers]: shell }, 'scheduled'), fetchPage, model: null })
    expect(sched.tier).toBe('rendered')
    expect(sched.jobs.map((j) => j.title)).toEqual(['Data Engineer'])

    fetchPage.mockClear()
    const inline = await readSite(company('Uber', 'uber.com', careers), { fetcher: fakeFetcher({ [careers]: shell }, 'inline'), fetchPage, model: null, renderedLater: true })
    expect(fetchPage).not.toHaveBeenCalled()
    expect(inline.reason).toBe('reading')
  })
})

describe('the rendered tier meets a bot check', () => {
  it('a browser that was handed a challenge page says bot_check, not that there are no roles', async () => {
    const careers = 'https://uber.test/careers'
    const shell = '<html><body><div id="root"></div></body></html>'
    const fetchPage = vi.fn(async (url: string) => ({ html: fixture('uber-challenge.html'), finalUrl: url, rendered: true }))
    const read = await readSite(company('Uber', 'uber.com', careers), { fetcher: fakeFetcher({ [careers]: shell }, 'scheduled'), fetchPage, model: null })
    expect(read.jobs).toEqual([])
    expect(read.reason).toBe('bot_check')
  })
})

describe('amazon fixture sanity', () => {
  it('has roles for the site search to return', () => {
    expect(amazonJobs(JSON.parse(fixture('amazon-search.json')))).toHaveLength(5)
  })
})
