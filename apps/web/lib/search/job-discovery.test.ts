// Unit tests for lib/search/job-discovery.ts — the LAST rung of sourcer.ts's
// broaden-on-empty ladder. `@/lib/search` (webSearch) and `./keys`
// (getSearchProviderKeys / getSearxngBaseUrl) are both mocked, so this file
// makes ZERO real network calls and zero DB reads on its own; global `fetch`
// is mocked per-test to stand in for both the real ATS adapters' API calls
// (lib/ats/greenhouse|lever|ashby.ts, which this module reuses unmodified)
// and the generic liveness-check fetch.

import { afterEach, describe, expect, it, vi } from 'vitest'

const { webSearchMock, getSearchProviderKeysMock, getSearxngBaseUrlMock } = vi.hoisted(() => ({
  webSearchMock: vi.fn(),
  getSearchProviderKeysMock: vi.fn(),
  getSearxngBaseUrlMock: vi.fn(),
}))

vi.mock('@/lib/search', () => ({ webSearch: webSearchMock }))
vi.mock('./keys', () => ({
  getSearchProviderKeys: getSearchProviderKeysMock,
  getSearxngBaseUrl: getSearxngBaseUrlMock,
}))

import {
  ATS_SEARCH_SITES,
  buildSearchQueries,
  discoverJobsViaWebSearch,
  normalizeJobUrl,
  roleTermsForSearch,
} from './job-discovery'
import { getRoleIntent } from '../jobs/role-taxonomy'
import { EMPTY_TARGETING } from '../targeting'
import type { SearchResult, WebSearchResponse } from './types'

const aiEngineer = getRoleIntent('ai-engineer')!

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  webSearchMock.mockReset()
  getSearchProviderKeysMock.mockReset()
  getSearxngBaseUrlMock.mockReset()
})

function ok(results: SearchResult[], backend: WebSearchResponse['backend'] = 'duckduckgo'): WebSearchResponse {
  return { backend, results, ok: true }
}

