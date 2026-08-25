import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchSerper } from './serper'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

const SERPER_RESPONSE_BODY = {
  searchParameters: { q: 'AI Engineer remote', type: 'search' },
  organic: [
    {
      title: 'AI Engineer - Acme Corp',
      link: 'https://boards.greenhouse.io/acme/jobs/123',
      snippet: 'Acme is hiring an AI Engineer to build our next-gen platform.',
      position: 1,
    },
    {
      // No title/snippet — exercise the fallback paths.
      link: 'https://jobs.lever.co/widgetco/ai-engineer',
      position: 2,
    },
  ],
  credits: 1,
}

describe('searchSerper (mocked fetch)', () => {
  it('sends the api key header + query and normalizes organic results', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(SERPER_RESPONSE_BODY), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const results = await searchSerper('AI Engineer remote', 'serper-test-key', { limit: 5 })

    expect(results).toEqual([
      {
        title: 'AI Engineer - Acme Corp',
        url: 'https://boards.greenhouse.io/acme/jobs/123',
        snippet: 'Acme is hiring an AI Engineer to build our next-gen platform.',
        source: 'boards.greenhouse.io',
      },
      {
        title: 'https://jobs.lever.co/widgetco/ai-engineer',
        url: 'https://jobs.lever.co/widgetco/ai-engineer',
        snippet: '',
        source: 'jobs.lever.co',
      },
    ])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://google.serper.dev/search')
    expect(init.headers['x-api-key']).toBe('serper-test-key')
    const body = JSON.parse(init.body)
    expect(body.q).toBe('AI Engineer remote')
    expect(body.num).toBe(5)
  })

  it('maps freshness onto the tbs=qdr: date-restrict param', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ organic: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await searchSerper('AI Engineer', 'serper-test-key', { freshness: 'week' })

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body).tbs).toBe('qdr:w')
  })

  it('a 403 (bad/missing key, or exhausted credits) does not retry and rejects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 403, statusText: 'Forbidden' }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(searchSerper('AI Engineer', 'bad-key')).rejects.toMatchObject({ status: 403 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a 429 (rate limited) retries then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, statusText: 'Too Many Requests' }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ organic: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const results = await searchSerper('AI Engineer', 'serper-test-key')

    expect(results).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a 503 (server error) retries then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503, statusText: 'Service Unavailable' }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ organic: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const results = await searchSerper('AI Engineer', 'serper-test-key')

    expect(results).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('skips a result row with no usable link', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ organic: [{ title: 'No link' }, ...SERPER_RESPONSE_BODY.organic] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const results = await searchSerper('AI Engineer', 'serper-test-key')
    expect(results).toHaveLength(2)
    expect(results.every((r) => r.url)).toBe(true)
  })

  it('never sets publishedAt even when Serper reports a non-ISO date string', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ organic: [{ title: 'Old post', link: 'https://example.com/x', date: '3 days ago' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const results = await searchSerper('AI Engineer', 'serper-test-key')
    expect(results[0].publishedAt).toBeUndefined()
  })
})
