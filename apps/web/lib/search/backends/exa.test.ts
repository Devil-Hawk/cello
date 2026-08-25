import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchExa } from './exa'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

const EXA_RESPONSE_BODY = {
  requestId: 'req_123',
  results: [
    {
      title: 'AI Engineer - Acme Corp',
      url: 'https://boards.greenhouse.io/acme/jobs/123',
      publishedDate: '2026-07-20T00:00:00.000Z',
      author: null,
      id: 'abc',
      text: 'Acme is hiring an AI Engineer to build our next-gen platform.',
    },
    {
      // No title/text — exercise the fallback paths.
      url: 'https://jobs.lever.co/widgetco/ai-engineer',
    },
  ],
}

describe('searchExa (mocked fetch)', () => {
  it('sends the api key + query and normalizes the results', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(EXA_RESPONSE_BODY), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const results = await searchExa('AI Engineer remote', 'exa-test-key', { limit: 5 })

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
    expect(url).toBe('https://api.exa.ai/search')
    expect(init.headers['x-api-key']).toBe('exa-test-key')
    const body = JSON.parse(init.body)
    expect(body.query).toBe('AI Engineer remote')
    expect(body.numResults).toBe(5)
  })

  it('a 401 (bad key) does not retry and rejects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401, statusText: 'Unauthorized' }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(searchExa('AI Engineer', 'bad-key')).rejects.toMatchObject({ status: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a 429 retries then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, statusText: 'Too Many Requests' }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const results = await searchExa('AI Engineer', 'exa-test-key')

    expect(results).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('skips a result row with no usable url', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [{ title: 'No URL' }, ...EXA_RESPONSE_BODY.results] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const results = await searchExa('AI Engineer', 'exa-test-key')
    expect(results).toHaveLength(2)
    expect(results.every((r) => r.url)).toBe(true)
  })
})
