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

  it('skips a first hit nothing ties to the company, and takes the next board that verifies', async () => {
    const recent = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const urls: string[] = []
    globalThis.fetch = vi.fn(async (url: string) => {
      urls.push(url)
      // Greenhouse answers with a namesake: jobs, but nothing points at acme.com.
      if (url.includes('boards-api.greenhouse.io/v1/boards/acme/jobs')) {
        return jsonResponse({ jobs: [{ absolute_url: 'https://boards.greenhouse.io/other/jobs/1', title: 'Chef', first_published: recent }] })
      }
      // Workable's board links to the company's own domain.
      if (url.includes('apply.workable.com') && url.includes('acme')) {
        return jsonResponse({ jobs: [{ title: 'Staff Engineer', url: 'https://acme.com/careers/ABCD1234', published_on: recent }] })
      }
      return new Response('not found', { status: 404, statusText: 'Not Found' })
    }) as unknown as typeof fetch

    const detected = await probeAts({ domain: 'acme.com', name: 'Acme' })

    expect(detected).toMatchObject({ provider: 'workable', token: 'acme', source: 'probe', verifiedBy: 'board_links_home' })
    expect(detected?.jobs).toHaveLength(1)
    expect(detected?.jobs?.[0].externalId).toBe('https://acme.com/careers/ABCD1234')
    // Nothing after workable in PROBE_ORDER was touched.
    expect(urls.some((u) => u.includes('recruitee') || u.includes('smartrecruiters') || u.includes('personio'))).toBe(false)
  })

  it('returns null (never throws) when nothing matches', async () => {
    mockProbes('__never__', {})
    await expect(probeAts({ domain: 'acme.com', name: 'Acme' })).resolves.toBeNull()
  })
})
