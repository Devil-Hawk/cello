import { afterEach, describe, expect, it, vi } from 'vitest'
import { workday } from './workday'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// Captured live from nvidia.wd5.myworkdayjobs.com on 2026-08-03. Note what is
// NOT here: no description, and `postedOn` is relative prose rather than a
// date — the two facts that force the per-posting detail call.
const REAL_LIST_ENTRY = {
  title: 'Senior Software SDET Test Development Engineer',
  externalPath: '/job/US-CA-Santa-Clara/Senior-Software-SDET-Test-Development-Engineer_JR2013796',
  locationsText: 'US, CA, Santa Clara',
  postedOn: 'Posted Today',
  bulletFields: ['JR2013796'],
}

// Captured live from the matching /wday/cxs/... detail endpoint.
const REAL_DETAIL = {
  jobPostingInfo: {
    id: '68a8273d16c6103014d4af00def20000',
    title: 'Senior Software SDET Test Development Engineer',
    jobDescription:
      '<p>NVIDIA has been transforming computer graphics, PC gaming, and accelerated computing for more than 25 years. ' +
      'It’s a unique legacy of innovation that’s fueled by great technology—and amazing people.</p>' +
      '<p><b>What you’ll be doing:</b></p><ul><li>Own the <a href="https://nvidia.com/sdet">SDET charter</a></li></ul>',
    location: 'US, CA, Santa Clara',
    postedOn: 'Posted Today',
    startDate: '2026-08-04',
    timeType: 'Full time',
    externalUrl:
      'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-Software-SDET-Test-Development-Engineer_JR2013796',
  },
}

const TOKEN = 'nvidia.wd5.NVIDIAExternalCareerSite'
const CANONICAL_URL =
  'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-Software-SDET-Test-Development-Engineer_JR2013796'

/** Route the mock by URL: the POST list endpoint vs the GET detail endpoint. */
function mockBoard(pages: (typeof REAL_LIST_ENTRY)[][], detail: unknown = REAL_DETAIL) {
  const calls: { url: string; method: string; body?: unknown }[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined })
    if (url.endsWith('/jobs') && method === 'POST') {
      const offset = (JSON.parse(init?.body as string) as { offset: number }).offset
      return jsonResponse({ total: 2000, jobPostings: pages[offset / 20] ?? [] })
    }
    return jsonResponse(detail)
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return calls
}

