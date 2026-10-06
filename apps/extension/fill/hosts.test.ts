import { describe, expect, it } from 'vitest'
import type { AutoHost } from '../lib/fill-contract'
import { ATS_MATCHES, hostListed, isAtsHost, samePosting } from './hosts'

const hosts: AutoHost[] = [
  {
    host: 'job-boards.greenhouse.io',
    url_pattern: '^https://job-boards\\.greenhouse\\.io/(?<board>[^/]+)/jobs/(?<job>\\d+)',
    submit_labels: ['Submit application'],
    confirmation_patterns: [],
    confirmation_urls: [],
  },
]

describe('hosts', () => {
  it('matches only the three hosted-form families, with no port and no all-urls', () => {
    expect(ATS_MATCHES).toEqual([
      'https://boards.greenhouse.io/*',
      'https://job-boards.greenhouse.io/*',
      'https://jobs.lever.co/*',
      'https://jobs.ashbyhq.com/*',
    ])
    expect(isAtsHost('jobs.lever.co')).toBe(true)
    expect(isAtsHost('evil.example')).toBe(false)
  })

  it('names a posting by board and job, and refuses another job on the same board', () => {
    const a = 'https://job-boards.greenhouse.io/acme/jobs/4001?gh_src=x'
    expect(samePosting(a, 'https://job-boards.greenhouse.io/acme/jobs/4001', hosts)).toBe(true)
    expect(samePosting(a, 'https://job-boards.greenhouse.io/acme/jobs/4002', hosts)).toBe(false)
    expect(samePosting(a, 'https://job-boards.greenhouse.io/other/jobs/4001', hosts)).toBe(false)
  })

  it('refuses a host the server did not list and a non-https address', () => {
    expect(hostListed('https://jobs.lever.co/acme/1', hosts)).toBe(false)
    expect(hostListed('http://job-boards.greenhouse.io/acme/jobs/1', hosts)).toBe(false)
    expect(hostListed('not a url', hosts)).toBe(false)
    expect(hostListed('https://job-boards.greenhouse.io/acme/jobs/1', [])).toBe(false)
  })
})
