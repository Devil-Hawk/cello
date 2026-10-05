// The careers page and the homepage are read through the site fetcher: robots.txt applies.

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../security/untrusted', async (orig) => ({
  ...(await orig<typeof import('../security/untrusted')>()),
  assertSsrfSafe: async () => {},
}))

import { fetchCareersHtml } from './careers-page'
import { findPageBoards } from './detect'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

const PAGE = '<a href="https://boards.greenhouse.io/acmehq">Roles</a>'

function site(robots: string) {
  const urls: string[] = []
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    urls.push(url)
    if (url.endsWith('/robots.txt')) return new Response(robots, { status: 200, headers: { 'content-type': 'text/plain' } })
    expect((init?.headers as Record<string, string>)['user-agent']).toContain('github.com/Devil-Hawk/cello')
    return new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } })
  }) as unknown as typeof fetch
  return urls
}

describe('careers page reads obey robots.txt', () => {
  it('does not fetch a careers page robots.txt disallows', async () => {
    const urls = site('User-agent: *\nDisallow: /careers')
    await expect(fetchCareersHtml('https://acme.io/careers', 'acme.io')).resolves.toBeNull()
    expect(urls).toEqual(['https://acme.io/robots.txt'])
  })

  it('reads an allowed page, as Cello', async () => {
    const urls = site('User-agent: *\nDisallow: /private')
    await expect(fetchCareersHtml('https://acme.io/careers', 'acme.io')).resolves.toContain('greenhouse')
    expect(urls).toEqual(['https://acme.io/robots.txt', 'https://acme.io/careers'])
  })

  it('findPageBoards skips both the careers page and the homepage when robots.txt disallows them', async () => {
    const urls = site('User-agent: *\nDisallow: /')
    await expect(findPageBoards({ careerUrl: 'https://acme.io/careers', domain: 'acme.io' })).resolves.toEqual([])
    expect(urls).toEqual(['https://acme.io/robots.txt'])
  })

  it('findPageBoards asks robots.txt once for the two pages of one site', async () => {
    const urls = site('User-agent: *\nDisallow: /private')
    const boards = await findPageBoards({ careerUrl: 'https://acme.io/careers', domain: 'acme.io' })
    expect(boards).toEqual([{ provider: 'greenhouse', token: 'acmehq' }])
    expect(urls.filter((u) => u.endsWith('/robots.txt'))).toHaveLength(1)
  })

  it('does not follow a redirect off the company site', async () => {
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/robots.txt')) return new Response('', { status: 404 })
      return new Response('', { status: 302, headers: { location: 'https://elsewhere.example/jobs' } })
    }) as unknown as typeof fetch
    await expect(fetchCareersHtml('https://acme.io/careers', 'acme.io')).resolves.toBeNull()
  })
})
