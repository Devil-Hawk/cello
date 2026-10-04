// POST /api/apply/bundle — the credential/profile release to the browser
// runner.
//
// THE THINGS THIS FILE HAS TO PROVE:
//   1. Wrong/missing BROWSER_RUNNER_SECRET refuses before anything is read.
//   2. No live phase token => refused, and the token is consumed BEFORE the
//      bundle is composed (so a burned token never yields a second bundle)
//      but only AFTER the read-only draft/approval/job checks, so a bad
//      request cannot burn a legitimate token.
//   3. Host-scoped release: a credential is only ever asked for at the
//      job's own host.
//   4. A submit bundle additionally requires status='approved' AND a fresh
//      review_confirmed_at — even though the token itself was valid.
//   5. Submit bundle answers are draft.fill_state VERBATIM, never recomputed.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

interface State {
  draft: Record<string, unknown> | null
  job: Record<string, unknown> | null
  profileRow: Record<string, unknown> | null
}

let state: State

function adminFrom(table: string) {
  const self = {
    select: () => self,
    eq: () => self,
    async maybeSingle() {
      if (table === 'application_drafts') return { data: state.draft, error: null }
      if (table === 'jobs') return { data: state.job, error: null }
      if (table === 'profiles') return { data: state.profileRow, error: null }
      return { data: null, error: null }
    },
  }
  return self
}

vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({ from: adminFrom }) }))

const consumePhaseTokenMock = vi.fn()
const mintReportTokenMock = vi.fn()
vi.mock('@/lib/ats-apply/phase-tokens', () => ({
  consumePhaseToken: (...args: unknown[]) => consumePhaseTokenMock(...args),
  mintReportToken: (...args: unknown[]) => mintReportTokenMock(...args),
}))

vi.mock('@/lib/ats-apply', () => ({
  buildApplyProfile: (row: Record<string, unknown>) => ({
    firstName: 'Ada',
    lastName: 'Lovelace',
    fullName: row.full_name ?? 'Ada Lovelace',
    email: row.email ?? 'ada@example.com',
    resumeText: row.resume_text ?? undefined,
  }),
  AUTHORIZATION_MAX_AGE_MS: 24 * 60 * 60 * 1000,
}))

const normalizeHostMock = vi.fn((url: string) => {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
})
const resolveCredentialForMock = vi.fn()
vi.mock('@/lib/apply/vault', () => ({
  normalizeHost: (...args: unknown[]) => normalizeHostMock(...(args as [string])),
  resolveCredentialFor: (...args: unknown[]) => resolveCredentialForMock(...args),
}))

const getLatestVersionMock = vi.fn()
const getBaseResumeMock = vi.fn()
vi.mock('@/lib/resume/store', () => ({
  getLatestVersion: (...args: unknown[]) => getLatestVersionMock(...args),
  getBaseResume: (...args: unknown[]) => getBaseResumeMock(...args),
}))

import { POST } from './route'

