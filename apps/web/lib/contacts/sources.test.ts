// Regression tests for contact extraction.
//
// Every string below is a real (lightly trimmed) fragment taken from this
// workspace's own job-posting and company-page corpus while diagnosing the
// "Find contacts finds nothing" report. The corpus is the point: the first
// version of this extractor produced 71 candidates across 1,000 postings of
// which roughly five were actual human beings — the rest were phrases like
// "Computer Science", "Data Architecture", "As Manager" and "I'm Allie", and
// one of those was persisted into the contacts table as a real row. These
// tests pin BOTH directions: the real people must keep coming through, and
// every one of those false positives must stay out.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Fresh-vs-stale KB read: readFreshCompanyPages defaults to null (cache miss)
// so every existing test below — all of which pass fetchSite: false anyway —
// is unaffected. fetchCompanyContactPages is the real live-fetch entry point;
// mocked here purely so the "fresh cache -> zero network calls" test can
// assert it was never reached, with normalizeDomain (and everything else)
// left as the real implementation.
vi.mock('@/lib/kb/ingest', () => ({ readFreshCompanyPages: vi.fn(async () => null) }))
vi.mock('@/lib/dossier/sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dossier/sources')>()
  return { ...actual, fetchCompanyContactPages: vi.fn(async () => []) }
})

import { readFreshCompanyPages } from '@/lib/kb/ingest'
import { fetchCompanyContactPages } from '@/lib/dossier/sources'
import {
  extractPostingCandidates,
  extractSiteCandidates,
  extractDossierCandidates,
  sourceContactsForCompany,
} from './sources'

const names = (text: string, domain: string | null = null) =>
  extractPostingCandidates(text, domain)
    .map((c) => c.name)
    .filter((n): n is string => !!n)

describe('extractPostingCandidates — real people', () => {
  it('finds a name introduced with an explicit role', () => {
    expect(names('Our team is led by Rob Cherry, VP of Engineering, who joined last year.')).toContain('Rob Cherry')
  })

  it('keeps an honorific attached without spending a name slot', () => {
    expect(names('The company was founded by Dr Ben Warner in 2021.')).toContain('Dr Ben Warner')
  })

  it("handles a recruiter's first-person self-introduction", () => {
    // Used to be captured as the literal contact name "I'm Allie".
    const out = extractPostingCandidates("Hi, I'm Allie, Head of Support at Ashby. I'd love to hear from you.", null)
    expect(out.map((c) => c.name)).toContain('Allie')
    expect(out.map((c) => c.name)).not.toContain("I'm Allie")
    expect(out.find((c) => c.name === 'Allie')?.title).toBe('Head of Support at Ashby')
  })

  it('names the recruiter for the role', () => {
    expect(names('The recruiter for this role is Dina Hussain.\n\nLocation: Remote')).toEqual(['Dina Hussain'])
  })

  it('does not let a line break glue an unrelated word onto a name', () => {
    expect(names('The recruiter is Dina Hussain\n\nLocation: Remote')).not.toContain('Dina Hussain Location')
  })
})

describe('extractPostingCandidates — refuses to invent people', () => {
  const rejected: [string, string][] = [
    ['a degree list', 'BS in Computer Science, Engineering, or a related technical field.'],
    ['an experience list', 'Experience in Data Architecture, Data Engineering, and analytics.'],
    ['a role restated as a subject', 'As Manager, Forward Deployed Engineering, you will own delivery.'],
    ['the posting’s own title', 'Senior Software Engineer, AI Native Web Platform on the Web Engineering team.'],
    ['an audience, not a person', 'You will sell to Chief Technology Officers, Engineering/IT Leaders across the region.'],
    ['an HTML entity artifact', 'Third Party Payroll Integration, Talent &amp; People systems experience.'],
    ['a field of study', 'A background in Spatial Planning, Transportation Engineering is a plus.'],
    ['a plural job family', 'We are hiring Account Executives, Sales Leaders and more.'],
    ['a press-release headline', 'Distyl AI, founded by Ex-Palantir, Raises $20M Series A.'],
  ]
  for (const [label, text] of rejected) {
    it(`rejects ${label}`, () => {
      expect(extractPostingCandidates(text, null)).toEqual([])
    })
  }
})

