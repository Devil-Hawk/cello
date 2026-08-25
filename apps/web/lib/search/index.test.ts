import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetSearchHealthState } from './health'
import { SearchHttpError } from './fetch'
import { DuckDuckGoBlockedError } from './backends/duckduckgo'

const getSearchProviderKeysMock = vi.fn()
const getSearxngBaseUrlMock = vi.fn()
vi.mock('./keys', () => ({
  getSearchProviderKeys: (...args: unknown[]) => getSearchProviderKeysMock(...args),
  getSearxngBaseUrl: (...args: unknown[]) => getSearxngBaseUrlMock(...args),
}))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({ marker: 'admin-client' }) }))

const {
  webSearch,
  classifyBackendFailure,
  describeAttempts,
  loadOptionalBackendFn,
} = await import('./index')

const realFetch = globalThis.fetch

beforeEach(() => {
  _resetSearchHealthState()
})

afterEach(() => {
  globalThis.fetch = realFetch
  getSearchProviderKeysMock.mockReset()
  getSearxngBaseUrlMock.mockReset()
  getSearchProviderKeysMock.mockResolvedValue({})
  getSearxngBaseUrlMock.mockResolvedValue(undefined)
  vi.restoreAllMocks()
})

const DDG_RESULTS_HTML = `
<div class="results">
  <div class="result results_links results_links_deep web-result">
    <div class="links_main links_deep result__body">
      <h2 class="result__title"><a class="result__a" href="https://boards.greenhouse.io/acme/jobs/1">AI Engineer</a></h2>
      <a class="result__snippet">Acme is hiring.</a>
    </div>
  </div>
</div>
`
const DDG_BLOCKED_HTML = `
<form id="challenge-form"><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div></form>
`
const DDG_EMPTY_HTML = `<div class="results"></div>`

function ddgResponse(html: string, status = 200) {
  return new Response(html, { status, headers: { 'content-type': 'text/html' } })
}