function searchResult(overrides: Partial<SearchResult>): SearchResult {
  return {
    title: 'AI Engineer',
    url: 'https://example.com/job/1',
    snippet: 'We are hiring.',
    source: 'example.com',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// buildSearchQueries / roleTermsForSearch — pure, no I/O
// ---------------------------------------------------------------------------

describe('roleTermsForSearch', () => {
  it('uses the resolved intent\'s precise titleKeywords, never adjacentKeywords', () => {
    const terms = roleTermsForSearch(aiEngineer, undefined)
    expect(terms.length).toBeGreaterThan(0)
    for (const t of terms) expect(aiEngineer.titleKeywords).toContain(t)
    for (const t of terms) expect(aiEngineer.adjacentKeywords).not.toContain(t)
  })

  it('falls back to the raw query as a single term when no intent resolved', () => {
    expect(roleTermsForSearch(null, 'Staff Platform Engineer')).toEqual(['Staff Platform Engineer'])
  })

  it('is empty when there is truly nothing to search with', () => {
    expect(roleTermsForSearch(null, undefined)).toEqual([])
    expect(roleTermsForSearch(null, '   ')).toEqual([])
  })
})

describe('buildSearchQueries', () => {
  it('returns [] when there is no intent and no query — never an unscoped search', () => {
    expect(buildSearchQueries(null, undefined, EMPTY_TARGETING)).toEqual([])
  })

  it('builds one site:-scoped query per known ATS host, OR-joining quoted title terms', () => {
    const queries = buildSearchQueries(aiEngineer, undefined, EMPTY_TARGETING)
    expect(queries).toHaveLength(ATS_SEARCH_SITES.length)
    for (const site of ATS_SEARCH_SITES) {
      expect(queries.some((q) => q.startsWith(`site:${site} `))).toBe(true)
    }
    // Multi-word titleKeywords are quoted; the OR joiner is present.
    expect(queries[0]).toContain('"ai engineer"')
    expect(queries[0]).toContain(' OR ')
  })

  it('appends "remote" only when targeting.remoteOnly is set', () => {
    const plain = buildSearchQueries(aiEngineer, undefined, EMPTY_TARGETING)
    const remote = buildSearchQueries(aiEngineer, undefined, { ...EMPTY_TARGETING, remoteOnly: true })
    expect(plain[0].endsWith('remote')).toBe(false)
    expect(remote[0].endsWith('remote')).toBe(true)
  })

  it('does not try to translate ISO country codes into search text', () => {
    const withCountry = buildSearchQueries(aiEngineer, undefined, { ...EMPTY_TARGETING, countries: ['DE'] })
    expect(withCountry.join(' ')).not.toContain('DE')
  })
})

describe('normalizeJobUrl', () => {
  it('strips query string, hash, and a trailing slash so URL variants compare equal', () => {
    expect(normalizeJobUrl('https://boards.greenhouse.io/acme/jobs/1?gh_src=abc#frag')).toBe(
      'https://boards.greenhouse.io/acme/jobs/1'
    )
    expect(normalizeJobUrl('https://boards.greenhouse.io/acme/jobs/1/')).toBe('https://boards.greenhouse.io/acme/jobs/1')
  })

  it('degrades to the raw trimmed string for an unparsable URL rather than throwing', () => {
    expect(normalizeJobUrl('not a url')).toBe('not a url')
  })
})

// ---------------------------------------------------------------------------
// discoverJobsViaWebSearch — verification against real ATS adapters +
// generic liveness fallback, both via a mocked global fetch.
// ---------------------------------------------------------------------------

function greenhouseResponse(jobs: { absolute_url: string; title: string }[]) {
  return new Response(JSON.stringify({ jobs }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function leverResponse(postings: { hostedUrl: string; text: string }[]) {
  return new Response(JSON.stringify(postings), { status: 200, headers: { 'content-type': 'application/json' } })
}

function htmlResponse(html: string, status = 200) {
  return new Response(html, { status, headers: { 'content-type': 'text/html' } })
}

describe('discoverJobsViaWebSearch', () => {
  it('short-circuits with backend:none when there is nothing to search with', async () => {
    const res = await discoverJobsViaWebSearch({ intent: null, query: undefined, targeting: EMPTY_TARGETING, limit: 5 })
    expect(res).toMatchObject({ queries: [], hits: 0, leads: [], backend: 'none' })
    expect(webSearchMock).not.toHaveBeenCalled()
  })

  it('short-circuits when limit is already 0 — never calls webSearch', async () => {
    const res = await discoverJobsViaWebSearch({ intent: aiEngineer, targeting: EMPTY_TARGETING, limit: 0 })
    expect(res.leads).toEqual([])
    expect(webSearchMock).not.toHaveBeenCalled()
  })

  it('resolves an ATS-host hit through the REAL greenhouse adapter and tags it web_search', async () => {
    webSearchMock.mockImplementation(async (query: string) => {
      if (query.includes('job-boards.greenhouse.io')) {
        return ok([
          searchResult({
            title: 'AI Engineer at Nova Robotics',
            url: 'https://job-boards.greenhouse.io/novarobotics/jobs/999',
            source: 'job-boards.greenhouse.io',
          }),
        ])
      }
      return ok([])
    })
    globalThis.fetch = vi.fn(async () =>
      greenhouseResponse([{ absolute_url: 'https://job-boards.greenhouse.io/novarobotics/jobs/999', title: 'AI Engineer' }])
    ) as unknown as typeof fetch

    const res = await discoverJobsViaWebSearch({ intent: aiEngineer, targeting: EMPTY_TARGETING, limit: 5 })

    expect(res.atsVerified).toBe(1)
    expect(res.leads).toHaveLength(1)
    const [leadRow] = res.leads
    expect(leadRow.source).toBe('web_search')
    expect(leadRow.title).toBe('AI Engineer')
    expect(leadRow.url).toBe('https://job-boards.greenhouse.io/novarobotics/jobs/999')
    expect(leadRow.company).toBe('Nova Robotics') // parsed from "... at Nova Robotics"
    expect(leadRow.tags).toContain('ats:greenhouse')
    expect(res.notes).toContain('atsVerified=1')
  })

  it('DROPS a hit on a known ATS host whose job is no longer on that board (stale) — never retried via liveness', async () => {
    webSearchMock.mockResolvedValue(
      ok([searchResult({ url: 'https://boards.greenhouse.io/gone/jobs/1', source: 'boards.greenhouse.io' })])
    )
    const fetchMock = vi.fn(async () => greenhouseResponse([])) // board fetched, empty — the job isn't listed
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await discoverJobsViaWebSearch({ intent: aiEngineer, targeting: EMPTY_TARGETING, limit: 5 })

    expect(res.leads).toEqual([])
    expect(res.dropped).toBeGreaterThan(0)
    expect(res.atsVerified).toBe(0)
    // Exactly one fetch (the board lookup) — a stale ATS hit is never retried
    // via the looser generic liveness check.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('verifies a non-ATS hit via the generic liveness fetch (real title, no dead-posting phrasing)', async () => {
    webSearchMock.mockImplementation(async (query: string) => {
      if (query.includes('careers.novaco.example')) return ok([])
      return ok([
        searchResult({
          title: 'Machine Learning Engineer',
          url: 'https://careers.novaco.example/jobs/42',
          snippet: 'Join our team at Novaco.',
          source: 'careers.novaco.example',
        }),
      ])
    })
    globalThis.fetch = vi.fn(async () =>
      htmlResponse('<html><head><title>Machine Learning Engineer — Novaco Careers</title></head><body>Apply now.</body></html>')
    ) as unknown as typeof fetch

    const res = await discoverJobsViaWebSearch({ intent: aiEngineer, targeting: EMPTY_TARGETING, limit: 5 })

    expect(res.livenessVerified).toBe(1)
    expect(res.leads).toHaveLength(1)
    expect(res.leads[0].source).toBe('web_search')
    expect(res.leads[0].tags).toContain('unstructured')
  })

  it('DROPS a non-ATS hit whose page says the posting is no longer open', async () => {
    webSearchMock.mockResolvedValue(ok([searchResult({ url: 'https://careers.example.com/jobs/dead' })]))
    globalThis.fetch = vi.fn(async () =>
      htmlResponse('<html><head><title>Job Closed</title></head><body>This posting is no longer active.</body></html>')
    ) as unknown as typeof fetch

    const res = await discoverJobsViaWebSearch({ intent: aiEngineer, targeting: EMPTY_TARGETING, limit: 5 })
    expect(res.leads).toEqual([])
    expect(res.livenessVerified).toBe(0)
    expect(res.dropped).toBeGreaterThan(0)
  })

  it('DROPS a non-ATS hit that 404s', async () => {
    webSearchMock.mockResolvedValue(ok([searchResult({ url: 'https://careers.example.com/jobs/missing' })]))
    globalThis.fetch = vi.fn(async () => new Response('not found', { status: 404 })) as unknown as typeof fetch

    const res = await discoverJobsViaWebSearch({ intent: aiEngineer, targeting: EMPTY_TARGETING, limit: 5 })
    expect(res.leads).toEqual([])
    expect(res.dropped).toBe(1)
  })

  it('dedupes the same URL surfaced by more than one query', async () => {
    const dupe = searchResult({ url: 'https://boards.greenhouse.io/acme/jobs/1?utm=abc', source: 'boards.greenhouse.io' })
    webSearchMock.mockResolvedValue(ok([dupe]))
    const fetchMock = vi.fn(async () => greenhouseResponse([{ absolute_url: 'https://boards.greenhouse.io/acme/jobs/1', title: 'AI Engineer' }]))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await discoverJobsViaWebSearch({ intent: aiEngineer, targeting: EMPTY_TARGETING, limit: 5 })

    // 4 queries (one per ATS site) all return the SAME url — must collapse to one hit.
    expect(res.hits).toBe(1)
    expect(res.leads).toHaveLength(1)
  })

  it('stops verifying once `limit` leads are collected — bounded verification work', async () => {
    const hits = Array.from({ length: 6 }, (_, i) =>
      searchResult({ url: `https://boards.greenhouse.io/acme/jobs/${i}`, source: 'boards.greenhouse.io' })
    )
    webSearchMock.mockResolvedValueOnce(ok(hits)).mockResolvedValue(ok([]))
    // Every hit shares the SAME board token ("acme"), so the board is fetched
    // once and cached — build a board containing all 6 so each is verifiable.
    const fetchMock = vi.fn(async () =>
      greenhouseResponse(hits.map((_h, i) => ({ absolute_url: `https://boards.greenhouse.io/acme/jobs/${i}`, title: `Role ${i}` })))
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await discoverJobsViaWebSearch({ intent: aiEngineer, targeting: EMPTY_TARGETING, limit: 2 })

    expect(res.leads).toHaveLength(2)
    // One board fetch total (cached across the 6 hits sharing one token).
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('never throws when every webSearch call fails — degrades to an empty, explained result', async () => {
    webSearchMock.mockRejectedValue(new Error('network down'))
    const res = await discoverJobsViaWebSearch({ intent: aiEngineer, targeting: EMPTY_TARGETING, limit: 5 })
    expect(res.leads).toEqual([])
    expect(res.notes).toContain('queryErrors=')
  })

  it('reports a non-throwing DuckDuckGo "blocked" response honestly in notes', async () => {
    webSearchMock.mockResolvedValue({ backend: 'duckduckgo', results: [], ok: false, reason: 'blocked', detail: 'bot challenge' })
    const res = await discoverJobsViaWebSearch({ intent: aiEngineer, targeting: EMPTY_TARGETING, limit: 5 })
    expect(res.leads).toEqual([])
    expect(res.reason).toBe('blocked')
    expect(res.notes).toContain('reason=blocked')
  })

  it('resolves EVERY configured BYOK credential once via admin+userId and forwards all of them to every query', async () => {
    getSearchProviderKeysMock.mockResolvedValue({ exa: 'exa-secret', tavily: 'tavily-secret', serper: 'serper-secret' })
    getSearxngBaseUrlMock.mockResolvedValue('https://searx.example.com')
    webSearchMock.mockResolvedValue(ok([]))
    const fakeAdmin = {} as never

    await discoverJobsViaWebSearch({
      intent: aiEngineer,
      targeting: EMPTY_TARGETING,
      limit: 5,
      userId: 'user-1',
      admin: fakeAdmin,
    })

    // Resolved ONCE up front (not once per query) — see the comment in
    // job-discovery.ts's discoverJobsViaWebSearch.
    expect(getSearchProviderKeysMock).toHaveBeenCalledTimes(1)
    expect(getSearchProviderKeysMock).toHaveBeenCalledWith(fakeAdmin, 'user-1')
    expect(getSearxngBaseUrlMock).toHaveBeenCalledTimes(1)
    expect(getSearxngBaseUrlMock).toHaveBeenCalledWith(fakeAdmin, 'user-1')
    // Every configured backend — not just Exa — must reach webSearch() for
    // the failover chain (tavily -> serper -> exa -> searxng -> duckduckgo,
    // see lib/search/index.ts) to actually activate during automated job
    // discovery.
    expect(webSearchMock.mock.calls.length).toBeGreaterThan(0)
    for (const call of webSearchMock.mock.calls) {
      expect(call[1]).toMatchObject({
        exaKey: 'exa-secret',
        tavilyKey: 'tavily-secret',
        serperKey: 'serper-secret',
        searxngUrl: 'https://searx.example.com',
      })
    }
  })

  it('skips BYOK credential resolution entirely when userId/admin are absent (free DuckDuckGo path)', async () => {
    webSearchMock.mockResolvedValue(ok([]))
    await discoverJobsViaWebSearch({ intent: aiEngineer, targeting: EMPTY_TARGETING, limit: 5 })
    expect(getSearchProviderKeysMock).not.toHaveBeenCalled()
    expect(getSearxngBaseUrlMock).not.toHaveBeenCalled()
    for (const call of webSearchMock.mock.calls) {
      expect(call[1]).toMatchObject({ exaKey: undefined, tavilyKey: undefined, serperKey: undefined, searxngUrl: undefined })
    }
  })
})
