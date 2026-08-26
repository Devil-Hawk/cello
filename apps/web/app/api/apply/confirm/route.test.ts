// POST /api/apply/confirm — the human click that mints a SUBMIT-phase token.
//
// THE THREE THINGS THIS FILE HAS TO PROVE:
//   1. A demo session is refused before any write.
//   2. Only an 'approved' draft with a FRESH review_confirmed_at may be
//      confirmed — stale or missing confirmation refuses (ruling 8).
//   3. Confirming mints exactly a phase:'submit' token and dispatches.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

interface State {
  user: { id: string } | null
  profile: Record<string, unknown> | null
  profileError: { message: string } | null
  draft: Record<string, unknown> | null
}

let state: State

function adminFrom(table: string) {
  const self = {
    select: () => self,
    eq: () => self,
    async maybeSingle() {
      if (table === 'profiles') return { data: state.profile, error: state.profileError }
      if (table === 'application_drafts') return { data: state.draft, error: null }
      return { data: null, error: null }
    },
  }
  return self
}

const supabase = {
  auth: { getUser: async () => ({ data: { user: state.user }, error: null }) },
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabase }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({ from: adminFrom }) }))

const issuePhaseTokenMock = vi.fn()
vi.mock('@/lib/ats-apply/phase-tokens', () => ({
  issuePhaseToken: (...args: unknown[]) => issuePhaseTokenMock(...args),
}))

const dispatchMock = vi.fn()
const { FakeDispatchError } = vi.hoisted(() => ({
  FakeDispatchError: class FakeDispatchError extends Error {},
}))
vi.mock('@/lib/ats-apply/dispatch', () => ({
  dispatchBrowserApplyWorkflow: (...args: unknown[]) => dispatchMock(...args),
  DispatchError: FakeDispatchError,
}))

import { POST } from './route'

function post(body: unknown) {
  return new NextRequest('http://localhost/api/apply/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  state = {
    user: { id: 'user-1' },
    profile: { is_demo: false, demo_expires_at: null },
    profileError: null,
    draft: {
      id: 'draft-1',
      user_id: 'user-1',
      status: 'approved',
      review_confirmed_at: new Date().toISOString(),
    },
  }
  issuePhaseTokenMock.mockReset().mockResolvedValue({ id: 'tok-1', expiresAt: '2099-01-01T00:00:00.000Z' })
  dispatchMock.mockReset().mockResolvedValue(undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('POST /api/apply/confirm', () => {
  it('refuses an unauthenticated caller', async () => {
    state.user = null
    const res = await POST(post({ draftId: 'draft-1' }))
    expect(res.status).toBe(401)
  })

  it('refuses a demo profile before any mint', async () => {
    state.profile = { is_demo: true, demo_expires_at: null }
    const res = await POST(post({ draftId: 'draft-1' }))
    expect(res.status).toBe(403)
    expect(issuePhaseTokenMock).not.toHaveBeenCalled()
  })

  it('fails closed when the profile cannot be read', async () => {
    state.profile = null
    state.profileError = { message: 'boom' }
    const res = await POST(post({ draftId: 'draft-1' }))
    expect(res.status).toBe(403)
  })

  it('404s a draft that is not this user\'s', async () => {
    state.draft = null
    const res = await POST(post({ draftId: 'nope' }))
    expect(res.status).toBe(404)
  })

  it('refuses a draft that is not approved', async () => {
    state.draft = { ...state.draft, status: 'pending_review' }
    const res = await POST(post({ draftId: 'draft-1' }))
    expect(res.status).toBe(409)
    expect(issuePhaseTokenMock).not.toHaveBeenCalled()
  })

  it('refuses when review_confirmed_at is missing', async () => {
    state.draft = { ...state.draft, review_confirmed_at: null }
    const res = await POST(post({ draftId: 'draft-1' }))
    expect(res.status).toBe(403)
    expect(issuePhaseTokenMock).not.toHaveBeenCalled()
  })

  it('refuses when review_confirmed_at is stale (older than AUTHORIZATION_MAX_AGE_MS)', async () => {
    state.draft = { ...state.draft, review_confirmed_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }
    const res = await POST(post({ draftId: 'draft-1' }))
    expect(res.status).toBe(403)
    expect(issuePhaseTokenMock).not.toHaveBeenCalled()
  })

  it('mints exactly a submit-phase token and dispatches on a fresh, approved draft', async () => {
    const res = await POST(post({ draftId: 'draft-1' }))
    expect(res.status).toBe(200)
    expect(issuePhaseTokenMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ draftId: 'draft-1', userId: 'user-1', phase: 'submit' })
    )
    expect(dispatchMock).toHaveBeenCalledWith({ draftId: 'draft-1', phase: 'submit' })
  })

  it('surfaces a dispatch failure as 502', async () => {
    dispatchMock.mockRejectedValue(new FakeDispatchError('github is down'))
    const res = await POST(post({ draftId: 'draft-1' }))
    expect(res.status).toBe(502)
  })
})
