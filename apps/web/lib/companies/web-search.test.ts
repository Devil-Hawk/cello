import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchCareersDomains } from './web-search'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

// A trimmed Tavily answer for "Retell AI careers": the employer, job sites, an applicant system, a page about it, a repeat.
const TAVILY = {
  query: 'Retell AI careers',
  results: [
    { title: 'Retell AI jobs | LinkedIn', url: 'https://www.linkedin.com/company/retellai/jobs', content: 'Jobs at Retell AI' },
    { title: 'Careers at Retell AI', url: 'https://www.retellai.com/careers', content: 'Open roles' },
    { title: 'Retell AI - Jobs', url: 'https://jobs.ashbyhq.com/retell-ai', content: 'Open roles' },
    { title: 'Retell AI - Wikipedia', url: 'https://en.wikipedia.org/wiki/Retell_AI', content: 'Retell AI is' },
    { title: 'Retell AI jobs', url: 'https://www.indeed.com/cmp/Retell-ai/jobs', content: 'Jobs' },
    { title: 'Blog', url: 'https://blog.retellai.com/hiring', content: 'We are hiring' },
    { title: 'Retell Labs careers', url: 'https://careers.retell-labs.co.uk/jobs', content: 'Roles' },
    { title: 'Retell on GitHub', url: 'https://github.com/retell', content: 'code' },
    { title: 'Retell Systems', url: 'https://retellsystems.io/join', content: 'Join' },
    { title: 'Retell Cars', url: 'https://retellcars.com/jobs', content: 'Join' },
  ],
}

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('searchCareersDomains', () => {
  it('asks Tavily for "<name> careers" and keeps the first three employer domains, without job sites, applicant systems or pages about the company', async () => {
    const fetchMock = vi.fn().mockResolvedValue(answer(TAVILY))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    expect(await searchCareersDomains('Retell AI', 'tvly-test')).toEqual(['retellai.com', 'retell-labs.co.uk', 'retellsystems.io'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://api.tavily.com/search')
    expect(JSON.parse(init.body).query).toBe('Retell AI careers')
    expect(init.headers.authorization).toBe('Bearer tvly-test')
  })

  it('asks nothing without a key: null, so the caller queues the search for the worker', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    expect(await searchCareersDomains('Retell AI', undefined)).toBeNull()
    expect(await searchCareersDomains('Retell AI', '')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never falls through to a search engine scrape: a failed Tavily search is null, and no other host is asked', async () => {
    const fetchMock = vi.fn().mockResolvedValue(answer({ error: 'bad key' }, 401))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    expect(await searchCareersDomains('Retell AI', 'tvly-bad')).toBeNull()
    for (const [url] of fetchMock.mock.calls) expect(String(url)).toContain('api.tavily.com')
  })
})
