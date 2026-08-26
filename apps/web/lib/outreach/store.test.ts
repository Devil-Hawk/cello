// Tests for lib/outreach/store.ts#updateOutreach's STEP 5 projection: a
// transition to status:'sent' — the only caller that ever sets it
// (app/api/outreach/send/route.ts) — must emit an 'outreach_sent'
// interaction; every other status transition must not. recordInteraction
// itself is mocked (its own behavior is covered by
// lib/interactions/store.test.ts) so this only asserts the CALL, not the
// projection internals.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { updateOutreach, recordOutreachReply } from './store'

const recordInteraction = vi.fn()
vi.mock('../interactions/store', () => ({
  recordInteraction: (...args: unknown[]) => recordInteraction(...args),
}))

type Row = Record<string, unknown>

function makeFakeDb(row: Row) {
  return {
    from: () => ({
      update: (patch: Row) => ({
        eq: () => ({
          eq: () => ({
            select: () => ({
              single: async () => ({ data: { ...row, ...patch }, error: null }),
            }),
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient
}

const BASE_ROW: Row = {
  id: 'msg-1',
  user_id: 'user-1',
  company_id: 'co-1',
  contact_id: 'ct-1',
  job_id: 'job-1',
  subject: 'Following up',
  to_email: 'a@b.com',
  kind: 'initial',
  sent_at: null,
}

beforeEach(() => {
  recordInteraction.mockClear()
})

describe('updateOutreach', () => {
  it('projects outreach_sent when status transitions to sent', async () => {
    const db = makeFakeDb(BASE_ROW)
    await updateOutreach(db, 'user-1', 'msg-1', {
      status: 'sent',
      sent_at: '2026-08-01T00:00:00Z',
      gmail_message_id: 'gm-1',
    })

    expect(recordInteraction).toHaveBeenCalledTimes(1)
    const [, args] = recordInteraction.mock.calls[0]
    expect(args).toMatchObject({
      userId: 'user-1',
      companyId: 'co-1',
      contactId: 'ct-1',
      jobId: 'job-1',
      kind: 'outreach_sent',
      refTable: 'outreach_messages',
      refId: 'msg-1',
    })
  })

  it('does not project for a non-sent status transition', async () => {
    const db = makeFakeDb(BASE_ROW)
    await updateOutreach(db, 'user-1', 'msg-1', { status: 'approved' })
    expect(recordInteraction).not.toHaveBeenCalled()
  })

  it('does not project for status:failed', async () => {
    const db = makeFakeDb(BASE_ROW)
    await updateOutreach(db, 'user-1', 'msg-1', { status: 'failed', error: 'send failed' })
    expect(recordInteraction).not.toHaveBeenCalled()
  })
})

// --- recordOutreachReply (STEP 5 Gmail reply bridge) ------------------------
//
// Fake DB that actually filters/mutates an in-memory row array (unlike
// makeFakeDb above, which ignores its filters) — needed here because the
// idempotency guarantee IS the `.is('replied_at', null)` WHERE clause, and a
// stub that always returns the row can't exercise that. Any table other than
// outreach_messages throws, standing in for the "no activities writes" spy.
function makeReplyFakeDb(rows: Row[]) {
  const tablesTouched: string[] = []
  const db = {
    from: (table: string) => {
      tablesTouched.push(table)
      if (table !== 'outreach_messages') {
        return {
          update: () => {
            throw new Error(`unexpected write to "${table}"`)
          },
        }
      }
      return {
        update: (patch: Row) => {
          const filters: ((r: Row) => boolean)[] = []
          const builder = {
            eq(col: string, val: unknown) {
              filters.push((r) => r[col] === val)
              return builder
            },
            is(col: string, val: unknown) {
              filters.push((r) => r[col] === val)
              return builder
            },
            select() {
              const matched = rows.filter((r) => filters.every((f) => f(r)))
              matched.forEach((r) => Object.assign(r, patch))
              return Promise.resolve({ data: matched.map((r) => ({ ...r })), error: null })
            },
          }
          return builder
        },
      }
    },
  } as unknown as SupabaseClient
  return { db, tablesTouched }
}

describe('recordOutreachReply', () => {
  const match = {
    userId: 'user-1',
    gmailThreadId: 'th-1',
    gmailMessageId: 'gm-1',
    classification: 'positive' as const,
    occurredAt: '2026-08-20T00:00:00Z',
  }

  it('writes replied_at + reply_gmail_message_id + reply_classification on a thread match', async () => {
    const rows: Row[] = [
      { id: 'o1', user_id: 'user-1', gmail_thread_id: 'th-1', replied_at: null, company_id: 'co-1', contact_id: 'ct-1', job_id: 'job-1', subject: 'Hi' },
    ]
    const { db } = makeReplyFakeDb(rows)
    const result = await recordOutreachReply(db, match)

    expect(result).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      replied_at: '2026-08-20T00:00:00Z',
      reply_gmail_message_id: 'gm-1',
      reply_classification: 'positive',
    })
  })

  it('is idempotent: a second reply on the same thread never overwrites the first', async () => {
    const rows: Row[] = [
      { id: 'o1', user_id: 'user-1', gmail_thread_id: 'th-1', replied_at: null, company_id: null, contact_id: null, job_id: null, subject: 'Hi' },
    ]
    const { db } = makeReplyFakeDb(rows)
    await recordOutreachReply(db, match)
    const second = await recordOutreachReply(db, { ...match, gmailMessageId: 'gm-2', classification: 'negative', occurredAt: '2026-08-21T00:00:00Z' })

    expect(second).toHaveLength(0)
    expect(rows[0]).toMatchObject({ reply_gmail_message_id: 'gm-1', reply_classification: 'positive' })
  })

  it('stamps every still-unreplied row sharing the thread (initial + chained follow-up)', async () => {
    const rows: Row[] = [
      { id: 'o1', user_id: 'user-1', gmail_thread_id: 'th-1', replied_at: null, company_id: null, contact_id: null, job_id: null, subject: 'Initial' },
      { id: 'o2', user_id: 'user-1', gmail_thread_id: 'th-1', replied_at: null, company_id: null, contact_id: null, job_id: null, subject: 'Follow-up' },
    ]
    const { db } = makeReplyFakeDb(rows)
    const result = await recordOutreachReply(db, match)
    expect(result).toHaveLength(2)
  })

  it('emits a reply_received interaction for each matched row', async () => {
    const rows: Row[] = [
      { id: 'o1', user_id: 'user-1', gmail_thread_id: 'th-1', replied_at: null, company_id: 'co-1', contact_id: 'ct-1', job_id: 'job-1', subject: 'Hi' },
    ]
    const { db } = makeReplyFakeDb(rows)
    await recordOutreachReply(db, match)

    expect(recordInteraction).toHaveBeenCalledTimes(1)
    const [, args] = recordInteraction.mock.calls[0]
    expect(args).toMatchObject({
      userId: 'user-1',
      companyId: 'co-1',
      contactId: 'ct-1',
      jobId: 'job-1',
      kind: 'reply_received',
      refTable: 'outreach_messages',
      refId: 'o1',
    })
  })

  it('never writes to activities', async () => {
    const rows: Row[] = [
      { id: 'o1', user_id: 'user-1', gmail_thread_id: 'th-1', replied_at: null, company_id: null, contact_id: null, job_id: null, subject: 'Hi' },
    ]
    const { db, tablesTouched } = makeReplyFakeDb(rows)
    await recordOutreachReply(db, match)
    expect(tablesTouched).not.toContain('activities')
  })
})