function bundleRequest(body: unknown, bearer = 'runner-secret') {
  return new NextRequest('http://localhost/api/apply/bundle', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  process.env.BROWSER_RUNNER_SECRET = 'runner-secret'
  state = {
    draft: {
      id: 'draft-1',
      user_id: 'user-1',
      job_id: 'job-1',
      status: 'pending_review',
      resume_summary: 'blurb',
      cover_letter: 'Dear hiring manager',
      fill_state: { first_name: 'Ada' },
      review_confirmed_at: new Date().toISOString(),
    },
    job: { url: 'https://boards.greenhouse.io/acme/jobs/123', description: 'A great role' },
    profileRow: { full_name: 'Ada Lovelace', email: 'ada@example.com', resume_text: null, preferences: null },
  }
  consumePhaseTokenMock.mockReset().mockResolvedValue({ id: 'tok-1' })
  mintReportTokenMock.mockReset().mockResolvedValue('minted-report-token')
  normalizeHostMock.mockClear()
  resolveCredentialForMock.mockReset().mockResolvedValue(null)
  getLatestVersionMock.mockReset().mockResolvedValue(null)
  getBaseResumeMock.mockReset().mockResolvedValue({ content: 'Full resume text' })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('POST /api/apply/bundle', () => {
  it('refuses without the runner secret', async () => {
    const res = await POST(bundleRequest({ draftId: 'draft-1', phase: 'fill' }, 'wrong'))
    expect(res.status).toBe(401)
    expect(consumePhaseTokenMock).not.toHaveBeenCalled()
  })

  it('refuses when BROWSER_RUNNER_SECRET is not configured', async () => {
    delete process.env.BROWSER_RUNNER_SECRET
    const res = await POST(bundleRequest({ draftId: 'draft-1', phase: 'fill' }, 'anything'))
    expect(res.status).toBe(401)
  })

  it('refuses when no live token exists for (draft, phase)', async () => {
    consumePhaseTokenMock.mockResolvedValue(false)
    const res = await POST(bundleRequest({ draftId: 'draft-1', phase: 'fill' }))
    expect(res.status).toBe(403)
  })

  it('consumes the token BEFORE any credential or profile read', async () => {
    const order: string[] = []
    consumePhaseTokenMock.mockImplementation(async () => {
      order.push('consume')
      return { id: 'tok-1' }
    })
    resolveCredentialForMock.mockImplementation(async () => {
      order.push('credential')
      return null
    })
    getBaseResumeMock.mockImplementation(async () => {
      order.push('resume')
      return { content: 'x' }
    })
    await POST(bundleRequest({ draftId: 'draft-1', phase: 'fill' }))
    expect(consumePhaseTokenMock).toHaveBeenCalledWith(expect.anything(), { draftId: 'draft-1', phase: 'fill' })
    expect(order[0]).toBe('consume')
    expect(order).toContain('credential')
  })

  it('a malformed or refused request never burns the phase token', async () => {
    // bad body
    await POST(bundleRequest({ draftId: '', phase: 'fill' }))
    await POST(bundleRequest({ draftId: 'draft-1', phase: 'bogus' }))
    // unknown draft
    state.draft = null
    expect((await POST(bundleRequest({ draftId: 'nope', phase: 'fill' }))).status).toBe(404)
    // submit on a draft that is not approved
    state.draft = { id: 'draft-1', user_id: 'user-1', job_id: 'job-1', status: 'pending_review', review_confirmed_at: new Date().toISOString() }
    expect((await POST(bundleRequest({ draftId: 'draft-1', phase: 'submit' }))).status).toBe(403)
    // submit with a stale review confirmation
    state.draft = { ...state.draft, status: 'approved', review_confirmed_at: new Date(Date.now() - 25 * 3600_000).toISOString() }
    expect((await POST(bundleRequest({ draftId: 'draft-1', phase: 'submit' }))).status).toBe(403)
    // job without a url
    state.draft = { ...state.draft, review_confirmed_at: new Date().toISOString() }
    state.job = { url: null }
    expect((await POST(bundleRequest({ draftId: 'draft-1', phase: 'submit' }))).status).toBe(422)
    expect(consumePhaseTokenMock).not.toHaveBeenCalled()
    expect(mintReportTokenMock).not.toHaveBeenCalled()
    expect(resolveCredentialForMock).not.toHaveBeenCalled()
  })

  it('releases the fill bundle with profile + resume + job content', async () => {
    const res = await POST(bundleRequest({ draftId: 'draft-1', phase: 'fill' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.phase).toBe('fill')
    expect(body.jobUrl).toBe('https://boards.greenhouse.io/acme/jobs/123')
    expect(body.profile.email).toBe('ada@example.com')
    expect(body.resumeText).toBe('Full resume text')
    expect(body.coverLetter).toBe('Dear hiring manager')
  })

  it('mints a report token AFTER consuming the phase token, and returns it in the bundle', async () => {
    const res = await POST(bundleRequest({ draftId: 'draft-1', phase: 'fill' }))
    const body = await res.json()
    expect(mintReportTokenMock).toHaveBeenCalledWith(expect.anything(), { draftId: 'draft-1', phase: 'fill', consumedRowId: 'tok-1' })
    expect(body.reportToken).toBe('minted-report-token')
  })

  it('never mints a report token when no live phase token exists', async () => {
    consumePhaseTokenMock.mockResolvedValue(false)
    await POST(bundleRequest({ draftId: 'draft-1', phase: 'fill' }))
    expect(mintReportTokenMock).not.toHaveBeenCalled()
  })

  it('resolves the credential scoped to the JOB HOST, never a different host', async () => {
    resolveCredentialForMock.mockResolvedValue({ username: 'ada', secret: 's3cr3t' })
    const res = await POST(bundleRequest({ draftId: 'draft-1', phase: 'fill' }))
    const body = await res.json()
    expect(resolveCredentialForMock).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      { host: 'boards.greenhouse.io' },
      expect.anything()
    )
    expect(body.credential).toEqual({ username: 'ada', secret: 's3cr3t' })
  })

  it('never asks the vault for a host other than the job posting\'s own host', async () => {
    state.job = { url: 'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/999', description: null }
    await POST(bundleRequest({ draftId: 'draft-1', phase: 'fill' }))
    const [, , spec] = resolveCredentialForMock.mock.calls[0]
    expect(spec.host).toBe('acme.wd5.myworkdayjobs.com')
    expect(spec.host).not.toBe('boards.greenhouse.io')
  })

  it('proceeds without a credential when none is stored (fill still succeeds)', async () => {
    resolveCredentialForMock.mockResolvedValue(null)
    const res = await POST(bundleRequest({ draftId: 'draft-1', phase: 'fill' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.credential).toBeNull()
  })

  it('proceeds without a credential when the vault throws (never fails the whole bundle)', async () => {
    resolveCredentialForMock.mockRejectedValue(new Error('vault: encryption unavailable'))
    const res = await POST(bundleRequest({ draftId: 'draft-1', phase: 'fill' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.credential).toBeNull()
  })

  describe('submit phase', () => {
    it('refuses when the draft is not approved', async () => {
      state.draft = { ...state.draft, status: 'pending_review' }
      const res = await POST(bundleRequest({ draftId: 'draft-1', phase: 'submit' }))
      expect(res.status).toBe(403)
    })

    it('refuses when review_confirmed_at is missing', async () => {
      state.draft = { ...state.draft, status: 'approved', review_confirmed_at: null }
      const res = await POST(bundleRequest({ draftId: 'draft-1', phase: 'submit' }))
      expect(res.status).toBe(403)
    })

    it('refuses when review_confirmed_at is stale', async () => {
      state.draft = {
        ...state.draft,
        status: 'approved',
        review_confirmed_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      }
      const res = await POST(bundleRequest({ draftId: 'draft-1', phase: 'submit' }))
      expect(res.status).toBe(403)
    })

    it('releases fill_state VERBATIM as `answers`, never recomputed', async () => {
      state.draft = { ...state.draft, status: 'approved' }
      const res = await POST(bundleRequest({ draftId: 'draft-1', phase: 'submit' }))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.answers).toEqual({ first_name: 'Ada' })
      expect(getLatestVersionMock).not.toHaveBeenCalled() // no re-derivation for submit
    })
  })
})
