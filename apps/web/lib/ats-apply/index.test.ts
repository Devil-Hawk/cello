// Tests for lib/ats-apply/index.ts's submitApplication — the code path that
// actually submits to a real employer. ZERO network: global.fetch is mocked
// (never actually reaches boards-api.greenhouse.io etc). ZERO real DB: the
// resume_documents lookup client is an in-memory fake.
//
// Covers the three consequential behaviors named for this workflow:
//   1. An unsupported posting URL always produces a HANDOFF, never a blind POST.
//   2. resolveResumeFullText (private, exercised through submitApplication)
//      prefers the tailored resume_documents row over the resumeSummary blurb.
//   3. Sensitive fields (visa/EEO/salary/work-authorization) are never
//      auto-answered — neither leaked into buildHandoffFields output, nor
//      auto-submitted when the JD raises a knock-out question.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubmitAuthorization } from './types'
import { submitApplication } from './index'
import { buildHandoffFields, DEFERRED_FIELD_LABELS } from './fields'
import type { ApplyContent, ApplyProfile } from './types'
import type { SupabaseClient } from '@supabase/supabase-js'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const PROFILE: ApplyProfile = {
  firstName: 'Ann',
  lastName: 'Lee',
  fullName: 'Ann Lee',
  email: 'ann@example.com',
}

// --- fake resume_documents client -------------------------------------------
// Minimal in-memory fake of the exact chain lib/resume/store.ts's
// getLatestVersion uses: .from('resume_documents').select('*').eq('user_id',
// ..).eq('job_id', ..)|.is('job_id', null).order().limit(1).maybeSingle().

interface FakeDoc {
  id: string
  user_id: string
  job_id: string | null
  version: number
  content: string
}

function fakeResumeClient(docs: FakeDoc[]): SupabaseClient {
  const client = {
    from(_table: string) {
      let rows = [...docs]
      const builder = {
        select(_cols: string) {
          return builder
        },
        eq(col: string, val: unknown) {
          rows = rows.filter((r) => (r as unknown as Record<string, unknown>)[col] === val)
          return builder
        },
        is(col: string, val: unknown) {
          rows = rows.filter((r) => (r as unknown as Record<string, unknown>)[col] === val)
          return builder
        },
        order(_col: string, _opts?: unknown) {
          rows = [...rows].sort((a, b) => b.version - a.version)
          return builder
        },
        limit(n: number) {
          rows = rows.slice(0, n)
          return builder
        },
        async maybeSingle() {
          return { data: rows[0] ?? null, error: null }
        },
      }
      return builder
    },
  }
  return client as unknown as SupabaseClient
}

/** The submit POST, not the boards-api schema read that now precedes it. */
// Typed structurally rather than as ReturnType<typeof vi.fn>, which resolves to
// Mock<any[], unknown>. A mock declared with explicit generics — e.g.
// vi.fn<[input: unknown], Promise<Response>>() — is NOT assignable to that, so
// the narrower the caller's mock, the louder this helper complained. All it
// actually needs is the call log.
function submitCall(mock: { mock: { calls: unknown[][] } }): [string, RequestInit] {
  // Filter on METHOD, not host: Greenhouse's submit endpoint lives on
  // boards-api.greenhouse.io too, so a host filter excludes the very POST it
  // is meant to find. Only the schema read is a GET.
  const call = mock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST')
  if (!call) throw new Error('no submit POST was made')
  return call as [string, RequestInit]
}

/**
 * A fetch mock that answers BOTH calls a submission now makes.
 *
 * capability.ts reads the posting's public application form before allowing a
 * POST, because "greenhouse accepts applications that are missing required
 * answers without complaining — so sending one blind could put a half-finished
 * application in your name". A mock that returns the same submit response to
 * every URL leaves that schema unreadable, which correctly forces a handoff and
 * hides the resume-attachment behaviour these tests exist to check.
 *
 * So: serve a real-shaped, fully answerable form schema for the boards-api
 * read, and the submit response for the POST.
 */
