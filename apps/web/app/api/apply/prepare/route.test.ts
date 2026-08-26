// POST /api/apply/prepare — starts the FILL phase.
//
// THE THREE THINGS THIS FILE HAS TO PROVE:
//   1. A demo session is refused before any write, failing closed on an
//      unreadable profile — same posture as every other privileged route.
//   2. Only a 'pending_review' draft can be prepared; the status flips to
//      'filling' and a fill-phase token is minted + dispatched.
//   3. A dispatch failure rolls the draft back to 'pending_review' rather
//      than stranding it in 'filling' with no run behind it.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

interface State {
  user: { id: string } | null
  profile: Record<string, unknown> | null
  profileError: { message: string } | null
  draft: Record<string, unknown> | null
  job: Record<string, unknown> | null
  updates: Record<string, unknown>[]
  // Simulates a concurrent winner flipping the draft's real status the
  // instant AFTER this request's own read of it — see the race test below.
  raceOnRead: boolean
}

let state: State

function adminFrom(table: string) {
  const filters: [string, unknown][] = []
  let pendingUpdate: Record<string, unknown> | null = null
  const self = {
    select: () => self,
    eq(col: string, val: unknown) {
      filters.push([col, val])
      return self
    },
    update(patch: Record<string, unknown>) {
      pendingUpdate = patch
      return self
    },
    async maybeSingle() {
      if (table === 'profiles') return { data: state.profile, error: state.profileError }
      if (table === 'jobs') return { data: state.job, error: null }
      if (table !== 'application_drafts') return { data: null, error: null }
      if (pendingUpdate) {
        // The status-guarded transition UPDATE: evaluated against the
        // CURRENT state at the instant this runs, not a snapshot from
        // earlier in the request — the same discipline
        // lib/ats-apply/phase-tokens.test.ts's fake uses.
        const statusFilter = filters.find(([col]) => col === 'status')
        const current = state.draft as Record<string, unknown> | null
        if (statusFilter && current?.status !== statusFilter[1]) {
          return { data: null, error: null }
        }
        state.updates.push(pendingUpdate)
        state.draft = { ...(state.draft ?? {}), ...pendingUpdate }
        return { data: state.draft, error: null }
      }
      const snapshot = state.draft
      if (state.raceOnRead && snapshot) {
        // A "concurrent winner" commits pending_review -> filling right
        // after this request's own read returns its (now stale) snapshot.
        state.draft = { ...snapshot, status: 'filling' }
      }
      return { data: snapshot, error: null }
    },
    // The rollback UPDATE (on dispatch failure) is bare-awaited with no
    // terminal .select()/.maybeSingle() — matches the real thenable
    // PostgrestFilterBuilder, and applies unconditionally (no status
    // filter is ever attached to that call).
    then(resolve: (v: { data: unknown; error: null }) => void) {
      if (table === 'application_drafts' && pendingUpdate) {
        state.updates.push(pendingUpdate)
        state.draft = { ...(state.draft ?? {}), ...pendingUpdate }
      }
      resolve({ data: null, error: null })
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
  return new NextRequest('http://localhost/api/apply/prepare', {
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
    draft: { id: 'draft-1', user_id: 'user-1', job_id: 'job-1', status: 'pending_review' },
    job: { url: 'https://boards.greenhouse.io/acme/jobs/123' },
    updates: [],
    raceOnRead: false,
  }
  issuePhaseTokenMock.mockReset().mockResolvedValue({ id: 'tok-1', expiresAt: '2099-01-01T00:00:00.000Z' })
  dispatchMock.mockReset().mockResolvedValue(undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('POST /api/apply/prepare', () => {
  it('refuses an unauthenticated caller', async () => {
    state.user = null
    const res = await POST(post({ draftId: 'draft-1' }))
    expect(res.status).toBe(401)
  })

  it('refuses a demo profile before any write', async () => {
    state.profile = { is_demo: true, demo_expires_at: null }
    const res = await POST(post({ draftId: 'draft-1' }))
    expect(res.status).toBe(403)
    expect(issuePhaseTokenMock).not.toHaveBeenCalled()
    expect(dispatchMock).not.toHaveBeenCalled()
  })

  it('fails closed when the profile cannot be read', async () => {
    state.profile = null
    state.profileError = { message: 'boom' }
    const res = await POST(post({ draftId: 'draft-1' }))
    expect(res.status).toBe(403)
    expect(issuePhaseTokenMock).not.toHaveBeenCalled()
  })

  it('404s a draft that does not exist / is not this user\'s', async () => {
    state.draft = null
    const res = await POST(post({ draftId: 'nope' }))
    expect(res.status).toBe(404)
  })

  it('refuses a draft that is not pending_review', async () => {
    state.draft = { ...state.draft, status: 'approved' }
    const res = await POST(post({ draftId: 'draft-1' }))
    expect(res.status).toBe(409)
    expect(issuePhaseTokenMock).not.toHaveBeenCalled()
  })

  it('refuses a job with no URL', async () => {
    state.job = { url: null }
    const res = await POST(post({ draftId: 'draft-1' }))
    expect(res.status).toBe(422)
  })

  it('moves the draft to filling, mints a fill token, and dispatches the workflow', async () => {
    const res = await POST(post({ draftId: 'draft-1' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('filling')
    expect(issuePhaseTokenMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ draftId: 'draft-1', userId: 'user-1', phase: 'fill' })
    )
    expect(dispatchMock).toHaveBeenCalledWith({ draftId: 'draft-1', phase: 'fill' })
    expect(state.updates.some((u) => u.status === 'filling')).toBe(true)
  })

  it('refuses (409) when another request already moved the draft past pending_review before this one\'s guarded update runs', async () => {
    state.raceOnRead = true
    const res = await POST(post({ draftId: 'draft-1' }))
    expect(res.status).toBe(409)
    expect(issuePhaseTokenMock).not.toHaveBeenCalled()
    expect(dispatchMock).not.toHaveBeenCalled()
  })

  it('rolls the draft back to pending_review when dispatch fails', async () => {
    dispatchMock.mockRejectedValue(new FakeDispatchError('github is down'))
    const res = await POST(post({ draftId: 'draft-1' }))
    expect(res.status).toBe(502)
    // Last update recorded must be the rollback.
    expect(state.updates[state.updates.length - 1].status).toBe('pending_review')
  })
})
