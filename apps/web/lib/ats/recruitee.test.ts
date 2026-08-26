import { afterEach, describe, expect, it, vi } from 'vitest'
import { recruitee } from './recruitee'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// Captured live from hygraph.recruitee.com/api/offers/ on 2026-08-03 (HTML
// bodies trimmed). Two things this proves about the real shape: `careers_url`
// points at the company's OWN domain, not recruitee.com, and a remote posting
// has `location` replaced by the literal "Remote job" with the real city only
// surviving in city/country.
const REAL_OFFER = {
  id: 2691429,
  slug: 'senior-fullstack-engineer-fmd-berlin-i-germany-emea-i-remote',
  title: 'Senior Fullstack Engineer (f/m/d) - Berlin I Germany, EMEA I Remote',
  careers_url: 'https://jobs.hygraph.com/o/senior-fullstack-engineer-fmd-berlin-i-germany-emea-i-remote',
  careers_apply_url: 'https://jobs.hygraph.com/o/senior-fullstack-engineer-fmd-berlin-i-germany-emea-i-remote/c/new',
  status: 'published',
  location: 'Remote job',
  city: 'Berlin',
  country: 'Germany',
  country_code: 'DE',
  remote: true,
  published_at: '2026-07-30 09:03:22 UTC',
  created_at: '2026-07-27 15:12:47 UTC',
  department: 'Engineering',
  employment_type_code: 'fulltime_permanent',
  salary: { max: '90000', min: '75000', period: 'year', currency: 'EUR' },
  description:
    '<p style="text-align:start;"><strong>How will you make an impact?</strong></p>' +
    "<p>As a Senior Full Stack Engineer, you'll work at the intersection of engineering and product.</p>",
  requirements:
    '<p><strong>What we expect from you:</strong></p><ul><li>Significant experience building production systems.</li></ul>',
}

const ON_SITE_OFFER = {
  ...REAL_OFFER,
  id: 2697184,
  slug: 'partner-development-representative',
  title: 'Partner Development Representative (f/m/d) - Berlin, Germany',
  careers_url: 'https://jobs.hygraph.com/o/partner-development-representative',
  location: 'Berlin, Berlin, Germany',
  remote: false,
}

describe('recruitee.detect', () => {
  it('reads the company slug off a recruitee.com board URL', () => {
    expect(recruitee.detect({ careerUrl: 'https://hygraph.recruitee.com/', domain: null })).toEqual({ token: 'hygraph' })
    expect(recruitee.detect({ careerUrl: 'https://channable.recruitee.com/o/some-role', domain: null })).toEqual({
      token: 'channable',
    })
  })

  it('returns null for Recruitee-owned subdomains, custom career domains and other hosts', () => {
    expect(recruitee.detect({ careerUrl: 'https://www.recruitee.com/', domain: null })).toBeNull()
    // A company's own careers domain carries no slug to read — those boards
    // are found by the probe, not by URL.
    expect(recruitee.detect({ careerUrl: 'https://jobs.hygraph.com/o/some-role', domain: null })).toBeNull()
    expect(recruitee.detect({ careerUrl: 'https://jobs.ashbyhq.com/acme', domain: null })).toBeNull()
  })
})

describe('recruitee.fetch', () => {
  it('normalises a real offer in one request, body and requirements included', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ offers: [REAL_OFFER] }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const jobs = await recruitee.fetch('hygraph')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://hygraph.recruitee.com/api/offers/')

    expect(jobs).toHaveLength(1)
    const [job] = jobs
    expect(job.title).toBe('Senior Fullstack Engineer (f/m/d) - Berlin I Germany, EMEA I Remote')
    // The company's own careers domain, which is where the board actually
    // lives — and what the stable externalId is built from.
    expect(job.url).toBe(REAL_OFFER.careers_url)
    expect(job.externalId).toBe(REAL_OFFER.careers_url)
    expect(job.postedAt).toBe('2026-07-30T09:03:22.000Z')
    expect(job.salary).toBe('EUR 75,000–90,000 per year')
    // "Remote job" is not a place; the real city is recovered from city/country.
    expect(job.location).toBe('Remote · Berlin, Germany')

    const description = job.description as string
    expect(description).toContain('How will you make an impact?')
    expect(description).toContain('intersection of engineering and product')
    expect(description).toContain('What we expect from you:')
    expect(description).toContain('Significant experience building production systems.')
    expect(description).not.toMatch(/<[a-z]/i)
  })

  it('keeps the rendered location label for on-site roles', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ offers: [ON_SITE_OFFER] })) as unknown as typeof fetch
    const [job] = await recruitee.fetch('hygraph')
    expect(job.location).toBe('Berlin, Berlin, Germany')
  })

  it('skips offers that are not published', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ offers: [{ ...REAL_OFFER, status: 'draft' }, ON_SITE_OFFER] })
    ) as unknown as typeof fetch
    const jobs = await recruitee.fetch('hygraph')
    expect(jobs).toHaveLength(1)
    expect(jobs[0].externalId).toBe(ON_SITE_OFFER.careers_url)
  })

  it('falls back to the recruitee.com posting URL when careers_url is absent', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ offers: [{ ...REAL_OFFER, careers_url: undefined }] })) as unknown as typeof fetch
    const [job] = await recruitee.fetch('hygraph')
    expect(job.externalId).toBe(
      'https://hygraph.recruitee.com/o/senior-fullstack-engineer-fmd-berlin-i-germany-emea-i-remote'
    )
  })

  it('omits salary when the offer carries no bounds', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ offers: [{ ...REAL_OFFER, salary: { period: 'year', currency: 'EUR' } }] })) as unknown as typeof fetch
    const [job] = await recruitee.fetch('hygraph')
    expect(job.salary).toBeUndefined()
  })

  it('refuses a slug that would leave the recruitee.com domain', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    // TOKEN_RE already forbids "/" and "@", so isValidToken rejects first —
    // the host-suffix guard is the second line of defence, not the only one.
    await expect(recruitee.fetch('evil.com/x')).rejects.toThrow(/invalid company slug/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