function exaResponse(status: number, body: unknown = { results: [] }) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('webSearch — basics', () => {
  it('rejects an empty/whitespace query without hitting the network', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await webSearch('   ')

    expect(res).toEqual({ backend: 'duckduckgo', results: [], ok: false, reason: 'empty_query', detail: 'query was empty' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('with nothing configured, succeeds via the keyless duckduckgo backend', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ddgResponse(DDG_RESULTS_HTML))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await webSearch('AI Engineer')

    expect(res.backend).toBe('duckduckgo')
    expect(res.ok).toBe(true)
    expect(res.results).toHaveLength(1)
    expect(res.attempts).toBeUndefined() // first candidate tried, first to succeed — stays lean
  })

  it('reports ok:true with reason:no_results for a genuine zero-match search', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ddgResponse(DDG_EMPTY_HTML))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await webSearch('an extremely specific query with no matches')

    expect(res).toMatchObject({ backend: 'duckduckgo', results: [], ok: true, reason: 'no_results' })
  })

  it('prefers exa over duckduckgo when an exa key is configured, and never calls duckduckgo', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('exa.ai')) {
        return exaResponse(200, { results: [{ title: 'AI Engineer', url: 'https://boards.greenhouse.io/acme/jobs/1' }] })
      }
      throw new Error('should not reach duckduckgo when exa succeeds first')
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await webSearch('AI Engineer', { exaKey: 'exa-test-key' })

    expect(res.backend).toBe('exa')
    expect(res.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('webSearch — chain fallthrough', () => {
  it('falls through a failing exa to the working duckduckgo backend, and reports the fallthrough in attempts', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('exa.ai')) return exaResponse(401)
      return ddgResponse(DDG_RESULTS_HTML)
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await webSearch('AI Engineer', { exaKey: 'bad-key' })

    expect(res.ok).toBe(true)
    expect(res.backend).toBe('duckduckgo')
    expect(res.attempts).toEqual([
      { backend: 'exa', ok: false, reason: 'request_failed', detail: expect.stringContaining('401') },
      { backend: 'duckduckgo', ok: true, reason: undefined },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('falls through a bot-blocked duckduckgo the same way when it is the one that fails', async () => {
    // exa never configured here — only duckduckgo is a real candidate, and it
    // fails: the chain must still report ok:false honestly rather than
    // fabricating a success, since nothing else exists to fall through to.
    const fetchMock = vi.fn().mockResolvedValue(ddgResponse(DDG_BLOCKED_HTML, 202))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await webSearch('remote software engineer')

    expect(res.ok).toBe(false)
    expect(res.reason).toBe('all_failed')
    expect(res.backend).toBe('duckduckgo')
  })

  it('reports reason:all_failed and names every backend tried when the whole chain fails', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('exa.ai')) return exaResponse(401)
      return ddgResponse(DDG_BLOCKED_HTML, 202)
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await webSearch('remote software engineer', { exaKey: 'bad-key' })

    expect(res.ok).toBe(false)
    expect(res.reason).toBe('all_failed')
    expect(res.results).toEqual([])
    expect(res.attempts).toHaveLength(5)
    expect(res.attempts).toEqual(
      expect.arrayContaining([
        { backend: 'tavily', ok: false, reason: 'no_key', detail: 'not configured' },
        { backend: 'serper', ok: false, reason: 'no_key', detail: 'not configured' },
        expect.objectContaining({ backend: 'exa', ok: false, reason: 'request_failed' }),
        { backend: 'searxng', ok: false, reason: 'no_key', detail: 'not configured' },
        expect.objectContaining({ backend: 'duckduckgo', ok: false, reason: 'blocked' }),
      ])
    )
    // Names what was tried AND gives an actionable next step — never a bare
    // "search failed".
    expect(res.detail).toContain('Tavily (not configured)')
    expect(res.detail).toContain('Exa (request_failed')
    expect(res.detail).toContain('DuckDuckGo (blocked')
    expect(res.detail).toMatch(/Tavily or Serper key|Settings/i)
  })

  it('never throws even when every backend errors', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(webSearch('remote software engineer')).resolves.toMatchObject({ ok: false, reason: 'all_failed' })
  })
})

describe('webSearch — malformed responses and abort/timeout never throw', () => {
  // These two modes previously relied on the shared try/catch in runChain()
  // being correct "by inspection" rather than a dedicated test — a res.json()
  // SyntaxError and a real AbortError are exercised explicitly here so the
  // "never throws" guarantee is verified for every failure mode, not just
  // bad-key/quota/blocked/missing-module.

  it('a malformed (non-JSON) 200 response body falls through to the next backend instead of throwing', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('exa.ai')) {
        // A 200 with a body that isn't valid JSON — res.json() throws a
        // SyntaxError inside backends/exa.ts, uncaught by that module itself.
        return new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return ddgResponse(DDG_RESULTS_HTML)
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await webSearch('AI Engineer', { exaKey: 'test-key' })

    expect(res.ok).toBe(true)
    expect(res.backend).toBe('duckduckgo')
    expect(res.attempts).toEqual([
      { backend: 'exa', ok: false, reason: 'request_failed', detail: expect.stringMatching(/json/i) },
      { backend: 'duckduckgo', ok: true, reason: undefined },
    ])
  })

  it('a malformed response from every configured backend still resolves ok:false, never throws', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(webSearch('remote software engineer', { exaKey: 'test-key', backend: 'exa' })).resolves.toMatchObject({
      ok: false,
      backend: 'exa',
      reason: 'request_failed',
    })
  })

  it('a real AbortError (per-request timeout) from one backend falls through instead of throwing', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('exa.ai')) {
        throw new DOMException('The operation was aborted', 'AbortError')
      }
      return ddgResponse(DDG_RESULTS_HTML)
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await webSearch('AI Engineer', { exaKey: 'test-key', timeoutMs: 50 })

    expect(res.ok).toBe(true)
    expect(res.backend).toBe('duckduckgo')
    expect(res.attempts?.[0]).toMatchObject({ backend: 'exa', ok: false })
  }, 15_000)

  it('the caller\'s own already-aborted signal never escapes webSearch as a throw', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: { signal?: AbortSignal }) => {
      if (init?.signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError')
      return exaResponse(200, { results: [] })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(
      webSearch('AI Engineer', { exaKey: 'test-key', signal: controller.signal })
    ).resolves.toMatchObject({ ok: false })
  })
})

