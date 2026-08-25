import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchTavily } from './tavily'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

const TAVILY_RESPONSE_BODY = {
  query: 'AI Engineer remote',
  results: [
    {
      title: 'AI Engineer - Acme Corp',
      url: 'https://boards.greenhouse.io/acme/jobs/123',
      content: 'Acme is hiring an AI Engineer to build our next-gen platform.',
      score: 0.91,
      published_date: '2026-07-20T00:00:00.000Z',
    },
    {
      // No title/content/published_date — exercise the fallback paths.
      url: 'https://jobs.lever.co/widgetco/ai-engineer',
    },
  ],
  response_time: 0.42,
  request_id: 'req_123',
}

describe('searchTavily (mocked fetch)', () => {
  it('sends the bearer token + query and normalizes the results', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(TAVILY_RESPONSE_BODY), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const results = await searchTavily('AI Engineer remote', 'tvly-test-key', { limit: 5 })

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
    expect(url).toBe('https://api.tavily.com/search')
    // Auth is a header, never a body field — Tavily's live docs are explicit
    // that `api_key` in the body is not how the current API authenticates.
    expect(init.headers.authorization).toBe('Bearer tvly-test-key')
    const body = JSON.parse(init.body)
    expect(body.query).toBe('AI Engineer remote')
    expect(body.max_results).toBe(5)
    expect(body.api_key).toBeUndefined()
  })

  it('clamps max_results to Tavily\'s own 20-result ceiling even when a larger limit is requested', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await searchTavily('AI Engineer', 'tvly-test-key', { limit: 999 })

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body).max_results).toBe(20)
  })

  it('passes freshness through as time_range', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await searchTavily('AI Engineer', 'tvly-test-key', { freshness: 'week' })

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body).time_range).toBe('week')
  })

  it('a 401 (bad key) does not retry and rejects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401, statusText: 'Unauthorized' }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(searchTavily('AI Engineer', 'bad-key')).rejects.toMatchObject({ status: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a 432 (plan usage limit exceeded) does not retry and rejects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 432, statusText: 'Forbidden' }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(searchTavily('AI Engineer', 'tvly-test-key')).rejects.toMatchObject({ status: 432 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a 433 (pay-as-you-go limit exceeded) does not retry and rejects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 433, statusText: 'Forbidden' }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(searchTavily('AI Engineer', 'tvly-test-key')).rejects.toMatchObject({ status: 433 })
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

    const results = await searchTavily('AI Engineer', 'tvly-test-key')

    expect(results).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a 500 (server error) retries then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 500, statusText: 'Internal Server Error' }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const results = await searchTavily('AI Engineer', 'tvly-test-key')

    expect(results).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('skips a result row with no usable url', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [{ title: 'No URL' }, ...TAVILY_RESPONSE_BODY.results] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const results = await searchTavily('AI Engineer', 'tvly-test-key')
    expect(results).toHaveLength(2)
    expect(results.every((r) => r.url)).toBe(true)
  })
})
