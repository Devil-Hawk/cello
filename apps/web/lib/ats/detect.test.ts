import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectFromUrl, probeAts } from './detect'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('detectFromUrl across every provider', () => {
  // One representative real board URL per provider, so a host pattern that
  // stops matching (or starts matching someone else's host) fails loudly.
  const cases: [string, string, string][] = [
    ['greenhouse', 'https://boards.greenhouse.io/stripe', 'stripe'],
    ['lever', 'https://jobs.lever.co/acme', 'acme'],
    ['ashby', 'https://jobs.ashbyhq.com/openai', 'openai'],
    ['workday', 'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite', 'nvidia.wd5.NVIDIAExternalCareerSite'],
    ['smartrecruiters', 'https://jobs.smartrecruiters.com/Sodexo', 'Sodexo'],
    ['workable', 'https://apply.workable.com/amazingcarecareers/', 'amazingcarecareers'],
    ['recruitee', 'https://hygraph.recruitee.com/', 'hygraph'],
    ['personio', 'https://open.jobs.personio.de/', 'open'],
  ]

  it.each(cases)('routes a %s board URL to that provider', (provider, careerUrl, token) => {
    expect(detectFromUrl({ careerUrl, domain: null })).toEqual({ provider, token })
  })

  it('returns null for a branded careers page no adapter owns', () => {
    expect(detectFromUrl({ careerUrl: 'https://acme.com/careers', domain: 'acme.com' })).toBeNull()
  })
})

describe('probeAts', () => {
  /** Answer every probe with a miss except the one URL that should hit. */
  function mockProbes(hitUrlFragment: string, hitBody: unknown) {
    const urls: string[] = []
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(url)
      if (url.includes(hitUrlFragment)) return jsonResponse(hitBody)
      return new Response('not found', { status: 404, statusText: 'Not Found' })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    return urls
  }

  it('probes in the documented order: greenhouse, then ashby before lever', async () => {
    const urls = mockProbes('__never__', {})
    await probeAts({ domain: 'acme.com', name: 'Acme' })

    const providerOf = (url: string) =>
      url.includes('greenhouse') ? 'greenhouse'
      : url.includes('ashbyhq') ? 'ashby'
      : url.includes('lever') ? 'lever'
      : url.includes('workable') ? 'workable'
      : url.includes('recruitee') ? 'recruitee'
      : url.includes('smartrecruiters') ? 'smartrecruiters'
      : url.includes('personio') ? 'personio'
      : 'other'

    // First contact with each provider, in order.
    const firstTouch: string[] = []
    for (const url of urls) {
      const id = providerOf(url)
      if (!firstTouch.includes(id)) firstTouch.push(id)
    }
    expect(firstTouch).toEqual([
      'greenhouse',
      'ashby',
      'lever',
      'workable',
      'recruitee',
      'smartrecruiters',
      'personio',
    ])
  })

  it('never probes workday — its token cannot be derived from a company name', async () => {
    const urls = mockProbes('__never__', {})
    await probeAts({ domain: 'nvidia.com', name: 'NVIDIA' })
    expect(urls.some((u) => u.includes('myworkdayjobs.com'))).toBe(false)
  })

  it('stops at the first provider returning a job and reuses its payload', async () => {
    const urls = mockProbes('apply.workable.com', {
      jobs: [{ title: 'Staff Engineer', url: 'https://apply.workable.com/j/ABCD1234', published_on: '2026-07-01' }],
    })

    const detected = await probeAts({ domain: 'acme.com', name: 'Acme' })

    expect(detected).toMatchObject({ provider: 'workable', token: 'acme', source: 'probe' })
    expect(detected?.jobs).toHaveLength(1)
    expect(detected?.jobs?.[0].externalId).toBe('https://apply.workable.com/j/ABCD1234')
    // Nothing after workable in PROBE_ORDER was touched.
    expect(urls.some((u) => u.includes('recruitee') || u.includes('smartrecruiters') || u.includes('personio'))).toBe(
      false
    )
  })

  it('returns null (never throws) when nothing matches', async () => {
    mockProbes('__never__', {})
    await expect(probeAts({ domain: 'acme.com', name: 'Acme' })).resolves.toBeNull()
  })
})