describe('webSearch — health memory skip + recovery', () => {
  it('skips a backend that just failed in favor of the next call, without re-hitting it', async () => {
    // First call: exa fails, duckduckgo picks up the slack — exa's failure
    // is now remembered.
    const firstFetch = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('exa.ai')) return exaResponse(401)
      return ddgResponse(DDG_RESULTS_HTML)
    })
    globalThis.fetch = firstFetch as unknown as typeof fetch
    const first = await webSearch('AI Engineer', { exaKey: 'bad-key' })
    expect(first.ok).toBe(true)
    expect(first.backend).toBe('duckduckgo')

    // Second call, same process, same (still "bad") exa key: if the chain
    // tries exa again it will explode this mock — proving health memory
    // steered the chain past it entirely this time, straight to duckduckgo.
    const secondFetch = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('exa.ai')) throw new Error('TEST FAILURE: exa should have been skipped via health memory')
      return ddgResponse(DDG_RESULTS_HTML)
    })
    globalThis.fetch = secondFetch as unknown as typeof fetch
    const second = await webSearch('AI Engineer', { exaKey: 'bad-key' })

    expect(second.ok).toBe(true)
    expect(second.backend).toBe('duckduckgo')
    expect(secondFetch).toHaveBeenCalledTimes(1)
    expect(String(secondFetch.mock.calls[0][0])).not.toContain('exa.ai')
  })

  it('still tries a recently-failed backend as a last resort when nothing else is configured', async () => {
    // Only duckduckgo is ever a candidate here. Even after it's marked
    // recently-failed by a first call, a second call must still attempt it
    // for real — there is nothing else to fall back to, and returning
    // ok:false without even trying would be dishonest.
    const blockedFetch = vi.fn().mockResolvedValue(ddgResponse(DDG_BLOCKED_HTML, 202))
    globalThis.fetch = blockedFetch as unknown as typeof fetch
    const first = await webSearch('remote software engineer')
    expect(first.ok).toBe(false)

    const recoveredFetch = vi.fn().mockResolvedValue(ddgResponse(DDG_RESULTS_HTML))
    globalThis.fetch = recoveredFetch as unknown as typeof fetch
    const second = await webSearch('remote software engineer')

    expect(recoveredFetch).toHaveBeenCalledTimes(1)
    expect(second.ok).toBe(true)
    expect(second.backend).toBe('duckduckgo')
  })
})

describe('webSearch — credential resolution via userId', () => {
  it('resolves tavily/serper/exa from getSearchProviderKeys and searxng from getSearxngBaseUrl', async () => {
    getSearchProviderKeysMock.mockResolvedValue({ exa: undefined, tavily: 'tavily-secret', serper: undefined })
    getSearxngBaseUrlMock.mockResolvedValue(undefined)
    // tavily.ts is real in this repo — exercise it for real rather than
    // re-mocking its transport.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [{ title: 'AI Engineer', url: 'https://boards.greenhouse.io/acme/jobs/1' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await webSearch('AI Engineer', { userId: 'user-123' })

    expect(getSearchProviderKeysMock).toHaveBeenCalledWith({ marker: 'admin-client' }, 'user-123')
    expect(res.backend).toBe('tavily')
    expect(res.ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.tavily.com/search')
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe('Bearer tavily-secret')
  })

  it('falls all the way to duckduckgo when userId resolves to no keys at all', async () => {
    getSearchProviderKeysMock.mockResolvedValue({})
    getSearxngBaseUrlMock.mockResolvedValue(undefined)
    const fetchMock = vi.fn().mockResolvedValue(ddgResponse(DDG_RESULTS_HTML))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await webSearch('AI Engineer', { userId: 'user-no-keys' })

    expect(res.backend).toBe('duckduckgo')
    expect(res.ok).toBe(true)
  })

  it('a resolution failure (DB error) degrades to duckduckgo rather than throwing', async () => {
    getSearchProviderKeysMock.mockRejectedValue(new Error('db down'))
    const fetchMock = vi.fn().mockResolvedValue(ddgResponse(DDG_RESULTS_HTML))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await webSearch('AI Engineer', { userId: 'user-db-down' })

    expect(res.ok).toBe(true)
    expect(res.backend).toBe('duckduckgo')
  })

  it('a direct exaKey wins over DB resolution, skipping that field only', async () => {
    getSearchProviderKeysMock.mockResolvedValue({ exa: 'should-not-be-used', tavily: undefined, serper: undefined })
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('exa.ai')) {
        return exaResponse(200, { results: [] })
      }
      throw new Error('unexpected call')
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await webSearch('AI Engineer', { exaKey: 'direct-key', userId: 'user-123' })

    expect(res.ok).toBe(true)
    expect(res.backend).toBe('exa')
    const [, init] = fetchMock.mock.calls[0]
    expect((init as { headers: Record<string, string> }).headers['x-api-key']).toBe('direct-key')
  })
})

