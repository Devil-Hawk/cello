// applications.start records the mode code chose for the turn on the created event, and refuses a mode in its input.

import { describe, expect, it, vi } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import type { CommandContext } from '../define'
import { applicationsStart } from './pipeline'

const starts: unknown[][] = []
vi.mock('@/lib/pipeline/commands', () => ({ start: vi.fn(async (...args: unknown[]) => (starts.push(args), { ok: true, replay: false, event: { id: 'e1' } })) }))
vi.mock('@/lib/advance', () => ({ advanceOne: vi.fn(async () => null) }))
vi.mock('@/lib/chat/attach', () => ({ attach: vi.fn(async () => undefined), ledgerKey: (k: string, id: string) => `${k}:${id}` }))

const db = () => makeFakeAdmin({ person_jobs: [{ id: 'j1', viewer_id: 'u1', title: 'Engineer' }], applications: [{ id: 'a1', user_id: 'u1', job_id: 'j1', state: 'needs_you' }], pipeline_events: [], agent_tasks: [] })
const ctx = (mode?: 'ask' | 'hands_off'): CommandContext => ({ door: 'chat', userId: 'u1', mode, admin: db } as unknown as CommandContext)

describe('applications.start', () => {
  it('records the mode code chose on the created event, and refuses a mode in the input', async () => {
    starts.length = 0
    const ask = await applicationsStart.run(ctx(), { job_id: 'j1' })
    expect(starts[0]?.[2]).toEqual({ payload: { mode: 'ask' } })
    expect(ask.sentence).toBe('Started Engineer. It is now needs you. Nothing was sent.')

    const off = await applicationsStart.run(ctx('hands_off'), { job_id: 'j1' })
    expect(starts[1]?.[2]).toEqual({ payload: { mode: 'hands_off' } })
    expect(off.sentence).toBe('Started Engineer. It is now needs you. Send for me sends it from your browser when it is ready, within its limits.')

    // the input is strict: a mode typed by a model is not an input
    expect(applicationsStart.input.safeParse({ job_id: 'j1', mode: 'hands_off' }).success).toBe(false)
  })
})
