// applications.start records the mode code chose on the created event, and refuses a mode in its input. It fans out
// over several roles (one row each), refuses a fourth start in one message, and a replayed call starts nothing new.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import { advanceOne } from '@/lib/advance'
import { attach } from '@/lib/chat/attach'
import { start } from '@/lib/pipeline/commands'
import type { CommandContext } from '../define'
import { applicationsStart } from './pipeline'

vi.mock('@/lib/pipeline/commands', () => ({ start: vi.fn() }))
vi.mock('@/lib/advance', () => ({ advanceOne: vi.fn(async () => null) }))
vi.mock('@/lib/chat/attach', () => ({ attach: vi.fn(async () => undefined), ledgerKey: (k: string, id: string) => `${k}:${id}` }))

const ok = { ok: true, replay: false, event: { id: 'e1' } }
const jobs = ['j1', 'j2', 'j3', 'j4'].map((id, i) => ({ id, viewer_id: 'u1', title: `Role ${i + 1}` }))
const apps = jobs.map((j, i) => ({ id: `a${i + 1}`, user_id: 'u1', job_id: j.id, state: 'needs_you' }))
const seed = (extra: Record<string, Record<string, unknown>[]> = {}) => makeFakeAdmin({ person_jobs: jobs, applications: apps, pipeline_events: [], agent_tasks: [], ...extra })
const ctx = (opts: { mode?: 'ask' | 'hands_off'; chat?: boolean; callKey?: string; db?: ReturnType<typeof seed> } = {}): CommandContext => {
  const db = opts.db ?? seed()
  return { door: 'chat', userId: 'u1', mode: opts.mode, callKey: opts.callKey, chat: opts.chat ? { chatId: 'c1', turnId: 't1' } : undefined, admin: () => db } as unknown as CommandContext
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(start).mockResolvedValue(ok as never)
})

