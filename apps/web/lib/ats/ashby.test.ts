import { afterEach, describe, expect, it, vi } from 'vitest'
import { ashby } from './ashby'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// Shaped like a live api.ashbyhq.com posting (ramp, 2026-10-05).
const POSTING = {
  id: '34413f8d-26bf-4bbc-8ade-eb309a0e2245',
  title: ' Security Engineer, Cloud',
  jobUrl: 'https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245',
  location: 'New York, NY (HQ)',
  secondaryLocations: [{ location: 'Remote - US' }],
  publishedAt: '2026-09-20T12:00:00.000+00:00',
  isListed: true,
  descriptionPlain:
    'ABOUT RAMP\n\nRamp is building the smart infrastructure for finance teams.\n\nWhat You Will Need\n- 5+ years of experience in security engineering\n- Strong AWS and Terraform',
  compensation: {
    summaryComponents: [{ compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 200000, maxValue: 260000 }],
  },
}

describe('ashby.fetch', () => {
  it('keeps the full plain-text description, requirements included', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ jobs: [POSTING] })) as unknown as typeof fetch
    const [job] = await ashby.fetch('ramp')
    expect(job.description).toContain('What You Will Need')
    expect(job.description).toContain('Strong AWS and Terraform')
  })

  it('maps title, url, locations, posted date and annualised pay', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ jobs: [POSTING] })) as unknown as typeof fetch
    const [job] = await ashby.fetch('ramp')
    expect(job.url).toBe(POSTING.jobUrl)
    expect(job.externalId).toBe(POSTING.jobUrl)
    expect(job.location).toBe('New York, NY (HQ) · Remote - US')
    expect(job.postedAt).toBe('2026-09-20T12:00:00.000Z')
    expect(job.salary).toBe('USD 200,000–260,000 / yr')
  })

  it('skips a posting that is not listed', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ jobs: [{ ...POSTING, isListed: false }, { ...POSTING, jobUrl: 'https://jobs.ashbyhq.com/ramp/other' }] })) as unknown as typeof fetch
    const jobs = await ashby.fetch('ramp')
    expect(jobs.map((j) => j.url)).toEqual(['https://jobs.ashbyhq.com/ramp/other'])
  })

  it('returns an empty board for a response with no jobs array', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({})) as unknown as typeof fetch
    expect(await ashby.fetch('ramp')).toEqual([])
  })

  it('refuses a malformed org token before making a request', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await expect(ashby.fetch('../etc/passwd')).rejects.toThrow(/invalid/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
