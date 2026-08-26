import { afterEach, describe, expect, it, vi } from 'vitest'
import { personio } from './personio'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

function xmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/xml' } })
}

// Captured live from open.jobs.personio.de/xml on 2026-08-03 (two of the eight
// real sections kept verbatim, CDATA and inline styles intact). Two structural
// traps this fixture preserves:
//   - <name> is BOTH the position title and the label of every description
//     section, so a descendant selector would read the wrong one;
//   - <office> appears again nested inside <additionalOffices>.
const REAL_XML = `<?xml version="1.0" encoding="UTF-8"?>

<workzag-jobs>

<position>
    <id>2736779</id>
    <office>Head Office - Dublin</office>
    <additionalOffices>
        <office>Hybrid</office>
    </additionalOffices>
    <department>Buying and Merchandising</department>
    <recruitingCategory>Permanent Employee</recruitingCategory>
    <name>Buying Assistant (Production Team)</name>
    <jobDescriptions>
        <jobDescription>
            <name>Location</name>
            <value>
                <![CDATA[<span style="font-size:11pt;font-family:Lora, serif;color:#000000;">Head Office: Dublin, Harold's Cross. Hybrid working model.</span>]]>
            </value>
        </jobDescription>
        <jobDescription>
            <name>All Welcome Here Statement</name>
            <value>
                <![CDATA[<span style="font-size:11pt;">We believe diverse teammates, opinions and backgrounds generate a larger global impact. &amp;Open is an equal opportunity employer.</span>]]>
            </value>
        </jobDescription>
    </jobDescriptions>
    <employmentType>permanent</employmentType>
    <seniority>experienced</seniority>
    <schedule>full-time</schedule>
    <createdAt>2026-07-31T10:20:32+00:00</createdAt>
</position>

</workzag-jobs>`

// A real board whose postings carry no bodies at all — verified live against
// deskbird.jobs.personio.de, where every <jobDescriptions> is empty. That is
// the board's own data, not a parse failure, and it must not cost the posting.
const REAL_XML_NO_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
<position>
    <id>2595569</id>
    <subcompany>deskbird GmbH</subcompany>
    <office>Remote - Germany</office>
    <department>Marketing</department>
    <name>Demand Generation Manager – DACH (f/m/d)</name>
    <jobDescriptions></jobDescriptions>
    <employmentType>permanent</employmentType>
    <createdAt>2026-04-09T11:38:45+00:00</createdAt>
</position>
</workzag-jobs>`

describe('personio.detect', () => {
  it('reads the company slug off both the .de and .com board hosts', () => {
    expect(personio.detect({ careerUrl: 'https://open.jobs.personio.de/', domain: null })).toEqual({ token: 'open' })
    expect(personio.detect({ careerUrl: 'https://deskbird.jobs.personio.com/?language=en', domain: null })).toEqual({
      token: 'deskbird',
    })
    expect(personio.detect({ careerUrl: 'https://open.jobs.personio.de/job/2736779', domain: null })).toEqual({
      token: 'open',
    })
  })

  it('returns null for personio.de itself and other hosts', () => {
    expect(personio.detect({ careerUrl: 'https://www.personio.de/', domain: null })).toBeNull()
    expect(personio.detect({ careerUrl: 'https://jobs.personio.de/', domain: null })).toBeNull()
    expect(personio.detect({ careerUrl: 'https://boards.greenhouse.io/acme', domain: null })).toBeNull()
  })
})

describe('personio.fetch', () => {
  it('parses the real XML feed into normalised jobs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(xmlResponse(REAL_XML))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const jobs = await personio.fetch('open')

    expect(String(fetchMock.mock.calls[0][0])).toBe('https://open.jobs.personio.de/xml')
    // An unknown tenant answers 307; 'manual' makes that one request instead
    // of four retries of a "fetch failed" TypeError.
    expect((fetchMock.mock.calls[0][1] as RequestInit).redirect).toBe('manual')

    expect(jobs).toHaveLength(1)
    const [job] = jobs
    // The position's own <name>, not "Location"/"All Welcome Here Statement".
    expect(job.title).toBe('Buying Assistant (Production Team)')
    expect(job.url).toBe('https://open.jobs.personio.de/job/2736779')
    expect(job.externalId).toBe('https://open.jobs.personio.de/job/2736779')
    // The nested <additionalOffices><office> is folded in, once.
    expect(job.location).toBe('Head Office - Dublin · Hybrid')
    expect(job.postedAt).toBe('2026-07-31T10:20:32.000Z')

    const description = job.description as string
    // Section labels are kept as headings above their own body.
    expect(description).toContain('Location')
    expect(description).toContain("Head Office: Dublin, Harold's Cross. Hybrid working model.")
    expect(description).toContain('All Welcome Here Statement')
    expect(description).toContain('&Open is an equal opportunity employer.')
    // CDATA markup is parsed, not emitted; inline styles do not leak.
    expect(description).not.toMatch(/<[a-z]/i)
    expect(description).not.toContain('font-family')
    expect(description).not.toContain('CDATA')
  })

  it('keeps a posting whose board publishes no body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(xmlResponse(REAL_XML_NO_BODY)) as unknown as typeof fetch

    const jobs = await personio.fetch('deskbird')

    expect(jobs).toHaveLength(1)
    expect(jobs[0].title).toBe('Demand Generation Manager – DACH (f/m/d)')
    expect(jobs[0].url).toBe('https://deskbird.jobs.personio.de/job/2595569')
    expect(jobs[0].location).toBe('Remote - Germany')
    expect(jobs[0].description).toBeUndefined()
  })

  it('returns an empty board rather than throwing when the tenant has no jobs', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(xmlResponse('<?xml version="1.0" encoding="UTF-8"?>\n<workzag-jobs>\n\n</workzag-jobs>')) as unknown as typeof fetch
    await expect(personio.fetch('moss')).resolves.toEqual([])
  })

  it('surfaces the 307 an unknown tenant answers with as a plain HttpError', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(null, { status: 307, statusText: 'Temporary Redirect', headers: { location: 'https://personio.com' } })
    ) as unknown as typeof fetch

    await expect(personio.fetch('zzqxnotacompany')).rejects.toMatchObject({ status: 307 })
    // A permanent-by-classification status: one attempt, no retries.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects a slug that would leave the personio.de domain before any request', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await expect(personio.fetch('evil.com/x')).rejects.toThrow(/invalid company slug/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
