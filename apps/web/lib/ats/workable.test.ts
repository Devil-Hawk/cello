import { afterEach, describe, expect, it, vi } from 'vitest'
import { workable } from './workable'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// Captured live from
// apply.workable.com/api/v1/widget/accounts/amazingcarecareers?details=true on
// 2026-08-03 (description trimmed). `description` only exists because of
// details=true — without that flag the same call returns every other field and
// no body at all.
const REAL_JOB = {
  title: 'Adult / Pediatric Home Health Occupational Therapist',
  shortcode: '1B7FCA3A83',
  code: '',
  employment_type: 'Part-time',
  telecommuting: false,
  department: 'Clinical Staff',
  url: 'https://apply.workable.com/j/1B7FCA3A83',
  shortlink: 'https://apply.workable.com/j/1B7FCA3A83',
  application_url: 'https://apply.workable.com/j/1B7FCA3A83/apply',
  published_on: '2026-07-13',
  created_at: '2026-07-13',
  country: 'United States',
  city: 'St. George',
  state: 'Utah',
  education: "Master's Degree",
  experience: 'Associate',
  industry: 'Hospital & Health Care',
  locations: [{ country: 'United States', countryCode: 'US', city: 'St. George', region: 'Utah', hidden: false }],
  description:
    '<p>Our employees and our patients are the foundation of our success, and their dedication is what truly makes Amazing Care&hellip;&nbsp;AMAZING!&nbsp;&nbsp;</p>' +
    '<p>Founded in 2004,&nbsp;Amazing Care Home Health Services&nbsp;was built on a simple but powerful belief.</p>' +
    '<p><strong>Key Responsibilities:</strong></p><ul><li>Performs evaluations and interprets <a href="https://amazingcare.com/ot">assessment results</a>.</li></ul>',
}

describe('workable.detect', () => {
  it('reads the account slug off an apply.workable.com board URL', () => {
    expect(workable.detect({ careerUrl: 'https://apply.workable.com/amazingcarecareers/', domain: null })).toEqual({
      token: 'amazingcarecareers',
    })
    expect(
      workable.detect({ careerUrl: 'https://apply.workable.com/bolt/j/1B7FCA3A83/', domain: null })
    ).toEqual({ token: 'bolt' })
  })

  it('reads a legacy per-account subdomain', () => {
    expect(workable.detect({ careerUrl: 'https://acme.workable.com/', domain: null })).toEqual({ token: 'acme' })
  })

  it('refuses a bare posting URL, which names no account', () => {
    // apply.workable.com/j/{shortcode} identifies a JOB, not a board — reading
    // "j" as an account slug would store a board token that never resolves.
    expect(workable.detect({ careerUrl: 'https://apply.workable.com/j/1B7FCA3A83', domain: null })).toBeNull()
    expect(workable.detect({ careerUrl: 'https://apply.workable.com/api/v1/widget', domain: null })).toBeNull()
  })

  it('refuses Workable-owned subdomains and other hosts', () => {
    expect(workable.detect({ careerUrl: 'https://www.workable.com/', domain: null })).toBeNull()
    expect(workable.detect({ careerUrl: 'https://jobs.workable.com/', domain: null })).toBeNull()
    expect(workable.detect({ careerUrl: 'https://boards.greenhouse.io/acme', domain: null })).toBeNull()
  })
})

describe('workable.fetch', () => {
  it('normalises a real posting, body included, in one request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ name: 'Amazing Care', jobs: [REAL_JOB] }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const jobs = await workable.fetch('amazingcarecareers')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://apply.workable.com/api/v1/widget/accounts/amazingcarecareers?details=true'
    )

    expect(jobs).toHaveLength(1)
    const [job] = jobs
    expect(job.title).toBe('Adult / Pediatric Home Health Occupational Therapist')
    expect(job.url).toBe('https://apply.workable.com/j/1B7FCA3A83')
    expect(job.externalId).toBe('https://apply.workable.com/j/1B7FCA3A83')
    expect(job.location).toBe('St. George, Utah, United States')
    expect(job.postedAt).toBe(new Date('2026-07-13').toISOString())

    const description = job.description as string
    expect(description).toContain('Our employees and our patients are the foundation of our success')
    expect(description).toContain('Key Responsibilities:')
    expect(description).toContain('Performs evaluations and interprets assessment results.')
    expect(description).not.toMatch(/<[a-z]/i)
    expect(description).not.toContain('&nbsp;')
    expect(description).not.toContain('https://amazingcare.com/ot')
  })

  it('flags telecommuting roles in the location, which nothing else in the payload says', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ jobs: [{ ...REAL_JOB, telecommuting: true }] })) as unknown as typeof fetch
    const [job] = await workable.fetch('amazingcarecareers')
    expect(job.location).toBe('Remote · St. George, Utah, United States')
  })

  it('skips hidden locations and falls back to the flat city/state/country fields', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ jobs: [{ ...REAL_JOB, locations: [{ city: 'Denver', region: 'Colorado', country: 'United States', hidden: true }] }] })
    ) as unknown as typeof fetch
    const [job] = await workable.fetch('amazingcarecareers')
    expect(job.location).toBe('St. George, Utah, United States')
  })

  it('rebuilds the posting URL from the shortcode when the payload omits it', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ jobs: [{ ...REAL_JOB, url: undefined, shortlink: undefined }] })) as unknown as typeof fetch
    const [job] = await workable.fetch('amazingcarecareers')
    expect(job.externalId).toBe('https://apply.workable.com/j/1B7FCA3A83')
  })

  it('repairs a description that arrived UTF-8-as-Latin-1 mis-decoded', async () => {
    // Employer-pasted HTML re-served by the board; the en dash E2 80 93 read
    // as Latin-1. See lib/jobs/mojibake.ts.
    const mojibake = {
      ...REAL_JOB,
      description:
        '<p>Working Hours: 9:00 AM \u00e2\u0080\u0093 6:00 PM. 1\u00e2\u0080\u00933 years with the company\u00e2\u0080\u0099s stack.</p>',
    }
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ jobs: [mojibake] })) as unknown as typeof fetch

    const [job] = await workable.fetch('amazingcarecareers')

    expect(job.description).toContain('9:00 AM – 6:00 PM')
    expect(job.description).toContain('1–3 years')
    expect(job.description).toContain('the company’s stack')
    expect(job.description).not.toContain('\u0080')
    expect(job.description).not.toContain('�')
  })
})
