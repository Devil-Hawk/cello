import { describe, expect, it } from 'vitest'
import { CELLO_USER_AGENT } from '../../ats/http'
import { makeSiteFetcher, ReaderError, type SiteFetcherOptions } from './site-fetch'

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>

function harness(routes: Record<string, Handler | Response>, opts: SiteFetcherOptions = {}) {
  const calls: { url: string; at: number; headers: Record<string, string> }[] = []
  let clock = 1_000_000
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, at: clock, headers: (init.headers ?? {}) as Record<string, string> })
    const hit = routes[url] ?? routes[new URL(url).origin + '/*']
    if (!hit) return new Response('not found', { status: 404 })
    return typeof hit === 'function' ? hit(url, init) : hit.clone()
  }) as unknown as typeof fetch
  const fetcher = makeSiteFetcher({
    fetchImpl,
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
    assertSafe: async () => {},
    ...opts,
  })
  return { fetcher, calls }
}

const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html' } })
const robots = (txt: string, status = 200) => new Response(txt, { status })

describe('site fetcher: robots.txt', () => {
  it('does not request a page its robots.txt disallows', async () => {
    const { fetcher, calls } = harness({
      'https://acme.test/robots.txt': robots('User-agent: *\nDisallow: /careers\n'),
      'https://acme.test/careers': html('<p>hi</p>'),
    })
    await expect(fetcher.get('https://acme.test/careers')).rejects.toMatchObject({ reason: 'robots' })
    expect(calls.map((c) => c.url)).toEqual(['https://acme.test/robots.txt'])
  })

  it('obeys a rule written for Cello by name', async () => {
    const { fetcher } = harness({
      'https://acme.test/robots.txt': robots('User-agent: cello-job-tracker\nDisallow: /\n'),
      'https://acme.test/jobs': html('<p>hi</p>'),
    })
    await expect(fetcher.get('https://acme.test/jobs')).rejects.toMatchObject({ reason: 'robots' })
  })

  it('allows everything when robots.txt is a 404, and disallows everything when it answers 503', async () => {
    const ok = harness({ 'https://acme.test/robots.txt': robots('nf', 404), 'https://acme.test/jobs': html('<p>hi</p>') })
    expect((await ok.fetcher.get('https://acme.test/jobs')).text).toContain('hi')
    const down = harness({ 'https://acme.test/robots.txt': robots('down', 503), 'https://acme.test/jobs': html('<p>hi</p>') })
    await expect(down.fetcher.get('https://acme.test/jobs')).rejects.toMatchObject({ reason: 'robots' })
  })

  it('reads robots.txt once per origin and lists its sitemaps', async () => {
    const { fetcher, calls } = harness({
      'https://acme.test/robots.txt': robots('User-agent: *\nAllow: /\nSitemap: https://acme.test/jobs-sitemap.xml\n'),
      'https://acme.test/a': html('a'),
      'https://acme.test/b': html('b'),
    })
    await fetcher.get('https://acme.test/a')
    await fetcher.get('https://acme.test/b')
    expect(calls.filter((c) => c.url.endsWith('/robots.txt'))).toHaveLength(1)
    expect(await fetcher.sitemapsOf('https://acme.test')).toEqual(['https://acme.test/jobs-sitemap.xml'])
  })
})

