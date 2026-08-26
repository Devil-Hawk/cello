// PATCH /api/apply/state — the runner's callback with fill/submit results.
//
// THE THINGS THIS FILE HAS TO PROVE:
//   1. Wrong/missing secret refuses.
//   2. fill: filling -> pending_review, screenshots validated (shape + size
//      cap), out-of-order/replayed callbacks refused (draft not 'filling').
//   3. submit 'submitted': writes a receipt with the HONEST verification
//      state — system_confirmed only when the runner says `confirmed: true`,
//      unconfirmed otherwise — and moves the draft to 'submitted'.
//   4. submit 'deviation': back to pending_review, no receipt written.
//   5. Out-of-order submit callbacks (draft not 'approved') are refused.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

interface State {
  draft: Record<string, unknown> | null
  updates: Record<string, unknown>[]
  applications: Record<string, unknown>[]
}

let state: State

function adminFrom(table: string) {
  const self: Record<string, unknown> = {}
  Object.assign(self, {
    select: () => self,
    eq: () => self,
    async maybeSingle() {
      if (table === 'application_drafts') return { data: state.draft, error: null }
      if (table === 'applications') return { data: state.applications[0] ?? null, error: null }
      return { data: null, error: null }
    },
    update(patch: Record<string, unknown>) {
      if (table === 'application_drafts') {
        state.updates.push(patch)
        state.draft = { ...(state.draft ?? {}), ...patch }
      }
      return self
    },
    insert(row: Record<string, unknown>) {
      const created = { id: 'app-1', ...row }
      state.applications.push(created)
      return {
        select: () => ({
          async single() {
            return { data: created, error: null }
          },
        }),
      }
    },
  })
  return self
}

vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({ from: adminFrom }) }))

const createReceiptMock = vi.fn()
vi.mock('@/lib/applications/store', () => ({
  createReceipt: (...args: unknown[]) => createReceiptMock(...args),
}))

// verifyReportToken() is real /api/apply/bundle-and-token machinery with its
// own dedicated tests (lib/ats-apply/phase-tokens.test.ts) — mocked here
// exactly like bundle/route.test.ts mocks consumePhaseToken, so this file
// stays focused on what THIS route does with the result.
const verifyReportTokenMock = vi.fn()
vi.mock('@/lib/ats-apply/phase-tokens', () => ({
  verifyReportToken: (...args: unknown[]) => verifyReportTokenMock(...args),
}))

import { PATCH } from './route'

function patchRequest(body: Record<string, unknown>, bearer = 'runner-secret') {
  return new NextRequest('http://localhost/api/apply/state', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ reportToken: 'the-real-report-token', ...body }),
  })
}

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

