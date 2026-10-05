import { describe, expect, it } from 'vitest'
import { classifyLink, discoverBoards } from './discover'
import { fakeFetcher, fixture } from './fake-fetcher'

describe('discoverBoards: only through the company own site', () => {
  it('Zynga: the careers URL redirects to its Greenhouse board', async () => {
    const f = fakeFetcher({ 'https://www.zynga.com/jobs/job-openings/': { location: 'https://job-boards.greenhouse.io/zyngacareers' } })
    const d = await discoverBoards({ domain: 'zynga.com', careerUrl: 'https://www.zynga.com/jobs/job-openings/' }, f)
    expect(d.boards).toEqual([{ provider: 'greenhouse', token: 'zyngacareers', via: 'redirect' }])
    // The board's own page was never fetched: the redirect said enough.
    expect(f.calls).toEqual(['redirect:https://www.zynga.com/jobs/job-openings/'])
  })

  it('does not chase a Greenhouse job-id link to its board: that redirect lives under /embed/, which robots.txt disallows', async () => {
    const f = fakeFetcher({
      'https://www.digitalocean.com/careers': '<html><body><a href="/careers/position/apply?gh_jid=8212263">Role</a></body></html>',
      'https://boards.greenhouse.io/robots.txt': 'User-agent: *\nDisallow: /embed/\n',
      'https://boards.greenhouse.io/embed/job_app?token=8212263': { location: 'https://job-boards.greenhouse.io/embed/job_app?for=digitalocean98&token=8212263' },
    })
    const d = await discoverBoards({ domain: 'digitalocean.com', careerUrl: 'https://www.digitalocean.com/careers' }, f)
    expect(d.boards).toEqual([])
    expect(f.calls.some((c) => c.includes('boards.greenhouse.io'))).toBe(false)
  })

  it('Netflix and Microsoft: the page config names an Eightfold board for the company domain', async () => {
    const nf = await discoverBoards(
      { domain: 'netflix.com', careerUrl: 'https://explore.jobs.netflix.net/careers' },
      fakeFetcher({ 'https://explore.jobs.netflix.net/careers': fixture('netflix-careers.html') })
    )
    expect(nf.boards).toEqual([{ provider: 'eightfold', token: 'explore.jobs.netflix.net_netflix.com', via: 'eightfold' }])
    const ms = await discoverBoards(
      { domain: 'microsoft.com', careerUrl: 'https://apply.careers.microsoft.com/careers' },
      fakeFetcher({ 'https://apply.careers.microsoft.com/careers': fixture('ms-careers.html') })
    )
    expect(ms.boards).toEqual([{ provider: 'eightfold', token: 'apply.careers.microsoft.com_microsoft.com', via: 'eightfold' }])
  })

  it('a company added by its careers address (domain explore.jobs.netflix.net) still finds the board its page names', async () => {
    const d = await discoverBoards(
      { domain: 'explore.jobs.netflix.net', careerUrl: 'https://explore.jobs.netflix.net/careers' },
      fakeFetcher({ 'https://explore.jobs.netflix.net/careers': fixture('netflix-careers.html') })
    )
    expect(d.boards).toEqual([{ provider: 'eightfold', token: 'explore.jobs.netflix.net_netflix.com', via: 'eightfold' }])
  })

  it('an Eightfold page whose domain is not the company domain gives nothing', async () => {
    const d = await discoverBoards(
      { domain: 'someoneelse.com', careerUrl: 'https://explore.jobs.netflix.net/careers' },
      fakeFetcher({ 'https://explore.jobs.netflix.net/careers': fixture('netflix-careers.html') })
    )
    expect(d.boards).toEqual([])
  })

  it('a posting page on the company site that links its Greenhouse job upgrades to that board', async () => {
    const d = await discoverBoards(
      { domain: 'nytco.com', careerUrl: 'https://www.nytco.com/careers/job-listings/4721503005-art-director' },
      fakeFetcher({ 'https://www.nytco.com/careers/job-listings/4721503005-art-director': fixture('nyt-detail.html') })
    )
    expect(d.boards).toEqual([{ provider: 'greenhouse', token: 'thenewyorktimes', via: 'link' }])
  })

  it('follows at most two job-looking pages of the same site, never another site', async () => {
    const f = fakeFetcher({
      'https://acme.test/': '<a href="/careers">Careers</a><a href="https://other.test/careers">Other</a><a href="/jobs">Jobs</a><a href="/open-positions">Open</a><a href="/role-x">x</a>',
      'https://acme.test/careers': '<p>nothing</p>',
      'https://acme.test/jobs': '<a href="https://boards.greenhouse.io/acmeco">Apply</a>',
      'https://acme.test/open-positions': '<p>late</p>',
    })
    const d = await discoverBoards({ domain: 'acme.test', careerUrl: 'https://acme.test/' }, f)
    expect(d.boards).toEqual([{ provider: 'greenhouse', token: 'acmeco', via: 'link' }])
    expect(f.calls).not.toContain('https://other.test/careers')
    expect(f.calls).not.toContain('https://acme.test/open-positions')
  })

  it('reports why the careers page could not be read', async () => {
    const d = await discoverBoards({ domain: 'uber.com', careerUrl: 'https://jobs.uber.com/' }, fakeFetcher({ 'https://jobs.uber.com/': { error: 'bot_check' } }))
    expect(d.boards).toEqual([])
    expect(d.failure?.reason).toBe('bot_check')
  })
})

describe('classifyLink', () => {
  it('tells a board, a single posting, a search and a careers home apart', () => {
    expect(classifyLink('https://job-boards.greenhouse.io/acme/jobs/4567890')).toBe('board')
    expect(classifyLink('https://www.metacareers.com/profile/job_details/1616812923224613/')).toBe('posting')
    expect(classifyLink('https://jobs.apple.com/en-us/details/200684990-3956/front-end-engineer')).toBe('posting')
    expect(classifyLink('https://www.amazon.jobs/en/search?base_query=data')).toBe('search')
    expect(classifyLink('https://stripe.com/jobs')).toBe('careers')
  })
})
