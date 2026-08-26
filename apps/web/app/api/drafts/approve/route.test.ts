// POST /api/drafts/approve — the assisted-apply branch only (draft.fill_state
// present, written by PATCH app/api/apply/state). The official-API
// submission path (submitApplication et al.) is exercised elsewhere via
// lib/ats-apply's own tests; this file's job is the status-guard bug fix:
//
//   A draft only becomes approvable-from-here out of 'pending_review'.
//   'filling' (still in flight) and 'failed' (a submit attempt already
//   failed) must be refused, not silently re-stamped 'approved' with a
//   fresh review_confirmed_at — the freshness ruling 8 and
//   app/api/apply/bundle gate a real submit dispatch on.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

interface State {
  user: { id: string } | null
  draft: Record<string, unknown> | null
  updates: Record<string, unknown>[]
}

let state: State

function adminFrom(table: string) {
  const self = {
    select: () => self,
    eq: () => self,
    async maybeSingle() {
      if (table === 'application_drafts') return { data: state.draft, error: null }
      return { data: null, error: null }
    },
    update(patch: Record<string, unknown>) {
      state.updates.push(patch)
      return self
    },
  }
  return self
}

const supabase = {
  auth: { getUser: async () => ({ data: { user: state.user }, error: null }) },
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabase }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({ from: adminFrom }) }))
vi.mock('@/lib/observability/log', () => ({ logApiError: vi.fn() }))
vi.mock('@/lib/ats-apply', () => ({
  submitApplication: vi.fn(),
  buildApplyProfile: vi.fn(),
  buildHandoffFields: vi.fn(),
  buildDraftAnswers: vi.fn(),
  resolveApplyCredentials: vi.fn(),
}))

import { POST } from './route'

function post(body: unknown) {
  return new NextRequest('http://localhost/api/drafts/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  state = {
    user: { id: 'user-1' },
    draft: {
      id: 'draft-1',
      user_id: 'user-1',
      job_id: 'job-1',
      status: 'pending_review',
      fill_state: { first_name: 'Ada' },
    },
    updates: [],
  }
})

describe('POST /api/drafts/approve (assisted-apply branch)', () => {
  it('approves a pending_review assisted draft, stamping reviewed_at + review_confirmed_at', async () => {
    const res = await POST(post({ draftId: 'draft-1' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, status: 'approved', assisted: true })
    expect(state.updates[0]).toMatchObject({ status: 'approved' })
    expect(state.updates[0].reviewed_at).toBeTruthy()
    expect(state.updates[0].review_confirmed_at).toBeTruthy()
  })

  it('refuses (409) a "filling" assisted draft — still in flight, nothing to review yet', async () => {
    state.draft = { ...state.draft, status: 'filling' }
    const res = await POST(post({ draftId: 'draft-1' }))
    expect(res.status).toBe(409)
    expect(state.updates.length).toBe(0)
  })

  it('refuses (409) a "failed" assisted draft rather than silently re-approving it', async () => {
    state.draft = { ...state.draft, status: 'failed' }
    const res = await POST(post({ draftId: 'draft-1' }))
    expect(res.status).toBe(409)
    expect(state.updates.length).toBe(0)
  })

  it('still short-circuits "submitted" before the fill_state branch is ever reached', async () => {
    state.draft = { ...state.draft, status: 'submitted' }
    const res = await POST(post({ draftId: 'draft-1' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('submitted')
    expect(state.updates.length).toBe(0)
  })
})