beforeEach(() => {
  process.env.BROWSER_RUNNER_SECRET = 'runner-secret'
  state = {
    draft: { id: 'draft-1', user_id: 'user-1', job_id: 'job-1', status: 'filling', fill_state: null },
    updates: [],
    applications: [],
  }
  createReceiptMock.mockReset().mockResolvedValue({ id: 'receipt-1' })
  verifyReportTokenMock.mockReset().mockResolvedValue(true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('PATCH /api/apply/state', () => {
  it('refuses without the runner secret', async () => {
    const res = await PATCH(patchRequest({ draftId: 'draft-1', phase: 'fill', fillState: {} }, 'wrong'))
    expect(res.status).toBe(401)
  })

  it('refuses a callback with no matching report token — never touches the draft', async () => {
    verifyReportTokenMock.mockResolvedValue(false)
    const res = await PATCH(patchRequest({ draftId: 'draft-1', phase: 'fill', fillState: {} }))
    expect(res.status).toBe(403)
    expect(state.updates.length).toBe(0)
  })

  it('checks the report token for the EXACT draft/phase the callback names', async () => {
    await PATCH(patchRequest({ draftId: 'draft-1', phase: 'fill', fillState: {} }))
    expect(verifyReportTokenMock).toHaveBeenCalledWith(expect.anything(), {
      draftId: 'draft-1',
      phase: 'fill',
      reportToken: 'the-real-report-token',
    })
  })

  it('a forged callback holding only BROWSER_RUNNER_SECRET (no real bundle fetch, no report token) cannot fabricate a submitted result', async () => {
    // Exactly the panel-proven exploit: a draft already sitting in
    // 'approved' (as it would right after a human's Approve click), no
    // prepare/bundle/confirm call ever made for this run.
    verifyReportTokenMock.mockResolvedValue(false)
    state.draft = { ...state.draft, status: 'approved', fill_state: { first_name: 'Ada' } }
    const res = await PATCH(
      patchRequest({ draftId: 'draft-1', phase: 'submit', result: 'submitted', confirmed: true, confirmationIdentifier: 'FORGED-CONF-999' })
    )
    expect(res.status).toBe(403)
    expect(createReceiptMock).not.toHaveBeenCalled()
    expect(state.draft?.status).toBe('approved')
  })

  describe('fill', () => {
    it('records fill_state + screenshots and moves to pending_review', async () => {
      const res = await PATCH(
        patchRequest({
          draftId: 'draft-1',
          phase: 'fill',
          fillState: { first_name: 'Ada' },
          screenshots: [{ page: 'page-1', dataUrl: PNG_1PX, capturedAt: new Date().toISOString() }],
        })
      )
      expect(res.status).toBe(200)
      expect(state.draft?.status).toBe('pending_review')
      expect(state.draft?.fill_state).toEqual({ first_name: 'Ada' })
      expect((state.draft?.screenshots as unknown[]).length).toBe(1)
    })

    it('refuses a callback for a draft that is not "filling" (stale/replayed)', async () => {
      state.draft = { ...state.draft, status: 'pending_review' }
      const res = await PATCH(patchRequest({ draftId: 'draft-1', phase: 'fill', fillState: {} }))
      expect(res.status).toBe(409)
      expect(state.updates.length).toBe(0)
    })

    it('rejects a malformed (non-data-URL) screenshot', async () => {
      const res = await PATCH(
        patchRequest({
          draftId: 'draft-1',
          phase: 'fill',
          fillState: {},
          screenshots: [{ page: 'page-1', dataUrl: 'https://not-a-data-url.example/x.png' }],
        })
      )
      expect(res.status).toBe(400)
    })

    it('rejects an oversized screenshot payload', async () => {
      const hugeBase64 = 'A'.repeat(6 * 1024 * 1024) // decodes to > 4MB cap
      const res = await PATCH(
        patchRequest({
          draftId: 'draft-1',
          phase: 'fill',
          fillState: {},
          screenshots: [{ page: 'page-1', dataUrl: `data:image/png;base64,${hugeBase64}` }],
        })
      )
      expect(res.status).toBe(400)
    })
  })

  describe('submit', () => {
    beforeEach(() => {
      state.draft = { ...state.draft, status: 'approved', fill_state: { first_name: 'Ada' } }
    })

    it('refuses a callback for a draft that is not "approved" (stale/replayed)', async () => {
      state.draft = { ...state.draft, status: 'pending_review' }
      const res = await PATCH(patchRequest({ draftId: 'draft-1', phase: 'submit', result: 'submitted', confirmed: true }))
      expect(res.status).toBe(409)
    })

    it('writes system_confirmed when the runner witnessed a real confirmation', async () => {
      const res = await PATCH(
        patchRequest({ draftId: 'draft-1', phase: 'submit', result: 'submitted', confirmed: true, confirmationIdentifier: 'CONF-123' })
      )
      expect(res.status).toBe(200)
      expect(createReceiptMock).toHaveBeenCalled()
      const [, , , provenance, verificationState] = createReceiptMock.mock.calls[0]
      expect(provenance).toBe('browser_companion')
      expect(verificationState).toBe('system_confirmed')
      expect(state.draft?.status).toBe('submitted')
      expect(state.draft?.submission_ref).toBe('CONF-123')
    })

    it('writes unconfirmed when the runner attempted but did not witness a confirmation', async () => {
      const res = await PATCH(patchRequest({ draftId: 'draft-1', phase: 'submit', result: 'submitted', confirmed: false }))
      expect(res.status).toBe(200)
      const [, , , , verificationState] = createReceiptMock.mock.calls[0]
      expect(verificationState).toBe('unconfirmed')
    })

    it('never infers confirmation from confirmationIdentifier alone', async () => {
      // confirmed omitted/false but an identifier IS present — must still be unconfirmed.
      await PATCH(
        patchRequest({ draftId: 'draft-1', phase: 'submit', result: 'submitted', confirmationIdentifier: 'CONF-999' })
      )
      const [, , , , verificationState] = createReceiptMock.mock.calls[0]
      expect(verificationState).toBe('unconfirmed')
    })

    it('deviation sends the draft back to pending_review and writes NO receipt', async () => {
      const res = await PATCH(
        patchRequest({ draftId: 'draft-1', phase: 'submit', result: 'deviation', deviationDetail: 'a new required field appeared' })
      )
      expect(res.status).toBe(200)
      expect(state.draft?.status).toBe('pending_review')
      expect(createReceiptMock).not.toHaveBeenCalled()
      expect((state.draft?.fill_state as Record<string, unknown>).deviation).toBeDefined()
    })

    it('failed marks the draft failed and writes NO receipt', async () => {
      const res = await PATCH(patchRequest({ draftId: 'draft-1', phase: 'submit', result: 'failed', error: 'timeout' }))
      expect(res.status).toBe(200)
      expect(state.draft?.status).toBe('failed')
      expect(createReceiptMock).not.toHaveBeenCalled()
    })
  })
})
