import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchSearxng } from './searxng'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

const SEARXNG_RESPONSE_BODY = {
  query: 'AI Engineer remote',
  results: [
    {
      title: 'AI Engineer - Acme Corp',
      url: 'https://boards.greenhouse.io/acme/jobs/123',
      content: 'Acme is hiring an AI Engineer to build our next-gen platform.',
      engine: 'google',
      publishedDate: '2026-07-20T00:00:00.000Z',
    },
    {
      // No title/content/publishedDate — exercise the fallback paths.
      url: 'https://jobs.lever.co/widgetco/ai-engineer',
      engine: 'bing',
    },
  ],
  answers: [],
  corrections: [],
  infoboxes: [],
  suggestions: [],
  unresponsive_engines: [],
}

describe('searchSearxng (mocked fetch)', () => {
  it('GETs {baseUrl}/search?q=...&format=json and normalizes the results', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(SEARXNG_RESPONSE_BODY), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const results = await searchSearxng('AI Engineer remote', 'https://searxng.example.com', { limit: 5 })

    expect(results).toEqual([
      {
        title: 'AI Engineer - Acme Corp',
        url: 'https://boards.greenhouse.io/acme/jobs/123',
        snippet: 'Acme is hiring an AI Engineer to build our next-gen platform.',
        publishedAt: '2026-07-20T00:00:00.000Z',
        source: 'boards.greenhouse.io',
      },
      {
        title: 'https://jobs.lever.co/widgetco/ai-engineer',
        url: 'https://jobs.lever.co/widgetco/ai-engineer',
        snippet: '',
        publishedAt: undefined,
        source: 'jobs.lever.co',
      },
    ])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://searxng.example.com/search?q=AI+Engineer+remote&format=json')
    expect(init.method).toBe('GET')
  })

  it('strips a trailing slash from a configured base URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await searchSearxng('AI Engineer', 'https://searxng.example.com/')

    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('https://searxng.example.com/search?q=AI+Engineer&format=json')
  })

  it('passes freshness through as time_range', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await searchSearxng('AI Engineer', 'https://searxng.example.com', { freshness: 'week' })

    const [url] = fetchMock.mock.calls[0]
    expect(url).toContain('time_range=week')
  })

  it('a 403 (json format not enabled on this instance) does not retry and rejects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 403, statusText: 'Forbidden' }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(searchSearxng('AI Engineer', 'https://searxng.example.com')).rejects.toMatchObject({ status: 403 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a 429 (rate limited) retries then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, statusText: 'Too Many Requests' }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const results = await searchSearxng('AI Engineer', 'https://searxng.example.com')

    expect(results).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a 500 (transient search-engine failure) retries then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 500, statusText: 'Internal Server Error' }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const results = await searchSearxng('AI Engineer', 'https://searxng.example.com')

    expect(results).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('respects the limit', async () => {
    const manyResults = Array.from({ length: 10 }, (_, i) => ({
      title: `Result ${i}`,
      url: `https://example.com/${i}`,
      content: 'x',
      engine: 'google',
    }))
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: manyResults }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const results = await searchSearxng('AI Engineer', 'https://searxng.example.com', { limit: 3 })
    expect(results).toHaveLength(3)
  })

  it('skips a result row with no usable url', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [{ title: 'No URL' }, ...SEARXNG_RESPONSE_BODY.results] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const results = await searchSearxng('AI Engineer', 'https://searxng.example.com')
    expect(results).toHaveLength(2)
    expect(results.every((r) => r.url)).toBe(true)
  })
})
