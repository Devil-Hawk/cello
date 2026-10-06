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

  function board(total: number) {
    const rows = Array.from({ length: total }, (_, i) => ({
      ...REAL_LIST_ENTRY,
      externalPath: `/job/US-CA-Santa-Clara/Role-${i}_JR${i}`,
    }))
    const pages: (typeof rows)[] = []
    for (let i = 0; i < rows.length; i += 20) pages.push(rows.slice(i, i + 20))
    return { rows, calls: mockBoard(pages) }
  }

  it('caps description fetches at the budget and still returns the rest of the board', async () => {
    const { calls } = board(50)

    const jobs = await workday.fetch(TOKEN)

    expect(jobs).toHaveLength(50)
    // 40 detail GETs (the budget), not 50.
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(40)
    expect(jobs.filter((j) => j.description).length).toBe(40)
    // The 10 past the budget are still returned, title/location/url intact,
    // so a big board loses bodies for one refresh, never postings.
    expect(jobs.slice(40).every((j) => j.title && j.url && !j.description)).toBe(true)
  })

  it('spends the budget on postings that have no stored description, so a big board fills in', async () => {
    const { calls } = board(50)
    // The first 40 already have a body stored (a previous refresh read them).
    const have = new Set(
      Array.from({ length: 40 }, (_, i) => `https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Role-${i}_JR${i}`)
    )

    const jobs = await workday.fetch(TOKEN, { hasDescription: (id) => have.has(id) })

    // Only the 10 without a body are read, and they all get one.
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(10)
    expect(jobs.slice(40).every((j) => j.description)).toBe(true)
    expect(jobs.slice(0, 40).every((j) => !j.description)).toBe(true)
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

  // Recorded from ccf.wd1.myworkdayjobs.com/ClevelandClinicCareers (2,147 open roles) on 2026-10-06: the unfiltered
  // newest window is all clinical roles, the search for "software engineer" returns the engineering ones.
  describe("searching by the person's targets", () => {
    const CCF = 'ccf.wd1.ClevelandClinicCareers'
    const entry = (title: string, id: string, postedOn: string) => ({
      title,
      externalPath: `/job/US-OH-Cleveland/${id}`,
      locationsText: 'Cleveland, Ohio',
      postedOn,
    })
    const clinical = Array.from({ length: 500 }, (_, i) => entry(`RN Ambulatory ${i}`, `RN-${i}_R${i}`, 'Posted Today'))
    const engineering = [
      entry('Health Physics Associate', 'HP_R1', 'Posted 3 Days Ago'),
      entry('Software Developer III - Next.js and Sanity', 'SD3_R2', 'Posted 18 Days Ago'),
      entry('Research Data Scientist I - Cole Eye', 'RDS_R3', 'Posted 21 Days Ago'),
    ]
    const data = [entry('Data Registry Coordinator', 'DRC_R4', 'Posted Today'), entry('Systems Analyst II', 'SA2_R5', 'Posted 30+ Days Ago')]

    function searchable() {
      const searches: string[] = []
      globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if ((init?.method ?? 'GET') !== 'POST') return jsonResponse({ jobPostingInfo: {} })
        const body = JSON.parse(init?.body as string) as { offset: number; searchText: string }
        searches.push(body.searchText)
        const all = body.searchText === 'software engineer' ? engineering : body.searchText === 'data' ? data : body.searchText === '' ? clinical : []
        return jsonResponse({ total: all.length, jobPostings: all.slice(body.offset, body.offset + 20) })
      }) as unknown as typeof fetch
      return searches
    }

    it('without targets reads only the newest 500, which hold none of the engineering roles', async () => {
      searchable()
      const jobs = await workday.fetch(CCF)
      expect(jobs).toHaveLength(500)
      expect(jobs.some((j) => /software/i.test(j.title))).toBe(false)
    })

    it('with targets searches each word and returns roles the unfiltered window lacks, newest first', async () => {
      const searches = searchable()
      const jobs = await workday.fetch(CCF, { query: ['software engineer', 'data'] })
      expect(searches).toEqual(['software engineer', 'data'])
      expect(jobs.map((j) => j.title)).toEqual([
        'Data Registry Coordinator',
        'Health Physics Associate',
        'Software Developer III - Next.js and Sanity',
        'Research Data Scientist I - Cole Eye',
        'Systems Analyst II',
      ])
    })

    it('searches at most three words and counts a role found by two of them once', async () => {
      const searches = searchable()
      const jobs = await workday.fetch(CCF, { query: ['data', 'software engineer', 'data analyst', 'ignored', 'data'] })
      expect(searches).toEqual(['data', 'software engineer', 'data analyst'])
      expect(new Set(jobs.map((j) => j.externalId)).size).toBe(jobs.length)
    })

    it('says it is searched, so a role missing from the list is not taken as closed', () => {
      expect(workday.searchesByQuery).toBe(true)
    })
  })

  it('rejects a token that is not {tenant}.wd{N}.{site} before any request', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(workday.fetch('nvidia')).rejects.toThrow(/invalid board token/)
    await expect(workday.fetch('nvidia.xx5.Site')).rejects.toThrow(/invalid board token/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
