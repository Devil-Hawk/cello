import { afterEach, describe, expect, it, vi } from 'vitest'
import { smartrecruiters } from './smartrecruiters'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// Captured live from api.smartrecruiters.com/v1/companies/Sodexo/postings on
// 2026-08-03. The list carries no description and no posting URL — hence the
// per-posting detail call and the rebuilt canonical URL.
const REAL_LIST_POSTING = {
  id: '744000141197212',
  name: 'Village Manager | FIFO | 8:6 | Western Australia (Various Sites)',
  uuid: 'be3c3baf-a941-4af1-b797-84167249d6ec',
  refNumber: 'REF19271C',
  company: { identifier: 'Sodexo', name: 'Sodexo' },
  releasedDate: '2026-08-03T08:14:41.903Z',
  location: { city: 'Western Australia', region: 'WA', country: 'au', remote: false, hybrid: false },
  typeOfEmployment: { id: 'permanent', label: 'Full-time' },
  visibility: 'PUBLIC',
}

// Captured live from .../postings/744000141197212. Note `videos`, a section
// with `urls` and no `text` at all.
const REAL_DETAIL = {
  id: '744000141197212',
  name: 'Village Manager | FIFO | 8:6 | Western Australia (Various Sites)',
  postingUrl: 'https://jobs.smartrecruiters.com/Sodexo/744000141197212-village-manager-fifo-8-6-western-australia',
  jobAd: {
    sections: {
      companyDescription: {
        title: 'Company Description',
        text: '<p><strong>Experienced FIFO Village Manager required for permanent full time role on an 8/6 roster&#xa0;</strong></p>',
      },
      jobDescription: {
        title: 'Job Description',
        text: '<p>Are you a hospitality manager and a great communicator with a passion for people and business?</p>',
      },
      qualifications: {
        title: 'Qualifications',
        text: '<p><strong>To be successful, you’ll need:</strong></p><ul><li>4 Years Managerial Experience</li></ul>',
      },
      additionalInformation: {
        title: 'Additional Information',
        text: '<p><strong>Why choose Sodexo?</strong><br>\nSodexo is a people business.</p>',
      },
      videos: { title: 'Videos To Watch', urls: ['https://www.youtube.com/watch?v=lRXd1nItpbM'] },
    },
  },
}

const CANONICAL_URL = 'https://jobs.smartrecruiters.com/Sodexo/744000141197212'