describe('extractPostingCandidates — published addresses', () => {
  it('takes an address on the company domain at full confidence', () => {
    const out = extractPostingCandidates('Questions? Email amber.auslander@matterhaul.com.', 'matterhaul.com')
    expect(out[0].email).toBe('amber.auslander@matterhaul.com')
    expect(out[0].name).toBe('Amber Auslander')
    expect(out[0].verified).toBe(false)
    expect(out[0].confidence).toBeGreaterThan(0.5)
  })

  it('accepts a subdomain of the company domain', () => {
    const out = extractPostingCandidates('Write to careers@jobs.acme.com', 'acme.com')
    expect(out.map((c) => c.email)).toContain('careers@jobs.acme.com')
  })

  it('still surfaces an address when the company has NO domain on file, but says so', () => {
    // 42% of company rows here have domain = NULL. Refusing to look was the
    // old behaviour and it is why the button found nothing.
    const out = extractPostingCandidates('Apply by writing to Talent@grove.co today.', null)
    expect(out[0].email).toBe('talent@grove.co')
    expect(out[0].basis).toMatch(/could NOT confirm/i)
    expect(out[0].confidence).toBeLessThanOrEqual(0.35)
  })

  it('never attributes a third-party address to a company with a known domain', () => {
    expect(extractPostingCandidates('Sourced via recruiter@someagency.com', 'acme.com')).toEqual([])
  })

  it('drops aggregator / ATS / consumer-mail hosts even with no company domain', () => {
    expect(extractPostingCandidates('Reply to careers@ashbyhq.com', null)).toEqual([])
    expect(extractPostingCandidates('Reply to talent@gmail.com', null)).toEqual([])
  })

  it('drops non-recruiting role aliases', () => {
    expect(extractPostingCandidates('Accessibility requests: accommodations@acme.com', 'acme.com')).toEqual([])
  })

  it('rejects a malformed address that the loose regex admits', () => {
    // looksLikeEmail (lib/contacts/parse-csv.ts) is the shared shape gate.
    expect(extractPostingCandidates('mail jane.doe@acme', 'acme.com')).toEqual([])
  })
})

describe('extractSiteCandidates', () => {
  it('cites the page an address was read from', () => {
    const out = extractSiteCandidates(
      { url: 'https://doist.com/careers', text: 'Get in touch: careers@doist.com' },
      'doist.com'
    )
    expect(out[0].email).toBe('careers@doist.com')
    expect(out[0].source).toBe('site')
    expect(out[0].sourceUrl).toBe('https://doist.com/careers')
    expect(out[0].basis).toContain('https://doist.com/careers')
  })
})

describe('extractDossierCandidates', () => {
  it('reads news headlines and raw signal text, not just the summary', () => {
    const out = extractDossierCandidates({
      summary: null,
      sourceTitles: ['A statement from Dario Amodei on model releases'],
      rawText: ['Founded by Patrick Collison, the company processes payments.'],
    })
    expect(out.map((c) => c.name).sort()).toEqual(['Dario Amodei', 'Patrick Collison'])
  })
})

// --- The orchestrator's honest empty state ---------------------------------
//
// `fetchSite: false` throughout: these assert the REPORTING contract, and a
// unit test must not depend on somebody's marketing site being up.

interface FakeTables {
  companies?: Record<string, unknown>[]
  jobs?: Record<string, unknown>[]
  company_dossiers?: Record<string, unknown>[]
  contacts?: Record<string, unknown>[]
}

function fakeClient(rows: FakeTables, inserted: Record<string, unknown>[] = []) {
  const build = (table: keyof FakeTables) => {
    const filters: Record<string, unknown> = {}
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (k: string, v: unknown) => {
        filters[k] = v
        return api
      },
      ilike: () => api,
      order: () => api,
      limit: () => Promise.resolve({ data: rows[table] ?? [], error: null }),
      maybeSingle: () =>
        Promise.resolve({
          data: (rows[table] ?? []).find((r) => Object.entries(filters).every(([k, v]) => r[k] === v)) ?? null,
          error: null,
        }),
      single: () => Promise.resolve({ data: (rows[table] ?? [])[0] ?? null, error: null }),
      insert: (row: Record<string, unknown>) => ({
        select: () => ({
          single: () => {
            inserted.push(row)
            return Promise.resolve({ data: { id: `id-${inserted.length}`, name: row.name, email: row.email }, error: null })
          },
        }),
      }),
      then: (res: (v: unknown) => unknown) => Promise.resolve({ data: rows[table] ?? [], error: null }).then(res),
    }
    return api
  }
  return { from: (t: string) => build(t as keyof FakeTables) } as never
}

const call = (rows: FakeTables, inserted: Record<string, unknown>[] = []) =>
  sourceContactsForCompany({
    client: fakeClient(rows, inserted),
    userId: 'u1',
    companyId: 'c1',
    jobId: 'j1',
    fetchSite: false,
  })

