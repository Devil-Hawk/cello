import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchJson, HttpError } from './http'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

describe('fetchJson retry parity (p-retry wired via lib/util/retry classifyError)', () => {
  it('a 429 then a 200 succeeds — one retry, both attempts hit fetch', async () => {
    const fetchMock = vi.fn()
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 429, statusText: 'Too Many Requests' }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await fetchJson<{ ok: boolean }>('https://example.com/jobs', {
      // Tiny backoff so the test doesn't wait out a real ~400ms delay.
      backoffBaseMs: 5,
      backoffCapMs: 10,
    })

    expect(result).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a 402 does NOT retry — fails on the first attempt, surfaced as HttpError', async () => {
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValue(new Response(null, { status: 402, statusText: 'Payment Required' }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(
      fetchJson('https://example.com/jobs', { backoffBaseMs: 5, backoffCapMs: 10 })
    ).rejects.toMatchObject({ status: 402 })
    await expect(
      fetchJson('https://example.com/jobs', { backoffBaseMs: 5, backoffCapMs: 10 })
    ).rejects.toBeInstanceOf(HttpError)

    // Two fetchJson() calls above, one fetch each — never a retry on 402.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('exhausts retries on a persistent 503 and throws the last HttpError', async () => {
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValue(new Response(null, { status: 503, statusText: 'Service Unavailable' }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(
      fetchJson('https://example.com/jobs', { retries: 2, backoffBaseMs: 5, backoffCapMs: 10 })
    ).rejects.toMatchObject({ status: 503 })

    // retries: 2 => 3 total attempts (1 first try + 2 retries).
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('a network-level TypeError ("fetch failed") retries and then succeeds', async () => {
    const fetchMock = vi.fn()
    fetchMock
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await fetchJson<{ ok: boolean }>('https://example.com/jobs', {
      backoffBaseMs: 5,
      backoffCapMs: 10,
    })

    expect(result).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('an already-aborted caller signal stops retrying immediately, never calling fetch', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const controller = new AbortController()
    controller.abort(new Error('user cancelled'))

    await expect(
      fetchJson('https://example.com/jobs', { signal: controller.signal })
    ).rejects.toThrow('user cancelled')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