function mockBoard(pages: unknown[][], detail: unknown = REAL_DETAIL) {
  const urls: string[] = []
  const fetchMock = vi.fn(async (url: string) => {
    urls.push(url)
    const match = /[?&]offset=(\d+)/.exec(url)
    if (match) return jsonResponse({ offset: Number(match[1]), limit: 100, totalFound: 118, content: pages[Number(match[1]) / 100] ?? [] })
    return jsonResponse(detail)
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return urls
}

describe('smartrecruiters.detect', () => {
  it('reads the company id off a board URL', () => {
    expect(smartrecruiters.detect({ careerUrl: 'https://jobs.smartrecruiters.com/Sodexo', domain: null })).toEqual({
      token: 'Sodexo',
    })
    expect(
      smartrecruiters.detect({ careerUrl: 'https://careers.smartrecruiters.com/Visa/', domain: null })
    ).toEqual({ token: 'Visa' })
  })

  it('reads it off a deep posting URL too', () => {
    expect(
      smartrecruiters.detect({
        careerUrl: 'https://jobs.smartrecruiters.com/Sodexo/744000141197212-village-manager',
        domain: null,
      })
    ).toEqual({ token: 'Sodexo' })
  })

  it('returns null for other hosts and empty paths', () => {
    expect(smartrecruiters.detect({ careerUrl: 'https://jobs.lever.co/acme', domain: null })).toBeNull()
    expect(smartrecruiters.detect({ careerUrl: 'https://jobs.smartrecruiters.com/', domain: null })).toBeNull()
    expect(smartrecruiters.detect({ careerUrl: null, domain: 'sodexo.com' })).toBeNull()
  })
})

describe('smartrecruiters.fetch', () => {
  it('normalises a real posting and joins the detail sections in a fixed order', async () => {
    mockBoard([[REAL_LIST_POSTING]])

    const jobs = await smartrecruiters.fetch('Sodexo')

    expect(jobs).toHaveLength(1)
    const [job] = jobs
    expect(job.title).toBe('Village Manager | FIFO | 8:6 | Western Australia (Various Sites)')
    expect(job.url).toBe(CANONICAL_URL)
    expect(job.externalId).toBe(CANONICAL_URL)
    expect(job.location).toBe('Western Australia, WA, AU')
    expect(job.postedAt).toBe('2026-08-03T08:14:41.903Z')

    const description = job.description as string
    expect(description).toContain('Experienced FIFO Village Manager required')
    expect(description).toContain('Are you a hospitality manager')
    expect(description).toContain('4 Years Managerial Experience')
    expect(description).toContain('Sodexo is a people business')
    // Fixed order, so the same posting always yields the same string.
    expect(description.indexOf('Experienced FIFO')).toBeLessThan(description.indexOf('Are you a hospitality'))
    expect(description.indexOf('Are you a hospitality')).toBeLessThan(description.indexOf('4 Years Managerial'))
    // The `videos` section has no `text` — it must not leak a URL into the body.
    expect(description).not.toContain('youtube.com')
    expect(description).not.toMatch(/<[a-z]/i)
    // &#xa0; decoded, not left as an entity.
    expect(description).not.toContain('&#xa0;')
  })

  it('marks remote postings in the location string', async () => {
    mockBoard([[{ ...REAL_LIST_POSTING, location: { city: 'Sydney', region: 'NSW', country: 'au', remote: true } }]])
    const [job] = await smartrecruiters.fetch('Sodexo')
    expect(job.location).toBe('Remote, Sydney, NSW, AU')
  })

  it('pages at 100 and stops on a short page', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ ...REAL_LIST_POSTING, id: `id-${i}` }))
    const tail = Array.from({ length: 18 }, (_, i) => ({ ...REAL_LIST_POSTING, id: `tail-${i}` }))
    const urls = mockBoard([full, tail])

    const jobs = await smartrecruiters.fetch('Sodexo')

    expect(jobs).toHaveLength(118)
    const listUrls = urls.filter((u) => u.includes('offset='))
    expect(listUrls).toHaveLength(2)
    expect(listUrls[0]).toBe('https://api.smartrecruiters.com/v1/companies/Sodexo/postings?limit=100&offset=0')
    expect(listUrls[1]).toContain('offset=100')
    // Detail calls are capped at the budget, not one per posting.
    expect(urls.filter((u) => !u.includes('offset=')).length).toBe(25)
    expect(jobs.filter((j) => j.description).length).toBe(25)
  })

  it('treats an unknown company (200 with an empty page) as an empty board, not an error', async () => {
    mockBoard([[]])
    await expect(smartrecruiters.fetch('zzqxnotacompany')).resolves.toEqual([])
  })

  it('builds the same externalId whether the board was found by URL or by the lowercase probe', async () => {
    // The API is case-insensitive, so detectFromUrl yields "Sodexo" and
    // probeAts yields "sodexo" for the SAME board. If the posting URL used our
    // token, the two paths would write two rows for one job.
    mockBoard([[REAL_LIST_POSTING]])
    const fromUrl = await smartrecruiters.fetch('Sodexo')
    mockBoard([[REAL_LIST_POSTING]])
    const fromProbe = await smartrecruiters.fetch('sodexo')

    expect(fromProbe[0].externalId).toBe(fromUrl[0].externalId)
    expect(fromProbe[0].externalId).toBe(CANONICAL_URL)
  })

  it('falls back to the requested token when a posting omits the company block', async () => {
    mockBoard([[{ ...REAL_LIST_POSTING, company: undefined }]])
    const [job] = await smartrecruiters.fetch('Sodexo')
    expect(job.externalId).toBe(CANONICAL_URL)
  })
})