describe('webSearch — forced single-backend mode (opts.backend)', () => {
  it('reports no_key when the forced backend has no credential, never hitting the network', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await webSearch('AI Engineer', { backend: 'exa' })

    expect(res).toMatchObject({ backend: 'exa', ok: false, reason: 'no_key' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not fall through to another backend even if the forced one fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(exaResponse(401))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await webSearch('AI Engineer', { backend: 'exa', exaKey: 'bad-key' })

    expect(res).toMatchObject({ backend: 'exa', ok: false, reason: 'request_failed' })
    expect(fetchMock).toHaveBeenCalledTimes(1) // duckduckgo never attempted
  })
})

describe('classifyBackendFailure', () => {
  it('maps DuckDuckGoBlockedError to blocked', () => {
    expect(classifyBackendFailure(new DuckDuckGoBlockedError()).reason).toBe('blocked')
  })

  it('maps HTTP 402/432/433 to quota and 429 to rate_limited', () => {
    expect(classifyBackendFailure(new SearchHttpError('nope', 402)).reason).toBe('quota')
    expect(classifyBackendFailure(new SearchHttpError('nope', 432)).reason).toBe('quota')
    expect(classifyBackendFailure(new SearchHttpError('nope', 433)).reason).toBe('quota')
    expect(classifyBackendFailure(new SearchHttpError('nope', 429)).reason).toBe('rate_limited')
  })

  it('maps a permanent 4xx (e.g. 403) to request_failed', () => {
    expect(classifyBackendFailure(new SearchHttpError('forbidden', 403)).reason).toBe('request_failed')
  })

  it('maps a transient 5xx to rate_limited via the shared classifier', () => {
    expect(classifyBackendFailure(new SearchHttpError('down', 503)).reason).toBe('rate_limited')
  })

  it('recognizes blocked/quota by name or message even without the shared error classes', () => {
    expect(classifyBackendFailure(new Error('provider returned a CAPTCHA challenge')).reason).toBe('blocked')
    expect(classifyBackendFailure(new Error('monthly quota exceeded for this account')).reason).toBe('quota')
  })

  it('falls back to request_failed for an unrecognized error', () => {
    expect(classifyBackendFailure(new Error('totally unknown failure')).reason).toBe('request_failed')
  })
})

describe('describeAttempts', () => {
  it('suggests adding a Tavily/Serper key when nothing at all is configured', () => {
    const summary = describeAttempts([
      { backend: 'tavily', ok: false, reason: 'no_key', detail: 'not configured' },
      { backend: 'serper', ok: false, reason: 'no_key', detail: 'not configured' },
      { backend: 'exa', ok: false, reason: 'no_key', detail: 'not configured' },
      { backend: 'searxng', ok: false, reason: 'no_key', detail: 'not configured' },
      { backend: 'duckduckgo', ok: false, reason: 'blocked', detail: 'bot challenge' },
    ])
    expect(summary).toContain('DuckDuckGo (blocked: bot challenge)')
    expect(summary).toMatch(/Add a Tavily or Serper key/i)
  })

  it('suggests trying again shortly when a configured backend failed instead', () => {
    const summary = describeAttempts([
      { backend: 'tavily', ok: false, reason: 'quota', detail: 'monthly cap reached' },
      { backend: 'duckduckgo', ok: false, reason: 'blocked', detail: 'bot challenge' },
    ])
    expect(summary).toMatch(/try again shortly/i)
  })
})

describe('loadOptionalBackendFn', () => {
  // NOTE: these assert the module map resolves, which is necessary but NOT
  // sufficient to prove the backends ship. vitest resolves the relative TS
  // path natively through Node/Vite and will happily load a module that
  // webpack never bundled — that gap is exactly how the earlier non-literal
  // `import(modulePath)` version passed its tests while being dead in
  // production. The binding guard for that is lib/search/bundling.test.ts,
  // which reads the compiled output — not this file.
  it.each(['tavily', 'serper', 'searxng'] as const)(
    'returns a callable search function for the %s backend',
    async (id) => {
      const fn = await loadOptionalBackendFn(id)
      expect(typeof fn).toBe('function')
    }
  )

  it('resolves null rather than throwing for an id with no module mapping', async () => {
    type BackendIdArg = Parameters<typeof loadOptionalBackendFn>[0]
    const fn = await loadOptionalBackendFn('does-not-exist-xyz' as BackendIdArg)
    expect(fn).toBeNull()
  })
})
