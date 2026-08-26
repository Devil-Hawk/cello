// Tests for lib/applications/store.ts#createReceipt's STEP 5 projection: an
// 'application_submitted' interaction, with company_id resolved via the
// receipt's application -> job -> company chain (application_receipts has
// no company_id of its own). recordInteraction is mocked — its own behavior
// is covered by lib/interactions/store.test.ts.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createReceipt, type OwnedApplication } from './store'
import type { NewReceiptInput } from './types'

const recordInteraction = vi.fn()
vi.mock('../interactions/store', () => ({
  recordInteraction: (...args: unknown[]) => recordInteraction(...args),
}))

type Row = Record<string, unknown>

function makeFakeDb(receiptRow: Row, jobRow: Row | null) {
  return {
    from: (table: string) => {
      if (table === 'application_receipts') {
        return {
          insert: () => ({
            select: () => ({
              single: async () => ({ data: receiptRow, error: null }),
            }),
          }),
        }
      }
      if (table === 'jobs') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: jobRow, error: null }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  } as unknown as SupabaseClient
}

const INPUT: NewReceiptInput = {
  applicationId: 'app-1',
  submittedAt: '2026-08-01T00:00:00Z',
  destination: 'careers page',
  documents: [],
}

const APPLICATION: OwnedApplication = {
  id: 'app-1',
  user_id: 'user-1',
  job_id: 'job-1',
  stage: 'applied',
  applied_at: null,
  source: null,
}

const RECEIPT_ROW: Row = {
  id: 'rc-1',
  application_id: 'app-1',
  user_id: 'user-1',
  provenance: 'manual',
  verification_state: 'user_confirmed',
  submitted_at: '2026-08-01T00:00:00Z',
  destination: 'careers page',
  documents: [],
  confirmation_identifier: null,
  confirmation_note: null,
  confirmation_attachment_url: null,
  source_detail: null,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
}

beforeEach(() => {
  recordInteraction.mockClear()
})

describe('createReceipt', () => {
  it('projects application_submitted with company_id resolved via the job', async () => {
    const db = makeFakeDb(RECEIPT_ROW, { company_id: 'co-1' })
    const receipt = await createReceipt(db, 'user-1', INPUT, 'manual', 'user_confirmed', APPLICATION)

    expect(receipt.id).toBe('rc-1')
    expect(recordInteraction).toHaveBeenCalledTimes(1)
    const [, args] = recordInteraction.mock.calls[0]
    expect(args).toMatchObject({
      userId: 'user-1',
      companyId: 'co-1',
      jobId: 'job-1',
      applicationId: 'app-1',
      kind: 'application_submitted',
      refTable: 'application_receipts',
      refId: 'rc-1',
    })
  })

  it('projects with a null company_id when the job has none on file', async () => {
    const db = makeFakeDb(RECEIPT_ROW, { company_id: null })
    await createReceipt(db, 'user-1', INPUT, 'manual', 'user_confirmed', APPLICATION)
    const [, args] = recordInteraction.mock.calls[0]
    expect(args).toMatchObject({ companyId: null })
  })
})
