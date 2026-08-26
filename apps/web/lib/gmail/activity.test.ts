// Tests for lib/gmail/activity.ts#recordStageActivity — the single write
// path /api/gmail/sync and /api/gmail/share share for a Gmail-detected
// stage signal. Covers the two mapping rules STEP 5 depends on:
//   - interview/screen ALWAYS projects an 'interview' interaction, even
//     when the stage decision itself was a no-op (a second interview
//     invite is still real news).
//   - everything else projects 'stage_change' ONLY when decision.action
//     === 'advanced'; an ignored regression/terminal/no-op still gets its
//     activities row (unchanged behavior) but no timeline entry.
// recordInteraction is mocked — its own behavior is covered by
// lib/interactions/store.test.ts.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { recordStageActivity } from './activity'
import type { StageDecision } from './stage'

const recordInteraction = vi.fn()
vi.mock('../interactions/store', () => ({
  recordInteraction: (...args: unknown[]) => recordInteraction(...args),
}))

function makeFakeDb(activityId = 'act-1') {
  return {
    from: () => ({
      insert: () => ({
        select: () => ({
          single: async () => ({ data: { id: activityId }, error: null }),
        }),
      }),
    }),
  } as unknown as SupabaseClient
}

const BASE = {
  userId: 'user-1',
  applicationId: 'app-1',
  companyId: 'co-1',
  jobId: 'job-1',
  companyName: 'Acme',
  jobTitle: 'Engineer',
  subject: 'Re: your application',
  reasoning: null,
  interviewDateTime: null,
  occurredAt: '2026-08-01T00:00:00Z',
  metadata: { gmail_message_id: 'gm-1' },
}

beforeEach(() => {
  recordInteraction.mockClear()
})

describe('recordStageActivity', () => {
  it('projects "interview" for an interview signal even when the decision was ignored', async () => {
    const db = makeFakeDb()
    const decision: StageDecision = {
      action: 'ignored_terminal',
      fromStage: 'accepted',
      toStage: 'interview',
      reason: 'already terminal',
    }
    await recordStageActivity(db, { ...BASE, status: 'interview', decision })

    expect(recordInteraction).toHaveBeenCalledTimes(1)
    const [, args] = recordInteraction.mock.calls[0]
    expect(args).toMatchObject({ kind: 'interview', refTable: 'activities', refId: 'act-1', applicationId: 'app-1' })
  })

  it('projects "stage_change" for a real advance', async () => {
    const db = makeFakeDb()
    const decision: StageDecision = { action: 'advanced', fromStage: 'applied', toStage: 'offer', reason: 'forward progression' }
    await recordStageActivity(db, { ...BASE, status: 'offer', decision })

    expect(recordInteraction).toHaveBeenCalledTimes(1)
    const [, args] = recordInteraction.mock.calls[0]
    expect(args).toMatchObject({ kind: 'stage_change' })
  })

  it('does not project for an ignored regression', async () => {
    const db = makeFakeDb()
    const decision: StageDecision = {
      action: 'ignored_regression',
      fromStage: 'interview',
      toStage: 'applied',
      reason: 'would regress',
    }
    await recordStageActivity(db, { ...BASE, status: 'applied', decision })
    expect(recordInteraction).not.toHaveBeenCalled()
  })

  it('still writes the activities row when the projection is skipped', async () => {
    let inserted: unknown = null
    const db = {
      from: () => ({
        insert: (row: unknown) => {
          inserted = row
          return { select: () => ({ single: async () => ({ data: { id: 'act-2' }, error: null }) }) }
        },
      }),
    } as unknown as SupabaseClient
    const decision: StageDecision = { action: 'no_change', fromStage: 'applied', toStage: 'applied', reason: 'no status detected' }
    await recordStageActivity(db, { ...BASE, status: 'unknown', decision })
    expect(inserted).not.toBeNull()
    expect(recordInteraction).not.toHaveBeenCalled()
  })
})