describe('sourceContactsForCompany — the report is never a bare "nothing usable"', () => {
  const barren: FakeTables = {
    companies: [{ id: 'c1', name: 'Atolls', domain: null, user_id: 'u1' }],
    jobs: [{ id: 'j1', description: null, url: null, company_id: 'c1' }],
    company_dossiers: [],
    contacts: [],
  }

  it('names every source it consulted or skipped, and why', async () => {
    const res = await call(barren)
    expect(res.inserted).toEqual([])
    const keys = res.search.steps.map((s) => s.key).sort()
    expect(keys).toEqual(['apollo', 'dossier', 'existing', 'hunter', 'pattern', 'posting', 'site'].sort())
    // The whole point: nothing is allowed to come back unexplained.
    for (const step of res.search.steps) expect(step.detail.length).toBeGreaterThan(10)
    expect(res.search.headline).toMatch(/no posting body stored/i)
    expect(res.search.headline).toMatch(/no dossier for this company yet/i)
    expect(res.search.headline).toMatch(/no employer domain on file/i)
    expect(res.search.headline).not.toMatch(/nothing usable/i)
  })

  it('says the company row has no usable domain rather than silently doing nothing', async () => {
    const res = await call(barren)
    expect(res.domain).toBeNull()
    expect(res.search.domainBasis).toMatch(/no employer domain on file/i)
  })

  it('refuses an aggregator host masquerading as the company domain', async () => {
    const res = await call({
      ...barren,
      companies: [{ id: 'c1', name: 'Capital One', domain: 'themuse.com', user_id: 'u1' }],
    })
    expect(res.domain).toBeNull()
  })

  it('keeps a vendor domain when the company genuinely is that vendor', async () => {
    const res = await call({
      ...barren,
      companies: [{ id: 'c1', name: 'Ashby', domain: 'ashbyhq.com', user_id: 'u1' }],
    })
    expect(res.domain).toBe('ashbyhq.com')
  })

  it('recovers the domain from the dossier’s verified official-site source', async () => {
    const res = await call({
      ...barren,
      companies: [{ id: 'c1', name: 'Distyl', domain: null, user_id: 'u1' }],
      company_dossiers: [
        {
          id: 'd1',
          company_id: 'c1',
          user_id: 'u1',
          summary: null,
          signals: {},
          sources: [{ url: 'https://distyl.ai', title: 'Distyl — official site', matchedBy: 'official-site' }],
        },
      ],
    })
    expect(res.domain).toBe('distyl.ai')
    expect(res.search.domainBasis).toContain('distyl.ai')
  })

  it('recovers the domain from the posting URL when nothing else has one', async () => {
    const res = await call({
      ...barren,
      jobs: [{ id: 'j1', description: null, url: 'https://careers.acme.com/jobs/1', company_id: 'c1' }],
    })
    expect(res.domain).toBe('careers.acme.com')
    expect(res.search.domainBasis).toMatch(/posting/i)
  })

  it('persists an inferred pattern address as inferred, and never as a bare first name', async () => {
    const inserted: Record<string, unknown>[] = []
    const res = await call(
      {
        companies: [{ id: 'c1', name: 'Acme', domain: 'acme.com', user_id: 'u1' }],
        jobs: [{ id: 'j1', description: 'You will report to Jane Roberts, Head of Engineering.', url: null, company_id: 'c1' }],
        company_dossiers: [],
        contacts: [{ id: 'x1', name: 'Sam Patel', email: 'sam.patel@acme.com', title: null }],
      },
      inserted
    )
    const guessed = res.candidates.find((c) => c.source === 'pattern')
    expect(guessed?.email).toBe('jane.roberts@acme.com')
    expect(guessed?.emailInferred).toBe(true)
    expect(guessed?.verified).toBe(false)
    expect(guessed?.basis).toMatch(/INFERRED, NOT VERIFIED/)
    expect(inserted[0].name).toBe('Jane Roberts')
  })

  it('names a role inbox with the whole address so it cannot read as a person', async () => {
    const inserted: Record<string, unknown>[] = []
    await call(
      {
        companies: [{ id: 'c1', name: 'Doist', domain: 'doist.com', user_id: 'u1' }],
        jobs: [{ id: 'j1', description: 'Questions? Write to careers@doist.com.', url: null, company_id: 'c1' }],
        company_dossiers: [],
        contacts: [],
      },
      inserted
    )
    expect(inserted[0].name).toBe('careers@doist.com')
  })
})

