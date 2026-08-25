import { afterEach, describe, expect, it, vi } from 'vitest'
import { DuckDuckGoBlockedError, parseDuckDuckGoHtml, searchDuckDuckGo } from './duckduckgo'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

// Mirrors DuckDuckGo's live HTML results markup (a.result__a for the
// title/href, .result__snippet for the blurb, the /l/?uddg= redirect
// wrapper) — one organic result whose href needs unwrapping, one already
// carrying a plain absolute href, and one sponsored slot that must be
// filtered out.
const RESULTS_HTML = `
<!DOCTYPE html>
<html>
<body>
  <div class="results">
    <div class="result results_links results_links_deep web-result">
      <div class="links_main links_deep result__body">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fboards.greenhouse.io%2Facme%2Fjobs%2F123&amp;rut=abc">
            AI Engineer - Acme Corp
          </a>
        </h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fboards.greenhouse.io%2Facme%2Fjobs%2F123">
          Acme is hiring an <b>AI Engineer</b> to build our next-gen platform...
        </a>
      </div>
    </div>
    <div class="result results_links results_links_deep web-result">
      <div class="links_main links_deep result__body">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a" href="https://jobs.lever.co/widgetco/ai-engineer">
            Senior AI Engineer at WidgetCo
          </a>
        </h2>
        <a class="result__snippet">WidgetCo is looking for a Senior AI Engineer...</a>
      </div>
    </div>
    <div class="result results_links results_links_deep result--ad">
      <div class="links_main links_deep result__body">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a" href="https://sponsored-jobs.example.com/ai-engineer">Sponsored: Hire AI Engineers Fast</a>
        </h2>
        <a class="result__snippet">Sponsored listing — not an organic match.</a>
      </div>
    </div>
  </div>
</body>
</html>
`

// A trimmed but faithful reproduction of DuckDuckGo's live bot-verification
// challenge page, captured while building this backend — every request from
// the build sandbox's egress IP got this instead of results.
const BLOCKED_HTML = `
<!DOCTYPE html>
<html>
<body>
  <form id="challenge-form" action="//duckduckgo.com/anomaly.js?sv=html" method="POST">
    <div class="anomaly-modal__mask">
      <div class="anomaly-modal__modal" data-testid="anomaly-modal">
        <div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>
        <div class="anomaly-modal__description">Please complete the following challenge to confirm this search was made by a human.</div>
      </div>
    </div>
  </form>
</body>
</html>
`

const NO_RESULTS_HTML = `
<!DOCTYPE html>
<html>
<body>
  <div class="results">
    <div class="no-results">No results.</div>
  </div>
</body>
</html>
`

describe('parseDuckDuckGoHtml', () => {
  it('extracts organic results, unwraps the /l/?uddg= redirect, and skips the sponsored slot', () => {
    const results = parseDuckDuckGoHtml(RESULTS_HTML, 10)

    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      title: 'AI Engineer - Acme Corp',
      url: 'https://boards.greenhouse.io/acme/jobs/123',
      snippet: 'Acme is hiring an AI Engineer to build our next-gen platform...',
      source: 'boards.greenhouse.io',
    })
    expect(results[1]).toMatchObject({
      title: 'Senior AI Engineer at WidgetCo',
      url: 'https://jobs.lever.co/widgetco/ai-engineer',
      source: 'jobs.lever.co',
    })
    expect(results.some((r) => r.url.includes('sponsored-jobs.example.com'))).toBe(false)
  })

  it('respects the limit', () => {
    expect(parseDuckDuckGoHtml(RESULTS_HTML, 1)).toHaveLength(1)
  })

  it('returns an empty array for a genuine zero-match page (not blocked)', () => {
    expect(parseDuckDuckGoHtml(NO_RESULTS_HTML, 10)).toEqual([])
  })

  it('throws DuckDuckGoBlockedError for the bot-verification challenge page', () => {
    expect(() => parseDuckDuckGoHtml(BLOCKED_HTML, 10)).toThrow(DuckDuckGoBlockedError)
  })
})

describe('searchDuckDuckGo (mocked fetch)', () => {
  it('POSTs the query and returns parsed results on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(RESULTS_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const results = await searchDuckDuckGo('site:boards.greenhouse.io "AI Engineer"', { limit: 5 })

    expect(results).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://html.duckduckgo.com/html/')
    expect(init.method).toBe('POST')
    expect(String(init.body)).toContain('AI+Engineer')
  })

  it('surfaces DuckDuckGoBlockedError when every attempt is challenged, without endless retrying', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(BLOCKED_HTML, { status: 202, headers: { 'content-type': 'text/html' } }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(searchDuckDuckGo('remote software engineer')).rejects.toBeInstanceOf(DuckDuckGoBlockedError)
    // A 202 is a successful HTTP status (not 429/5xx), so the shared transient
    // classifier never fires a retry here — exactly one fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries a 429 then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, statusText: 'Too Many Requests' }))
      .mockResolvedValueOnce(new Response(RESULTS_HTML, { status: 200, headers: { 'content-type': 'text/html' } }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const results = await searchDuckDuckGo('remote software engineer')

    expect(results).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
