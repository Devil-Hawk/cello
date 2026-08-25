import { afterEach, describe, expect, it, vi } from 'vitest'
import { greenhouse } from './greenhouse'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// A trimmed but faithful capture of a real `boards-api.greenhouse.io`
// response (fetched live against the Stripe board 2026-07-28). Greenhouse's
// `content` field is HTML-escaped HTML — the JSON string contains literal
// "&lt;h2&gt;" rather than "<h2>" — which is exactly the double-encoding
// quirk descriptionToText() has to unwind before handing real HTML to
// html-to-text.
const REAL_GREENHOUSE_JOB = {
  absolute_url: 'https://stripe.com/jobs/search?gh_jid=7954688',
  title: 'Account Executive, AI Sales (Grower)',
  location: { name: 'San Francisco, CA' },
  first_published: '2026-06-02T08:58:57-04:00',
  updated_at: '2026-07-27T11:17:30-04:00',
  content:
    '&lt;h2&gt;Who we are&lt;/h2&gt;\n&lt;h3&gt;About Stripe&lt;/h3&gt;\n' +
    '&lt;p&gt;Stripe is a financial infrastructure platform for businesses. ' +
    'Millions of companies use Stripe to accept payments &amp; grow their revenue.&lt;/p&gt;\n' +
    '&lt;h3&gt;What you&amp;#39;ll do&lt;/h3&gt;\n' +
    '&lt;ul&gt;\n' +
    '&lt;li&gt;Own the &lt;a href=&quot;https://stripe.com/ai&quot;&gt;AI GTM strategy&lt;/a&gt;&lt;/li&gt;\n' +
    '&lt;li&gt;Partner with Product &amp;amp; Engineering&lt;/li&gt;\n' +
    '&lt;/ul&gt;\n' +
    '&lt;p&gt;Apply at &lt;a href=&quot;https://stripe.com/jobs/search?gh_jid=7954688&quot;&gt;our careers page&lt;/a&gt;.&lt;/p&gt;',
}

describe('greenhouse.fetch — html-to-text swap parity', () => {
  it('produces clean plain text: entities decoded once, tags stripped, no inline link URLs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ jobs: [REAL_GREENHOUSE_JOB] }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const jobs = await greenhouse.fetch('stripe')
    expect(jobs).toHaveLength(1)
    const [job] = jobs

    // Call shape unchanged: title/url/location/postedAt still populated the
    // same way regardless of the description pipeline swap.
    expect(job.title).toBe('Account Executive, AI Sales (Grower)')
    expect(job.url).toBe('https://stripe.com/jobs/search?gh_jid=7954688')
    expect(job.externalId).toBe('https://stripe.com/jobs/search?gh_jid=7954688')
    expect(job.location).toBe('San Francisco, CA')
    expect(job.postedAt).toBe(new Date('2026-06-02T08:58:57-04:00').toISOString())

    expect(job.description).toBeTruthy()
    const description = job.description as string

    // No leftover markup — the entity double-encoding was correctly
    // unwound before parsing, so html-to-text actually saw real tags.
    expect(description).not.toMatch(/<[a-z][\s\S]*>/i)
    expect(description).not.toContain('&lt;')
    expect(description).not.toContain('&amp;')
    expect(description).not.toContain('&quot;')
    expect(description).not.toContain('&#39;')

    // Entities decoded to their real characters exactly once (not
    // left-over-escaped, and not double-decoded into mojibake).
    expect(description).toContain("Stripe is a financial infrastructure platform for businesses. Millions of companies use Stripe to accept payments & grow their revenue.")
    expect(description).toContain("What you'll do")
    expect(description).toContain('Partner with Product & Engineering')

    // Link hrefs are dropped — visible anchor text survives, raw URLs used
    // only as markup targets do not leak into the text.
    expect(description).toContain('Own the AI GTM strategy')
    expect(description).toContain('Apply at our careers page.')
    expect(description).not.toContain('https://stripe.com/ai')
    expect(description).not.toContain('[https://stripe.com/ai]')

    // Headings kept as-authored, not forced upper-case.
    expect(description).toContain('Who we are')
    expect(description).not.toContain('WHO WE ARE')
  })

  it('degrades to no description (not a thrown error) on a malformed content field', async () => {
    const malformed = { ...REAL_GREENHOUSE_JOB, content: 12345 as unknown as string }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ jobs: [malformed] }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const jobs = await greenhouse.fetch('stripe')
    expect(jobs).toHaveLength(1)
    expect(jobs[0].description).toBeUndefined()
    expect(jobs[0].title).toBe('Account Executive, AI Sales (Grower)')
  })

  it('omits description when content is an empty string, same as before', async () => {
    const noContent = { ...REAL_GREENHOUSE_JOB, content: '' }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ jobs: [noContent] }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const jobs = await greenhouse.fetch('stripe')
    expect(jobs[0].description).toBeUndefined()
  })

  it('skips jobs with no absolute_url, same as before', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ jobs: [{ ...REAL_GREENHOUSE_JOB, absolute_url: undefined }] })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const jobs = await greenhouse.fetch('stripe')
    expect(jobs).toHaveLength(0)
  })

  it('falls back to the EU host on a 404 from the primary API host', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('not found', { status: 404, statusText: 'Not Found' }))
      .mockResolvedValueOnce(jsonResponse({ jobs: [REAL_GREENHOUSE_JOB] }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const jobs = await greenhouse.fetch('stripe')
    expect(jobs).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const secondCallUrl = fetchMock.mock.calls[1][0] as string
    expect(String(secondCallUrl)).toContain('boards-api.eu.greenhouse.io')
  })
})