describe('applications.start', () => {
  it('records the mode code chose on the created event, and refuses a mode in the input', async () => {
    const ask = await applicationsStart.run(ctx(), { job_id: 'j1' })
    expect(vi.mocked(start).mock.calls[0]?.[2]).toEqual({ payload: { mode: 'ask' } })
    expect(ask.sentence).toBe('Started Role 1. It is now needs you. Nothing was sent.')

    const off = await applicationsStart.run(ctx({ mode: 'hands_off' }), { job_id: 'j1' })
    expect(vi.mocked(start).mock.calls[1]?.[2]).toEqual({ payload: { mode: 'hands_off' } })
    expect(off.sentence).toBe('Started Role 1. It is now needs you. Send for me sends it from your browser when it is ready, within its limits.')

    // the input is strict: a mode typed by a model is not an input
    expect(applicationsStart.input.safeParse({ job_id: 'j1', mode: 'hands_off' }).success).toBe(false)
  })

  it('takes one role or a list of roles, not both and not neither', () => {
    expect(applicationsStart.input.safeParse({ job_id: 'j1' }).success).toBe(true)
    expect(applicationsStart.input.safeParse({ job_ids: ['j1', 'j2'] }).success).toBe(true)
    expect(applicationsStart.input.safeParse({ job_id: 'j1', job_ids: ['j2'] }).success).toBe(false)
    expect(applicationsStart.input.safeParse({}).success).toBe(false)
    expect(applicationsStart.input.safeParse({ job_ids: ['a', 'b', 'c', 'd'] }).success).toBe(false)
  })

  it('records the turn and the call on the created event', async () => {
    await applicationsStart.run(ctx({ chat: true, callKey: 't1:call_1' }), { job_id: 'j1' })
    expect(vi.mocked(start).mock.calls[0]?.[2]).toEqual({ payload: { mode: 'ask', turn_id: 't1', call_key: 't1:call_1' } })
  })

  it('fans out one row per role', async () => {
    const db = seed()
    const out = await applicationsStart.run(ctx({ chat: true, db }), { job_ids: ['j1', 'j2', 'j3'] })
    expect(db.tables.agent_tasks).toHaveLength(3)
    expect(db.tables.agent_tasks.map((r) => r.object)).toEqual(expect.arrayContaining([{ kind: 'role', ref: 'j1' }, { kind: 'role', ref: 'j2' }, { kind: 'role', ref: 'j3' }]))
    expect(db.tables.agent_tasks.every((r) => r.command === 'applications.start' && r.status === 'done' && r.turn_id === 't1')).toBe(true)
    expect(db.tables.agent_tasks.map((r) => r.title).sort()).toEqual(['Preparing Role 1', 'Preparing Role 2', 'Preparing Role 3'])
    expect(start).toHaveBeenCalledTimes(3)
    expect(out.sentence).toBe('Started 3 of 3: Role 1, Role 2, Role 3. Nothing was sent.')
    expect(out.applications).toEqual([
      { job_id: 'j1', application_id: 'a1', state: 'needs_you' },
      { job_id: 'j2', application_id: 'a2', state: 'needs_you' },
      { job_id: 'j3', application_id: 'a3', state: 'needs_you' },
    ])
    expect(out.application_id).toBe('a1')
  })

  it('a Stop pressed while one role is being prepared ends its row at once and leaves the others', async () => {
    const db = seed()
    let first = true
    vi.mocked(advanceOne).mockImplementation((() => (first ? ((first = false), new Promise(() => undefined)) : Promise.resolve(null))) as never)
    setTimeout(() => {
      const row = db.tables.agent_tasks.find((r) => (r.object as { ref?: string } | null)?.ref === 'j1')
      if (row) row.stop_requested_at = '2026-10-20T10:00:00Z'
    }, 100)
    const out = await applicationsStart.run(ctx({ chat: true, db }), { job_ids: ['j1', 'j2'] })
    expect(db.tables.agent_tasks.find((r) => (r.object as { ref?: string }).ref === 'j1')).toMatchObject({ status: 'stopped' })
    expect(db.tables.agent_tasks.find((r) => (r.object as { ref?: string }).ref === 'j2')).toMatchObject({ status: 'done' })
    expect(out.applications.map((a) => a.job_id)).toEqual(['j2'])
    expect(out.sentence).toBe('Started 1 of 2: Role 2. 1 could not start: Stopped by you. Nothing was sent.')
  }, 15_000)

  it('says which roles could not start', async () => {
    vi.mocked(start).mockImplementation((async (_c: unknown, jobId: string) => (jobId === 'j2' ? { ok: false, refusal: 'already', sentence: 'Cello is already working on this one.' } : ok)) as never)
    const out = await applicationsStart.run(ctx({ chat: true }), { job_ids: ['j1', 'j2'] })
    expect(out.sentence).toBe('Started 1 of 2: Role 1. 1 could not start: Cello is already working on this one. Nothing was sent.')
    expect(out.applications).toHaveLength(1)
  })

  it('refuses when none of several started', async () => {
    vi.mocked(start).mockResolvedValue({ ok: false, refusal: 'already', sentence: 'Cello is already working on this one.' } as never)
    await expect(applicationsStart.run(ctx({ chat: true }), { job_ids: ['j1', 'j2'] })).rejects.toMatchObject({ name: 'CommandRefusal', status: 409, message: 'Cello is already working on this one.' })
  })

  it('a replayed call starts nothing new', async () => {
    vi.mocked(start).mockResolvedValue({ ok: false, refusal: 'already', sentence: 'Cello is already working on this one.' } as never)
    const db = seed({ pipeline_events: [{ id: 'e1', user_id: 'u1', application_id: 'a1', kind: 'application.created', sentence: 'Cello started preparing this.', payload: { mode: 'ask', turn_id: 't1', call_key: 't1:call_1' }, created_at: '2026-10-20T10:00:00Z' }] })
    const out = await applicationsStart.run(ctx({ chat: true, db, callKey: 't1:call_1' }), { job_id: 'j1' })
    expect(out).toMatchObject({ sentence: 'Started Role 1. It is now needs you. Nothing was sent.', application_id: 'a1', state: 'needs_you' })
    expect(out.steps).toEqual(['Cello started preparing this.'])
    expect(attach).not.toHaveBeenCalled()
    expect(advanceOne).not.toHaveBeenCalled()
  })

  it('still refuses an already started role made in another turn', async () => {
    vi.mocked(start).mockResolvedValue({ ok: false, refusal: 'already', sentence: 'Cello is already working on this one.' } as never)
    const db = seed({ pipeline_events: [{ id: 'e1', user_id: 'u1', application_id: 'a1', kind: 'application.created', payload: { turn_id: 'other' } }] })
    await expect(applicationsStart.run(ctx({ chat: true, db }), { job_id: 'j1' })).rejects.toMatchObject({ status: 409, message: 'Cello is already working on this one.' })
  })

  it('still refuses a fourth start in one message', async () => {
    const db = seed({ agent_tasks: ['j1', 'j2', 'j3'].map((ref) => ({ id: `t-${ref}`, user_id: 'u1', turn_id: 't1', command: 'applications.start', object: { kind: 'role', ref } })) })
    expect(await applicationsStart.guard!(ctx({ chat: true, db }), { job_id: 'j4' })).toBe('Cello starts at most 3 applications in one message.')
    expect(await applicationsStart.guard!(ctx({ chat: true, db }), { job_ids: ['j4'] })).toBe('Cello starts at most 3 applications in one message.')
  })

  it('a replay is not refused by the per-message limit', async () => {
    const db = seed({ agent_tasks: ['j1', 'j2', 'j3'].map((ref) => ({ id: `t-${ref}`, user_id: 'u1', turn_id: 't1', command: 'applications.start', object: { kind: 'role', ref } })) })
    expect(await applicationsStart.guard!(ctx({ chat: true, db }), { job_ids: ['j1', 'j2', 'j3'] })).toBeNull()
    expect(await applicationsStart.guard!(ctx({ chat: true, db }), { job_id: 'j2' })).toBeNull()
  })
})