describe('site fetcher: identity, pace and budget', () => {
  it('sends the Cello user agent, which names the repository, and never a browser', async () => {
    const { fetcher, calls } = harness({ 'https://acme.test/robots.txt': robots('', 404), 'https://acme.test/': html('x') })
    await fetcher.get('https://acme.test/')
    for (const c of calls) {
      expect(c.headers['user-agent']).toBe(CELLO_USER_AGENT)
    }
    expect(CELLO_USER_AGENT).toContain('github.com/Devil-Hawk/cello')
    expect(CELLO_USER_AGENT).not.toContain('Mozilla')
  })

  it('keeps requests to one host at least 300 ms apart inline, 1 s apart when scheduled', async () => {
    for (const [mode, gap] of [['inline', 300], ['scheduled', 1000]] as const) {
      const { fetcher, calls } = harness({ 'https://acme.test/robots.txt': robots('', 404), 'https://acme.test/*': html('x') }, { mode })
      await fetcher.get('https://acme.test/a')
      await fetcher.get('https://acme.test/b')
      await fetcher.get('https://acme.test/c')
      for (let i = 1; i < calls.length; i++) expect(calls[i].at - calls[i - 1].at).toBeGreaterThanOrEqual(gap)
    }
  })

  it('stops with a budget error on the 26th inline request', async () => {
    const { fetcher } = harness({ 'https://acme.test/robots.txt': robots('', 404) }, { budget: { gapMs: 0 } })
    // robots.txt took one request; 24 pages bring it to 25.
    for (let i = 0; i < 24; i++) await fetcher.get(`https://acme.test/p${i}`)
    expect(fetcher.spent().requests).toBe(25)
    await expect(fetcher.get('https://acme.test/p25')).rejects.toBeInstanceOf(ReaderError)
    await expect(fetcher.get('https://acme.test/p25')).rejects.toMatchObject({ reason: 'budget' })
  })

  it('stops when the byte budget is spent', async () => {
    const { fetcher } = harness({ 'https://acme.test/robots.txt': robots('', 404), 'https://acme.test/*': html('x'.repeat(2000)) }, { budget: { bytes: 3000, gapMs: 0 } })
    await fetcher.get('https://acme.test/a')
    await fetcher.get('https://acme.test/b')
    await expect(fetcher.get('https://acme.test/c')).rejects.toMatchObject({ reason: 'budget' })
  })
})

describe('site fetcher: when a site cannot be read', () => {
  const open = { 'https://acme.test/robots.txt': robots('', 404) }

  it('a Cloudflare challenge is a bot check', async () => {
    const { fetcher } = harness({ ...open, 'https://acme.test/jobs': html('<title>Just a moment...</title><div id="cf-chl-opt"></div>', 403) })
    await expect(fetcher.get('https://acme.test/jobs')).rejects.toMatchObject({ reason: 'bot_check' })
  })

  it('a 401 and a redirect to a login page both need a login', async () => {
    const a = harness({ ...open, 'https://acme.test/jobs': html('no', 401) })
    await expect(a.fetcher.get('https://acme.test/jobs')).rejects.toMatchObject({ reason: 'login_required' })
    const b = harness({
      ...open,
      'https://acme.test/jobs': new Response(null, { status: 302, headers: { location: '/login?next=/jobs' } }),
    })
    await expect(b.fetcher.get('https://acme.test/jobs')).rejects.toMatchObject({ reason: 'login_required' })
  })

  it('a network failure is unreachable, a 404 is a plain answer', async () => {
    const down = harness({ ...open, 'https://acme.test/jobs': () => Promise.reject(new TypeError('fetch failed')) })
    await expect(down.fetcher.get('https://acme.test/jobs')).rejects.toMatchObject({ reason: 'unreachable' })
    const gone = harness({ ...open, 'https://acme.test/jobs/1': html('gone', 404) })
    expect((await gone.fetcher.get('https://acme.test/jobs/1')).status).toBe(404)
  })

  it('follows a redirect by hand, checking robots on the new host, and reports where it ended', async () => {
    const { fetcher } = harness({
      'https://acme.test/robots.txt': robots('', 404),
      'https://boards.test/robots.txt': robots('User-agent: *\nDisallow: /private\n'),
      'https://acme.test/jobs': new Response(null, { status: 301, headers: { location: 'https://boards.test/acme' } }),
      'https://boards.test/acme': html('<p>board</p>'),
    })
    const res = await fetcher.get('https://acme.test/jobs')
    expect(res.finalUrl).toBe('https://boards.test/acme')
    expect(await fetcher.redirectOf('https://acme.test/jobs')).toBe('https://boards.test/acme')
    expect(await fetcher.allowed('https://boards.test/private')).toBe(false)
  })
})