function fetchMockWithForm() {
  return vi.fn(async (input: unknown) => {
    const url = String(typeof input === 'string' ? input : (input as Request)?.url ?? '')
    if (url.includes('boards-api.greenhouse.io')) {
      return jsonResponse({
        id: 1234567,
        questions: [
          { label: 'First Name', required: true, fields: [{ name: 'first_name', type: 'input_text' }] },
          { label: 'Last Name', required: true, fields: [{ name: 'last_name', type: 'input_text' }] },
          { label: 'Email', required: true, fields: [{ name: 'email', type: 'input_text' }] },
          { label: 'Resume', required: true, fields: [{ name: 'resume', type: 'input_file' }] },
        ],
        data_compliance: [],
        demographic_questions: null,
      })
    }
    return jsonResponse({ id: 999 })
  })
}

/**
 * The per-job human confirmation submitApplication now requires.
 *
 * lib/ats-apply/capability.ts added an explicit human gate — "no amount of
 * readiness anywhere else may stand in for a person saying yes" — so a valid
 * employer credential is no longer sufficient on its own. The tests below
 * exercise RESUME ATTACHMENT, not the gate, so they supply a real confirmation
 * rather than asserting the looser pre-gate behaviour. The gate itself is
 * covered by capability.test.ts; weakening these assertions to 'handoff' would
 * have hidden the resume-resolution logic entirely.
 */
function humanOk(jobIds: string[]): SubmitAuthorization {
  return {
    confirmed: true,
    source: 'human-approval-route',
    at: new Date().toISOString(),
    jobIds,
  }
}

