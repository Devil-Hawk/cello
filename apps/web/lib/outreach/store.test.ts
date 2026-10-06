// Tests for lib/outreach/store.ts#updateOutreach's STEP 5 projection: a
// transition to status:'sent' — the only caller that ever sets it
// (app/api/outreach/send/route.ts) — must emit an 'outreach_sent'
// interaction; every other status transition must not. recordInteraction
// itself is mocked (its own behavior is covered by
// lib/interactions/store.test.ts) so this only asserts the CALL, not the
// projection internals.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ACTIVE_INITIAL_STATUSES, findDuplicateInitial, insertOutreach, isDuplicateOutreachError, updateOutreach, recordOutreachReply } from './store'

// The artifact half is covered in store.artifacts.test.ts against a fake store that keeps artifacts.
vi.mock('../agents/artifacts', () => ({
  createArtifact: async () => ({ id: 'art-1', version: 1, created: true }),
  addVersion: async () => 2,
}))

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

// --- dedupe: the app check and the unique index must be the same rule --------
describe('findDuplicateInitial / the unique index', () => {
  it('counts the statuses that still hold the slot, and not a dismissed draft', () => {
    expect([...ACTIVE_INITIAL_STATUSES].sort()).toEqual(['approved', 'failed', 'pending_review', 'sent'])
    expect(ACTIVE_INITIAL_STATUSES).not.toContain('skipped')
  })

  it('asks the database for exactly those statuses', async () => {
    const seen: { column?: string; values?: readonly string[] } = {}
    const builder: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'is']) builder[m] = () => builder
    builder.in = (column: string, values: string[]) => {
      Object.assign(seen, { column, values })
      return builder
    }
    builder.limit = async () => ({ data: [] })
    const db = { from: () => builder } as unknown as SupabaseClient

    expect(await findDuplicateInitial(db, 'user-1', 'ct-1', 'job-1')).toBeNull()
    expect(seen).toEqual({ column: 'status', values: [...ACTIVE_INITIAL_STATUSES] })
  })

  it('the newest migration\'s unique-index predicate lists the same statuses as the app', () => {
    const dir = join(__dirname, '../../../../supabase/migrations')
    const sql = readFileSync(join(dir, '20261005100001_outreach_dedupe_matches_app.sql'), 'utf8')
    const index = sql.slice(sql.indexOf('create unique index'))
    const listed = [...index.matchAll(/status in \(([^)]*)\)/g)][0]?.[1]
    const statuses = (listed ?? '').split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean)
    expect(statuses.sort()).toEqual([...ACTIVE_INITIAL_STATUSES].sort())
  })
})

describe('insertOutreach errors', () => {
  const failingDb = (error: { code: string; message: string }) =>
    ({ from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error }) }) }) }) }) as unknown as SupabaseClient
  const row = { user_id: 'u', to_email: 'a@b.com', subject: 's', body: 'b' }

  it('carries the Postgres code so the unique-index refusal is recognisable', async () => {
    const err = await insertOutreach(failingDb({ code: '23505', message: 'duplicate key value' }), row).catch((e) => e)
    expect(isDuplicateOutreachError(err)).toBe(true)
  })

  it('does not mistake another failure for a duplicate', async () => {
    const err = await insertOutreach(failingDb({ code: '42703', message: 'column does not exist' }), row).catch((e) => e)
    expect(isDuplicateOutreachError(err)).toBe(false)
    expect(isDuplicateOutreachError(new Error('plain'))).toBe(false)
    expect(isDuplicateOutreachError(null)).toBe(false)
  })
})

describe('insertOutreach stamps the call that wrote the draft', () => {
  const row = { user_id: 'u', to_email: 'a@b.com', subject: 'Hello', body: 'Original body', kind: 'initial' as const }
  const capture = () => {
    const sent: Row[] = []
    const db = {
      from: () => ({
        insert: (r: Row) => {
          sent.push(r)
          return { select: () => ({ single: async () => ({ data: r, error: null }) }) }
        },
      }),
    } as unknown as SupabaseClient
    return { db, sent }
  }
  const spansAdmin = { from: () => ({ insert: async () => ({ error: null }) }) } as never

  async function inTrace<T>(fn: () => Promise<T>): Promise<T> {
    const { withTrace } = await import('../trace/spans')
    return withTrace(spansAdmin, 'u', { name: 'draft-outreach', isDemo: false }, fn)
  }
  const configure = () => {
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-lf-fake')
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-fake')
    vi.stubEnv('LANGFUSE_BASE_URL', 'https://langfuse.example.com')
  }

  it('inside an exported trace it stores trace_id, observation_id and what the model wrote', async () => {
    configure()
    const { db, sent } = capture()
    const { currentTraceContext } = await import('../trace/spans')
    await inTrace(async () => {
      currentTraceContext()!.buffer.noteGeneration('draft-outreach-message', '0f7b5d5a-1d75-4c5b-9d31-e984c3b9e5b6')
      await insertOutreach(db, row)
    })
    expect(sent[0]).toMatchObject({
      trace_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      observation_id: '0f7b5d5a1d754c5b',
      generated_subject: 'Hello',
      generated_body: 'Original body',
    })
    vi.unstubAllEnvs()
  })

  it('a follow-up looks for the follow-up generation', async () => {
    configure()
    const { db, sent } = capture()
    const { currentTraceContext } = await import('../trace/spans')
    await inTrace(async () => {
      currentTraceContext()!.buffer.noteGeneration('draft-outreach-message', '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
      currentTraceContext()!.buffer.noteGeneration('draft-follow-up', '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
      await insertOutreach(db, { ...row, kind: 'follow_up' })
    })
    expect(sent[0].observation_id).toBe('22222222bbbb4bbb')
    vi.unstubAllEnvs()
  })

  it('stamps nothing for a template, nothing outside a trace, and nothing when the trace is not exported', async () => {
    configure()
    const a = capture()
    const { currentTraceContext } = await import('../trace/spans')
    await inTrace(async () => {
      currentTraceContext()!.buffer.noteGeneration('draft-outreach-message', '0f7b5d5a-1d75-4c5b-9d31-e984c3b9e5b6')
      await insertOutreach(a.db, { ...row, used_llm: false })
    })
    expect(a.sent[0]).toMatchObject({ ...row, used_llm: false })
    expect(a.sent[0]).not.toHaveProperty('trace_id')

    const b = capture()
    await insertOutreach(b.db, row)
    expect(b.sent[0]).toMatchObject(row)
    expect(b.sent[0]).not.toHaveProperty('trace_id')
    vi.unstubAllEnvs()

    const c = capture()
    await inTrace(async () => {
      await insertOutreach(c.db, row)
    })
    expect(c.sent[0]).toMatchObject(row)
    expect(c.sent[0]).not.toHaveProperty('trace_id')
  })
})
