// exportFeedback and recordFeedback against an in-memory stand-in for the
// tables. Langfuse is faked at the sendScores boundary: no network.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminClient } from '../harness/types'

const sendScoresMock = vi.fn()
let configured = true
vi.mock('../observability/langfuse', () => ({
  langfuseConfigured: () => configured,
  sendScores: (...args: unknown[]) => sendScoresMock(...args),
}))

import { MAX_ATTEMPTS, SIGNALS, exportFeedback, recordFeedback, scoreIdFor } from './feedback'

type Row = Record<string, unknown>
const NOW = new Date('2026-10-06T12:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()

/** Just enough of the supabase-js builder for what feedback.ts calls. */
function fakeAdmin(tables: Record<string, Row[]>) {
  const upserts: Row[] = []
  const admin = {
    from(name: string) {
      const rows = (tables[name] ??= [])
      let op: 'select' | 'delete' | 'update' | 'upsert' = 'select'
      let patch: Row = {}
      let count = false
      const filters: ((r: Row) => boolean)[] = []
      let limit = Infinity
      const run = () => {
        const hit = rows.filter((r) => filters.every((f) => f(r)))
        if (op === 'delete') {
          for (const r of hit) rows.splice(rows.indexOf(r), 1)
          return { data: null, error: null, count: count ? hit.length : null }
        }
        if (op === 'update') {
          for (const r of hit) Object.assign(r, patch)
          return { data: null, error: null }
        }
        return { data: hit.slice(0, limit), error: null }
      }
      const b: Record<string, unknown> = {
        select: () => b,
        delete: (o?: { count?: string }) => ((op = 'delete'), (count = Boolean(o?.count)), b),
        update: (p: Row) => ((op = 'update'), (patch = p), b),
        upsert: (row: Row) => {
          upserts.push(row)
          return Promise.resolve({ error: null })
        },
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
        lt: (c: string, v: string) => (filters.push((r) => String(r[c]) < v), b),
        in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), b),
        order: () => b,
        limit: (n: number) => ((limit = n), b),
        maybeSingle: async () => ({ ...run(), data: (run().data as Row[])[0] ?? null }),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
      }
      return b
    },
  }
  return { admin: admin as unknown as AdminClient, tables, upserts }
}

function event(over: Partial<Row> = {}): Row {
  return {
    id: 'ev-1',
    user_id: 'user-1',
    signal: 'draft_approved',
    subject_table: 'outreach_messages',
    subject_id: 'msg-1',
    trace_id: 'a'.repeat(32),
    observation_id: 'b'.repeat(16),
    traced_at: daysAgo(2),
    comment: null,
    occurred_at: daysAgo(1),
    status: 'pending',
    attempts: 0,
    ...over,
  }
}

beforeEach(() => {
  configured = true
  sendScoresMock.mockReset().mockResolvedValue(true)
})