// ---------------------------------------------------------------------------
// Regression: a person attributed to the WRONG employer.
//
// An adversarial review of the contact-sourcing change found that
// NAME_THEN_TITLE_RE matched "Dax Dasilva, Founder and CEO, Lightspeed" on a
// page belonging to a different company and yielded a contact attributed to
// the PAGE's company — which the caller then turns into a synthesized address
// at that company's domain. A real person's name paired with an employer they
// have never worked for, one click from an outreach email, is the single worst
// output this module can produce. These pin the guard that drops it.
// ---------------------------------------------------------------------------
describe('name/title extraction never attributes a person to the wrong employer', () => {
  it('drops "Name, Title, OtherCompany" rather than claiming them for this page', () => {
    const text =
      'We are proud to work with partners across the industry. ' +
      'Dax Dasilva, Founder and CEO, Lightspeed, spoke at our conference last year.'
    const found = extractSiteCandidates({ url: 'https://stripe.com/about', text }, 'stripe.com')
    expect(found.map((c) => c.name)).not.toContain('Dax Dasilva')
  })

  // The guard above keys on "Name, Title, <Capitalised>", which a LOCATION also
  // matches ("…, Head of Platform, Berlin"). That case is deliberately NOT
  // rejected: on a company's own team page the person really does work there,
  // and this text reaches us through a keyword-anchored extractor ("led by")
  // rather than the bare Name-Title pattern the guard sits on.
  //
  // Recorded rather than fixed, because the distinction that matters is not
  // "is the trailing token a place or a company" — it is whether the person is
  // relevant to THIS role at all, which is what the relevance scoring handles.
  it('keeps a person on the company own team page despite a trailing location', () => {
    const text = 'Our team is led by Marcus Webb, Head of Platform, Berlin.'
    const found = extractSiteCandidates({ url: 'https://acme.com/team', text }, 'acme.com')
    expect(found.map((c) => c.name)).toContain('Marcus Webb')
  })

  it('still accepts a plain "Name, Title" with a sentence continuation', () => {
    const text = 'Priya Raman, Head of Engineering, joined us in 2020 and leads the platform team.'
    const found = extractSiteCandidates({ url: 'https://acme.com/team', text }, 'acme.com')
    expect(found.map((c) => c.name)).toContain('Priya Raman')
  })

  it('still accepts "Name, Title." terminated by a full stop', () => {
    const text = 'Questions about the role? Reach out to Sarah Chen, Director of Talent.'
    const found = extractSiteCandidates({ url: 'https://acme.com/careers', text }, 'acme.com')
    expect(found.map((c) => c.name)).toContain('Sarah Chen')
  })
})

// ---------------------------------------------------------------------------
// A fresh KB cache (a prior company_researcher run) must skip the live site
// fetch entirely — the whole point of lib/kb/ingest.ts#readFreshCompanyPages.
// A stale/absent cache must fall back to it exactly as before.
// ---------------------------------------------------------------------------
describe('sourceContactsForCompany — reads stored company pages before fetching', () => {
  const withDomain: FakeTables = {
    companies: [{ id: 'c1', name: 'Acme', domain: 'acme.com', user_id: 'u1' }],
    jobs: [{ id: 'j1', description: null, url: null, company_id: 'c1' }],
    company_dossiers: [],
    contacts: [],
  }

  beforeEach(() => {
    vi.mocked(readFreshCompanyPages).mockReset()
    vi.mocked(fetchCompanyContactPages).mockReset()
    vi.mocked(fetchCompanyContactPages).mockResolvedValue([])
  })

  it('a fresh cache is used and fetchCompanyContactPages is never called', async () => {
    vi.mocked(readFreshCompanyPages).mockResolvedValueOnce([
      { url: 'https://acme.com', text: 'Welcome to Acme. Questions? careers@acme.com.' },
    ])

    const res = await sourceContactsForCompany({
      client: fakeClient(withDomain),
      userId: 'u1',
      companyId: 'c1',
      jobId: 'j1',
      fetchSite: true,
    })

    expect(fetchCompanyContactPages).not.toHaveBeenCalled()
    expect(res.candidates.some((c) => c.email === 'careers@acme.com')).toBe(true)
    const siteStep = res.search.steps.find((s) => s.key === 'site')
    expect(siteStep?.status).toBe('found')
    expect(siteStep?.scanned).toMatch(/from stored research, no fetch/)
  })

  it('a stale/absent cache falls back to a live fetch', async () => {
    vi.mocked(readFreshCompanyPages).mockResolvedValueOnce(null)
    vi.mocked(fetchCompanyContactPages).mockResolvedValueOnce([
      { url: 'https://acme.com', text: 'Welcome to Acme.' },
    ])

    const res = await sourceContactsForCompany({
      client: fakeClient(withDomain),
      userId: 'u1',
      companyId: 'c1',
      jobId: 'j1',
      fetchSite: true,
    })

    expect(fetchCompanyContactPages).toHaveBeenCalledWith('acme.com')
    const siteStep = res.search.steps.find((s) => s.key === 'site')
    expect(siteStep?.scanned).not.toMatch(/from stored research/)
  })
})