describe('submitApplication — unsupported URL always produces HANDOFF, never a blind POST', () => {
  it('an ordinary company career-page URL (not Greenhouse/Lever/Ashby) is a handoff with no ATS attempt', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await submitApplication({
      jobUrl: 'https://example.com/careers/senior-engineer',
      profile: PROFILE,
      content: { resumeSummary: 'Backend engineer.' },
      credentials: { greenhouse: 'some-key', lever: 'some-key', ashby: 'some-key' }, // even WITH credentials configured
    })

    expect(result.outcome).toBe('handoff')
    expect(result).toMatchObject({ provider: null, fields: [] })
    if (result.outcome === 'handoff') {
      expect(result.reason).toMatch(/not a recognized official ATS/i)
      expect(result.prefilledUrl).toBe('https://example.com/careers/senior-engineer')
    }
    // No network call was ever attempted — never a blind POST to an unknown target.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a malformed URL also degrades to handoff rather than throwing', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await submitApplication({
      jobUrl: 'not a url',
      profile: PROFILE,
      content: {},
    })
    expect(result.outcome).toBe('handoff')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('missing credentials for an otherwise-recognized ATS also falls back to handoff, never submits', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await submitApplication({
      jobUrl: 'https://boards.greenhouse.io/acme/jobs/1234567',
      profile: PROFILE,
      content: { resumeSummary: 'Backend engineer.' },
      // no credentials at all
    })
    expect(result.outcome).toBe('handoff')
    if (result.outcome === 'handoff') {
      expect(result.provider).toBe('greenhouse')
      expect(result.reason).toMatch(/no official ats apply credential/i)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('submitApplication — resolveResumeFullText prefers the tailored resume over the summary blurb', () => {
  it('attaches the tailored resume_documents content, not the cv_tailor summary blurb', async () => {
    const fetchMock = fetchMockWithForm()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = fakeResumeClient([
      { id: 'doc-base', user_id: 'user-1', job_id: null, version: 1, content: 'BASE RESUME — generic.' },
      { id: 'doc-tailored', user_id: 'user-1', job_id: 'job-123', version: 1, content: 'TAILORED RESUME — for this exact job.' },
    ])

    const result = await submitApplication({
      jobUrl: 'https://boards.greenhouse.io/acme/jobs/1234567',
      profile: PROFILE,
      content: { resumeSummary: 'A 2-4 sentence blurb, not a resume.' }, // no resumeFullText preset
      credentials: { greenhouse: 'api-key' },
      client,
      userId: 'user-1',
      jobId: 'job-123',
      authorization: humanOk(['job-123']),
    })

    expect(result.outcome).toBe('submitted')
    expect(submitCall(fetchMock)).toBeTruthy()
    const [, init] = submitCall(fetchMock)
    const sentBody = JSON.parse(String(init.body)) as { resume_content?: string }
    const decoded = Buffer.from(sentBody.resume_content ?? '', 'base64').toString('utf-8')

    expect(decoded).toBe('TAILORED RESUME — for this exact job.')
    expect(decoded).not.toContain('blurb')
    expect(decoded).not.toContain('BASE RESUME')
  })

  it('falls back to the BASE resume version when no tailored version exists for this job', async () => {
    const fetchMock = fetchMockWithForm()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = fakeResumeClient([
      { id: 'doc-base', user_id: 'user-1', job_id: null, version: 1, content: 'BASE RESUME — generic.' },
    ])

    const result = await submitApplication({
      jobUrl: 'https://boards.greenhouse.io/acme/jobs/1234567',
      profile: PROFILE,
      content: { resumeSummary: 'A short blurb.' },
      credentials: { greenhouse: 'api-key' },
      client,
      userId: 'user-1',
      jobId: 'job-456', // no tailored doc under this job id
      // Supplied for the same reason its sibling tests supply it: the human
      // gate is now required for ANY submit, and this test's subject is résumé
      // RESOLUTION, not the gate. Without it submitApplication correctly
      // returns 'handoff' and the base-résumé fallback below is never exercised.
      // The gate itself is covered by capability.test.ts — asserting 'handoff'
      // here instead would have silently deleted this test's actual coverage.
      authorization: humanOk(['job-456']),
    })

    expect(result.outcome).toBe('submitted')
    const [, init] = submitCall(fetchMock)
    const sentBody = JSON.parse(String(init.body)) as { resume_content?: string }
    const decoded = Buffer.from(sentBody.resume_content ?? '', 'base64').toString('utf-8')
    expect(decoded).toBe('BASE RESUME — generic.')
  })

  it('an already-set resumeFullText on content is never overwritten by the DB lookup', async () => {
    const fetchMock = fetchMockWithForm()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = fakeResumeClient([
      { id: 'doc-tailored', user_id: 'user-1', job_id: 'job-123', version: 1, content: 'DB TAILORED TEXT' },
    ])

    const result = await submitApplication({
      jobUrl: 'https://boards.greenhouse.io/acme/jobs/1234567',
      profile: PROFILE,
      content: { resumeFullText: 'CALLER-SUPPLIED FULL TEXT', resumeSummary: 'blurb' },
      credentials: { greenhouse: 'api-key' },
      client,
      userId: 'user-1',
      jobId: 'job-123',
      authorization: humanOk(['job-123']),
    })
    expect(result.outcome).toBe('submitted')
    const [, init] = submitCall(fetchMock)
    const sentBody = JSON.parse(String(init.body)) as { resume_content?: string }
    const decoded = Buffer.from(sentBody.resume_content ?? '', 'base64').toString('utf-8')
    expect(decoded).toBe('CALLER-SUPPLIED FULL TEXT')
  })

  // WHY THIS ASSERTS handoff, NOT "graceful degradation".
  //
  // This test previously expected the lookup failure to fall through to
  // `resumeSummary` and submit anyway. But resumeSummary is the 2-4 sentence
  // blurb cv_tailor writes for internal use — the fixture two tests above says
  // so in its own words, and another asserts the blurb must NEVER be what gets
  // sent. So "degrading gracefully" meant putting a two-sentence summary in
  // front of a real employer, as the candidate's résumé, under their name,
  // with no way to recall it once Greenhouse accepted it.
  //
  // The distinction that matters is FAILED vs ABSENT. A user with no stored
  // résumé is a known state the capability assessment already reports. A lookup
  // that THREW tells us nothing about what exists, and an irreversible action
  // taken on an unknown is the one trade never worth making.
  //
  // The cost of failing closed — that applications stop during an outage — is
  // paid by the review queue and its notifications, which is where every
  // handoff surfaces for the human. Silence is the thing to avoid here, not
  // refusal.
  it('a resume_documents lookup failure hands off rather than sending the summary blurb as a résumé', async () => {
    const fetchMock = fetchMockWithForm()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const throwingClient = {
      from() {
        throw new Error('simulated resume_documents outage')
      },
    } as unknown as SupabaseClient

    const result = await submitApplication({
      jobUrl: 'https://boards.greenhouse.io/acme/jobs/1234567',
      profile: PROFILE, // no resumeText — the blurb is the ONLY fallback available
      content: { resumeSummary: 'Fallback summary blurb.' },
      credentials: { greenhouse: 'api-key' },
      client: throwingClient,
      userId: 'user-1',
      jobId: 'job-123',
      authorization: humanOk(['job-123']),
    })

    expect(result.outcome).toBe('handoff')
    // The load-bearing assertion: nothing was sent at all.
    // Read structurally: fetchMockWithForm's mock is declared with a one-arg
    // signature, so `calls` is a 1-tuple and destructuring `[, init]` does not
    // typecheck against it.
    const postedToEmployer = (fetchMock.mock.calls as unknown[][]).some(
      (call) => (call[1] as RequestInit | undefined)?.method === 'POST'
    )
    expect(
      postedToEmployer,
      'a résumé lookup failure must never result in a POST to an employer'
    ).toBe(false)
    consoleSpy.mockRestore()
  })
})

describe('submitApplication — sensitive fields are never auto-answered', () => {
  it('a JD knock-out question (visa sponsorship) forces handoff even with a valid credential configured', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await submitApplication({
      jobUrl: 'https://boards.greenhouse.io/acme/jobs/1234567',
      profile: PROFILE,
      content: { resumeSummary: 'Backend engineer with 5 years experience.' },
      credentials: { greenhouse: 'api-key' },
      jobDescription: 'Must be authorized to work in the US; we do not offer visa sponsorship.',
    })

    expect(result.outcome).toBe('handoff')
    if (result.outcome === 'handoff') {
      expect(result.reason).toMatch(/visa\/sponsorship/i)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a JD knock-out question (salary expectation) also forces handoff', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await submitApplication({
      jobUrl: 'https://boards.greenhouse.io/acme/jobs/1234567',
      profile: PROFILE,
      content: { resumeSummary: 'Backend engineer.' },
      credentials: { greenhouse: 'api-key' },
      jobDescription: 'Please include your salary expectation in your application.',
    })
    expect(result.outcome).toBe('handoff')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a JD knock-out question (EEO/demographic) also forces handoff', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await submitApplication({
      jobUrl: 'https://boards.greenhouse.io/acme/jobs/1234567',
      profile: PROFILE,
      content: { resumeSummary: 'Backend engineer.' },
      credentials: { greenhouse: 'api-key' },
      jobDescription: 'Voluntary self-identification: please indicate your gender and veteran status.',
    })
    expect(result.outcome).toBe('handoff')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('buildHandoffFields never emits a visa/EEO/salary/work-authorization field, no matter what extra properties are smuggled onto profile/content', () => {
    // Attempt to smuggle sensitive answers in via excess properties an
    // upstream caller might mistakenly attach — buildHandoffFields only ever
    // reads the fixed identity/link fields it explicitly destructures, so
    // this proves there is no back door for these to leak through.
    const dirtyProfile = {
      ...PROFILE,
      visaStatus: 'H1B',
      workAuthorization: 'authorized',
      eeoGender: 'declined',
      salaryExpectation: '200000',
    } as unknown as ApplyProfile
    const dirtyContent = {
      resumeSummary: 'blurb',
      visaSponsorshipRequired: true,
      salaryExpectation: 250000,
    } as unknown as ApplyContent

    for (const provider of ['greenhouse', 'lever', 'ashby'] as const) {
      const fields = buildHandoffFields(provider, dirtyProfile, dirtyContent)
      const serialized = JSON.stringify(fields).toLowerCase()
      expect(serialized).not.toMatch(/visa/)
      expect(serialized).not.toMatch(/sponsorship/)
      expect(serialized).not.toMatch(/salary/)
      expect(serialized).not.toMatch(/h1b/)
      expect(serialized).not.toMatch(/eeo/)
      expect(serialized).not.toMatch(/work.?authoriz/)
      expect(serialized).not.toMatch(/gender/)
    }
  })

  it('DEFERRED_FIELD_LABELS documents every sensitive category as deferred to the human', () => {
    const joined = DEFERRED_FIELD_LABELS.join(' | ').toLowerCase()
    expect(joined).toMatch(/work authorization|visa sponsorship/)
    expect(joined).toMatch(/demographic|eeo/)
    expect(joined).toMatch(/disability|veteran/)
    expect(joined).toMatch(/salary/)
  })
})