describe('exportFeedback', () => {
  it('names the seven behaviours', () => {
    expect([...SIGNALS]).toEqual(['draft_approved', 'draft_edited', 'draft_skipped', 'job_applied', 'job_dismissed', 'outreach_replied', 'interview_scheduled'])
  })

  it('sends an approval as a BOOLEAN 1 on the trace and observation, then marks it sent', async () => {
    const { admin, tables } = fakeAdmin({ feedback_events: [event()] })
    const out = await exportFeedback(admin, { now: NOW })
    expect(out).toEqual({ sent: 1, skipped: 0, failed: 0, deleted: 0 })
    expect(sendScoresMock).toHaveBeenCalledTimes(1)
    expect(sendScoresMock.mock.calls[0][0]).toEqual([
      { id: scoreIdFor({ user_id: 'user-1', signal: 'draft_approved', subject_table: 'outreach_messages', subject_id: 'msg-1' }), traceId: 'a'.repeat(32), observationId: 'b'.repeat(16), name: 'draft_approved', value: 1, dataType: 'BOOLEAN' },
    ])
    expect(tables.feedback_events[0]).toMatchObject({ status: 'sent', sent_at: NOW.toISOString() })
  })

  it('draft_edited carries the edit distance from what the model wrote to what is there now', async () => {
    const { admin } = fakeAdmin({
      feedback_events: [event({ signal: 'draft_edited' })],
      outreach_messages: [
        { id: 'msg-1', generated_subject: 'Hello', generated_body: 'one two three four five six seven eight nine', subject: 'Hello', body: 'one two three four five six seven eight ten' },
      ],
    })
    await exportFeedback(admin, { now: NOW })
    const [score] = sendScoresMock.mock.calls[0][0]
    expect(score).toMatchObject({ name: 'draft_edited', dataType: 'NUMERIC' })
    // 1 word changed of 10 (subject + 9 body words)
    expect(score.value).toBeCloseTo(0.1, 3)
  })

  it('an edit that changed nothing, or whose original was never kept, is skipped, not sent', async () => {
    const { admin, tables } = fakeAdmin({
      feedback_events: [event({ id: 'same', signal: 'draft_edited' }), event({ id: 'nokept', signal: 'draft_edited', subject_id: 'msg-2' })],
      outreach_messages: [
        { id: 'msg-1', generated_subject: 'Hi', generated_body: 'same text', subject: 'Hi', body: 'same text' },
        { id: 'msg-2', generated_subject: null, generated_body: null, subject: 'Hi', body: 'whatever' },
      ],
    })
    const out = await exportFeedback(admin, { now: NOW })
    expect(out.skipped).toBe(2)
    expect(sendScoresMock).not.toHaveBeenCalled()
    expect(tables.feedback_events.map((r) => r.status)).toEqual(['expired', 'expired'])
  })

  it('an application draft edit joins the cover letter and summary', async () => {
    const { admin } = fakeAdmin({
      feedback_events: [event({ signal: 'draft_edited', subject_table: 'application_drafts', subject_id: 'd-1' })],
      application_drafts: [{ id: 'd-1', generated_cover_letter: 'a b c d', generated_resume_summary: 'e f', cover_letter: 'a b c d', resume_summary: 'e x' }],
    })
    await exportFeedback(admin, { now: NOW })
    expect(sendScoresMock.mock.calls[0][0][0].value).toBeCloseTo(1 / 6, 3)
  })

  it('expires an event whose trace is older than 28 days and sends nothing for it', async () => {
    const { admin, tables } = fakeAdmin({ feedback_events: [event({ traced_at: daysAgo(29), occurred_at: daysAgo(2) })] })
    const out = await exportFeedback(admin, { now: NOW })
    expect(out.skipped).toBe(1)
    expect(sendScoresMock).not.toHaveBeenCalled()
    expect(tables.feedback_events[0].status).toBe('expired')
  })

  it('deletes events older than 30 days', async () => {
    const { admin, tables } = fakeAdmin({
      feedback_events: [event({ id: 'old', occurred_at: daysAgo(31), status: 'sent' }), event({ id: 'new', subject_id: 'msg-2' })],
    })
    const out = await exportFeedback(admin, { now: NOW })
    expect(out.deleted).toBe(1)
    expect(tables.feedback_events.map((r) => r.id)).toEqual(['new'])
  })

  it('the score id is the same on every pass and differs by person, signal and subject', () => {
    const base = { user_id: 'u', signal: 'job_applied', subject_table: 'jobs', subject_id: 'j' }
    expect(scoreIdFor(base)).toBe(scoreIdFor({ ...base }))
    expect(scoreIdFor(base)).toMatch(/^[0-9a-f]{32}$/)
    expect(scoreIdFor(base)).not.toBe(scoreIdFor({ ...base, user_id: 'v' }))
    expect(scoreIdFor(base)).not.toBe(scoreIdFor({ ...base, signal: 'job_dismissed' }))
    expect(scoreIdFor(base)).not.toBe(scoreIdFor({ ...base, subject_id: 'k' }))
  })

  it('a failed send adds an attempt and leaves the event pending; the fifth marks it failed', async () => {
    sendScoresMock.mockResolvedValue(false)
    const { admin, tables } = fakeAdmin({ feedback_events: [event({ attempts: 0 }), event({ id: 'ev-2', subject_id: 'msg-2', attempts: MAX_ATTEMPTS - 1 })] })
    const out = await exportFeedback(admin, { now: NOW })
    expect(out).toMatchObject({ sent: 0, failed: 2 })
    expect(tables.feedback_events[0]).toMatchObject({ attempts: 1, status: 'pending' })
    expect(tables.feedback_events[1]).toMatchObject({ attempts: MAX_ATTEMPTS, status: 'failed' })
  })

  it('without Langfuse configured it changes nothing and leaves every event pending', async () => {
    configured = false
    const { admin, tables } = fakeAdmin({ feedback_events: [event()] })
    const out = await exportFeedback(admin, { now: NOW })
    expect(out).toEqual({ sent: 0, skipped: 0, failed: 0, deleted: 0 })
    expect(sendScoresMock).not.toHaveBeenCalled()
    expect(tables.feedback_events[0]).toMatchObject({ status: 'pending', attempts: 0 })
  })

  it('sends a late outcome (a reply days later) with its comment, on the original trace', async () => {
    const { admin } = fakeAdmin({
      feedback_events: [event({ signal: 'outreach_replied', comment: 'positive', traced_at: daysAgo(9), occurred_at: daysAgo(0) })],
    })
    await exportFeedback(admin, { now: NOW })
    expect(sendScoresMock.mock.calls[0][0][0]).toMatchObject({ name: 'outreach_replied', comment: 'positive', traceId: 'a'.repeat(32) })
  })
})

describe('recordFeedback', () => {
  it('queues an event and ignores a repeat of the same one', async () => {
    const { admin, upserts } = fakeAdmin({})
    await recordFeedback(admin, { userId: 'user-1', signal: 'draft_approved', subjectTable: 'application_drafts', subjectId: 'd-1', traceId: 'c'.repeat(32), comment: 'x'.repeat(300) })
    expect(upserts[0]).toMatchObject({ user_id: 'user-1', signal: 'draft_approved', subject_table: 'application_drafts', subject_id: 'd-1', trace_id: 'c'.repeat(32), observation_id: null })
    expect((upserts[0].comment as string).length).toBe(200)
  })
})
