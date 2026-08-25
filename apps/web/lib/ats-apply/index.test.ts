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
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 999 }))
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
    })

    expect(result.outcome).toBe('submitted')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const sentBody = JSON.parse(String(init.body)) as { resume_content?: string }
    const decoded = Buffer.from(sentBody.resume_content ?? '', 'base64').toString('utf-8')

    expect(decoded).toBe('TAILORED RESUME — for this exact job.')
    expect(decoded).not.toContain('blurb')
    expect(decoded).not.toContain('BASE RESUME')
  })

  it('falls back to the BASE resume version when no tailored version exists for this job', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 1000 }))
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
    })

    expect(result.outcome).toBe('submitted')
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const sentBody = JSON.parse(String(init.body)) as { resume_content?: string }
    const decoded = Buffer.from(sentBody.resume_content ?? '', 'base64').toString('utf-8')
    expect(decoded).toBe('BASE RESUME — generic.')
  })

  it('an already-set resumeFullText on content is never overwritten by the DB lookup', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 1 }))
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
    })
    expect(result.outcome).toBe('submitted')
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const sentBody = JSON.parse(String(init.body)) as { resume_content?: string }
    const decoded = Buffer.from(sentBody.resume_content ?? '', 'base64').toString('utf-8')
    expect(decoded).toBe('CALLER-SUPPLIED FULL TEXT')
  })

  it('a resume_documents lookup failure degrades gracefully to resumeSummary rather than blocking the application', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 1 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const throwingClient = {
      from() {
        throw new Error('simulated resume_documents outage')
      },
    } as unknown as SupabaseClient

    const result = await submitApplication({
      jobUrl: 'https://boards.greenhouse.io/acme/jobs/1234567',
      profile: PROFILE,
      content: { resumeSummary: 'Fallback summary blurb.' },
      credentials: { greenhouse: 'api-key' },
      client: throwingClient,
      userId: 'user-1',
      jobId: 'job-123',
    })

    expect(result.outcome).toBe('submitted') // never blocked by the lookup failure
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const sentBody = JSON.parse(String(init.body)) as { resume_content?: string }
    const decoded = Buffer.from(sentBody.resume_content ?? '', 'base64').toString('utf-8')
    expect(decoded).toBe('Fallback summary blurb.')
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
