import { afterEach, describe, expect, it, vi } from 'vitest'
import { lever } from './lever'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// Shaped like a live api.lever.co posting (palantir, 2026-10-05): the opening
// paragraph is `descriptionPlain`; everything a candidate is judged on is in
// `lists`; the pay and visa notes are in `additionalPlain`.
const POSTING = {
  id: 'abc',
  text: 'Senior Backend Engineer',
  hostedUrl: 'https://jobs.lever.co/acme/abc',
  createdAt: 1_790_000_000_000,
  descriptionPlain: 'Acme builds payment rails for restaurants. You will own our ledger service.',
  lists: [
    { text: 'What you will do', content: '<li>Design the ledger</li><li>Run on-call</li>' },
    { text: 'What we require', content: '<li>5+ years of experience</li><li>Strong Go and Postgres</li>' },
  ],
  additionalPlain: 'We do not offer visa sponsorship. Base salary $150,000 - $190,000.',
  categories: { location: 'Remote', allLocations: ['Remote - US'], commitment: 'Full-time', team: 'Platform' },
  salaryRange: { min: 150000, max: 190000, currency: 'usd', interval: 'per-year-salary' },
}

describe('lever.fetch', () => {
  it('keeps the whole posting: opening paragraph, every titled list, and the closing text', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse([POSTING])) as unknown as typeof fetch
    const [job] = await lever.fetch('acme')

    expect(job.description).toContain('You will own our ledger service.')
    // The requirements list is the part the opening paragraph alone dropped.
    expect(job.description).toContain('What we require\n')
    expect(job.description).toContain('5+ years of experience')
    expect(job.description).toContain('Strong Go and Postgres')
    expect(job.description).toContain('We do not offer visa sponsorship.')
    // Headings come before their lists, in the order Lever sent them.
    expect(job.description!.indexOf('What you will do')).toBeLessThan(job.description!.indexOf('What we require'))
    // No markup survives.
    expect(job.description).not.toMatch(/<\/?li>/)
  })

  it('maps title, url, location, posted date and pay', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse([POSTING])) as unknown as typeof fetch
    const [job] = await lever.fetch('acme')
    expect(job).toMatchObject({
      title: 'Senior Backend Engineer',
      url: 'https://jobs.lever.co/acme/abc',
      externalId: 'https://jobs.lever.co/acme/abc',
      location: 'Remote - US',
    })
    expect(job.postedAt).toBe(new Date(1_790_000_000_000).toISOString())
    expect(job.salary).toContain('150,000')
  })

  it('still returns the opening paragraph when a posting has no lists', async () => {
    const { lists: _lists, additionalPlain: _additional, ...bare } = POSTING
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse([bare])) as unknown as typeof fetch
    const [job] = await lever.fetch('acme')
    expect(job.description).toBe('Acme builds payment rails for restaurants. You will own our ledger service.')
  })

  it('returns no description for a posting with nothing in any field, rather than an empty string', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse([{ text: 'Engineer', hostedUrl: 'https://jobs.lever.co/acme/x', lists: [{ text: 'Empty', content: '' }] }])) as unknown as typeof fetch
    const [job] = await lever.fetch('acme')
    expect(job.description).toBeUndefined()
  })

  it('falls back to the EU host on a 404', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith('https://api.lever.co/') ? jsonResponse({ ok: false }, 404) : jsonResponse([POSTING])
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const jobs = await lever.fetch('acme')
    expect(jobs).toHaveLength(1)
    expect(fetchMock.mock.calls.map((c) => new URL(String(c[0])).host)).toEqual(['api.lever.co', 'api.eu.lever.co'])
  })

  it('skips an entry with no hosted url', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse([{ text: 'No url' }, POSTING])) as unknown as typeof fetch
    expect(await lever.fetch('acme')).toHaveLength(1)
  })
})