describe('workday.detect', () => {
  it('reads tenant, data centre and site off a plain board URL', () => {
    expect(workday.detect({ careerUrl: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite', domain: null })).toEqual({
      token: TOKEN,
    })
  })

  it('skips an interposed locale segment', () => {
    expect(
      workday.detect({ careerUrl: 'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite', domain: null })
    ).toEqual({ token: TOKEN })
    expect(workday.detect({ careerUrl: 'https://3m.wd1.myworkdayjobs.com/de/Search', domain: null })).toEqual({
      token: '3m.wd1.Search',
    })
  })

  it('handles a deep posting URL and the CXS form', () => {
    expect(
      workday.detect({
        careerUrl: 'https://3m.wd1.myworkdayjobs.com/Search/job/US-MN/Industrial-Engineer_R01159078',
        domain: null,
      })
    ).toEqual({ token: '3m.wd1.Search' })
    expect(
      workday.detect({ careerUrl: 'https://cdw.wd5.myworkdayjobs.com/wday/cxs/cdw/Careers/jobs', domain: null })
    ).toEqual({ token: 'cdw.wd5.Careers' })
  })

  it('returns null for non-Workday and site-less URLs', () => {
    expect(workday.detect({ careerUrl: 'https://boards.greenhouse.io/acme', domain: null })).toBeNull()
    expect(workday.detect({ careerUrl: 'https://nvidia.myworkdayjobs.com/Site', domain: null })).toBeNull()
    expect(workday.detect({ careerUrl: 'https://nvidia.wd5.myworkdayjobs.com/', domain: null })).toBeNull()
    expect(workday.detect({ careerUrl: 'not a url', domain: null })).toBeNull()
  })
})

describe('workday.fetch', () => {
  it('normalises a real list entry and enriches it from the real detail payload', async () => {
    mockBoard([[REAL_LIST_ENTRY]])

    const jobs = await workday.fetch(TOKEN)

    expect(jobs).toHaveLength(1)
    const [job] = jobs
    expect(job.title).toBe('Senior Software SDET Test Development Engineer')
    // The rebuilt URL matches the detail response's own `externalUrl`, which
    // is what makes it safe as the stable external_id.
    expect(job.url).toBe(CANONICAL_URL)
    expect(job.externalId).toBe(CANONICAL_URL)
    expect(job.externalId).toBe(REAL_DETAIL.jobPostingInfo.externalUrl)
    expect(job.location).toBe('US, CA, Santa Clara')
    // From the detail's startDate — never guessed from "Posted Today".
    expect(job.postedAt).toBe(new Date('2026-08-04').toISOString())
    expect(job.description).toContain('NVIDIA has been transforming computer graphics')
    expect(job.description).toContain('Own the SDET charter')
    expect(job.description).not.toMatch(/<[a-z]/i)
    expect(job.description).not.toContain('https://nvidia.com/sdet')
  })

  it('POSTs the paging window and walks pages until a short one', async () => {
    const full = Array.from({ length: 20 }, (_, i) => ({
      ...REAL_LIST_ENTRY,
      externalPath: `/job/US-CA-Santa-Clara/Role-${i}_JR${i}`,
    }))
    const tail = [{ ...REAL_LIST_ENTRY, externalPath: '/job/US-CA-Santa-Clara/Role-last_JR99' }]
    const calls = mockBoard([full, tail])

    const jobs = await workday.fetch(TOKEN)

    expect(jobs).toHaveLength(21)
    const listCalls = calls.filter((c) => c.method === 'POST')
    expect(listCalls).toHaveLength(2)
    expect(listCalls[0].url).toBe('https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs')
    expect(listCalls[0].body).toEqual({ appliedFacets: {}, limit: 20, offset: 0, searchText: '' })
    expect(listCalls[1].body).toMatchObject({ offset: 20 })
  })

  it('caps description fetches at the budget and still returns the rest of the board', async () => {
    const page = Array.from({ length: 20 }, (_, i) => ({
      ...REAL_LIST_ENTRY,
      externalPath: `/job/US-CA-Santa-Clara/Role-${i}_JR${i}`,
    }))
    const tail = Array.from({ length: 10 }, (_, i) => ({
      ...REAL_LIST_ENTRY,
      externalPath: `/job/US-CA-Santa-Clara/Tail-${i}_JR1${i}`,
    }))
    const calls = mockBoard([page, tail])

    const jobs = await workday.fetch(TOKEN)

    expect(jobs).toHaveLength(30)
    // 25 detail GETs (the budget), not 30.
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(25)
    expect(jobs.filter((j) => j.description).length).toBe(25)
    // The 5 past the budget are still returned — title/location/url intact —
    // so a big board loses bodies, never postings.
    expect(jobs.slice(25).every((j) => j.title && j.url && !j.description)).toBe(true)
  })

  // The real case: a posting is pulled between the list call and the detail
  // call, so the detail 404s. The row is still worth having.
  it('survives a detail call that fails without losing the posting', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') return jsonResponse({ total: 1, jobPostings: [REAL_LIST_ENTRY] })
      return new Response('not found', { status: 404, statusText: 'Not Found' })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const jobs = await workday.fetch(TOKEN)

    expect(jobs).toHaveLength(1)
    expect(jobs[0].url).toBe(CANONICAL_URL)
    expect(jobs[0].description).toBeUndefined()
  })

  it('rejects a token that is not {tenant}.wd{N}.{site} before any request', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(workday.fetch('nvidia')).rejects.toThrow(/invalid board token/)
    await expect(workday.fetch('nvidia.xx5.Site')).rejects.toThrow(/invalid board token/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
