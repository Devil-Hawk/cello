// Tests for lib/applications/attempts.ts#createAttempt's STEP 5 projection: an
// 'application_submitted' interaction, with company_id resolved via the
// attempt's application -> job -> company chain (application_attempts has
// no company_id of its own). recordInteraction is mocked — its own behavior
// is covered by lib/interactions/store.test.ts.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAttempt, moveDataUrlImages, type OwnedApplication } from './attempts'
import type { NewAttemptInput } from './types'

const recordInteraction = vi.fn()
vi.mock('../interactions/store', () => ({
  recordInteraction: (...args: unknown[]) => recordInteraction(...args),
}))

type Row = Record<string, unknown>

function makeFakeDb(attemptRow: Row, jobRow: Row | null) {
  return {
    from: (table: string) => {
      if (table === 'application_attempts') {
        return {
          insert: () => ({
            select: () => ({
              single: async () => ({ data: attemptRow, error: null }),
            }),
          }),
        }
      }
      if (table === 'person_jobs') {
        const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: jobRow, error: null }) }
        return q
      }
      throw new Error(`unexpected table ${table}`)
    },
  } as unknown as SupabaseClient
}

const INPUT: NewAttemptInput = {
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

const ATTEMPT_ROW: Row = {
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

describe('createAttempt', () => {
  it('projects application_submitted with company_id resolved via the job', async () => {
    const db = makeFakeDb(ATTEMPT_ROW, { company_id: 'co-1' })
    const attempt = await createAttempt(db, 'user-1', INPUT, 'manual', 'user_confirmed', APPLICATION)

    expect(attempt.id).toBe('rc-1')
    expect(recordInteraction).toHaveBeenCalledTimes(1)
    const [, args] = recordInteraction.mock.calls[0]
    expect(args).toMatchObject({
      userId: 'user-1',
      companyId: 'co-1',
      jobId: 'job-1',
      applicationId: 'app-1',
      kind: 'application_submitted',
      refTable: 'application_attempts',
      refId: 'rc-1',
    })
  })

  it('projects with a null company_id when the job has none on file', async () => {
    const db = makeFakeDb(ATTEMPT_ROW, { company_id: null })
    await createAttempt(db, 'user-1', INPUT, 'manual', 'user_confirmed', APPLICATION)
    const [, args] = recordInteraction.mock.calls[0]
    expect(args).toMatchObject({ companyId: null })
  })
})

describe('moveDataUrlImages', () => {
  const jpeg = `data:image/jpeg;base64,${Buffer.from('small jpeg bytes').toString('base64')}`
  const png = `data:image/png;base64,${Buffer.from('a png').toString('base64')}`
  const big = `data:image/jpeg;base64,${Buffer.alloc(300 * 1024).toString('base64')}`

  it('moves a small JPEG into the bucket, points the row at it, and leaves a PNG and a large JPEG', async () => {
    const rows = [
      { id: 'a1', user_id: 'u1', confirmation_attachment_url: jpeg },
      { id: 'a2', user_id: 'u1', confirmation_attachment_url: png },
      { id: 'a3', user_id: 'u1', confirmation_attachment_url: big },
    ]
    const uploads: Array<{ path: string; type: string | undefined }> = []
    const updates: Array<{ id: string; patch: Row }> = []
    const select = { is: () => select, like: () => select, limit: async () => ({ data: rows, error: null }) }
    const client = {
      from: () => ({
        select: () => select,
        update: (patch: Row) => ({
          eq: (_c: string, id: string) => ({
            eq: async () => {
              updates.push({ id, patch })
              return { error: null }
            },
          }),
        }),
      }),
      storage: {
        from: (bucket: string) => {
          expect(bucket).toBe('attempts')
          return {
            upload: async (path: string, _bytes: Buffer, opts: { contentType?: string }) => {
              uploads.push({ path, type: opts.contentType })
              return { error: null }
            },
          }
        },
      },
    } as unknown as SupabaseClient

    const result = await moveDataUrlImages(client)

    expect(result).toEqual({ moved: 1, left: 2, failed: 0 })
    expect(uploads).toEqual([{ path: 'u1/a1.jpg', type: 'image/jpeg' }])
    expect(updates).toEqual([{ id: 'a1', patch: { screenshot_path: 'u1/a1.jpg', confirmation_attachment_url: null } }])
  })
})
