// POST /api/chat/[id]/stream: a typed message is stored and streamed; a plan answer resumes the turn that waits.

import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const run = vi.hoisted(() => ({
  findWaitingPlan: vi.fn(),
  resumePlanTurn: vi.fn(),
  runStoredTurn: vi.fn(),
  storePersonTurn: vi.fn(),
}))
const db = vi.hoisted(() => ({}))

vi.mock('@/lib/chat/run', () => ({ ...run, BUSY_LINE: 'Cello is still finishing something in this chat. Try again in a minute.' }))
vi.mock('../../door', async (orig) => ({ ...(await orig<typeof import('../../door')>()), chatSession: async () => ({ userId: 'u1', db }) }))
vi.mock('@vercel/functions', () => ({ waitUntil: () => undefined }))
vi.mock('@/lib/chat/settings', () => ({ writeSettings: vi.fn() }))
vi.mock('@/lib/harness/keys', () => ({ loadApiKeys: async () => ({}) }))

import { POST } from './route'

const PLAN = '11111111-1111-4111-8111-111111111111'
const S1 = '22222222-2222-4222-8222-222222222221'
const S2 = '22222222-2222-4222-8222-222222222222'
const S3 = '22222222-2222-4222-8222-222222222223'
const waiting = { planId: PLAN, turnId: 't1', rootId: 'root1', stepIds: [S1, S2] }

const post = (body: unknown) => POST(new NextRequest('http://localhost/api/chat/c1/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: { id: 'c1' } })
const resume = (keep: unknown, plan_id: unknown = PLAN) => post({ input: undefined, command: { resume: { plan_id, keep } } })
const events = async (res: Response) =>
  (await res.text())
    .split('\n\n')
    .filter((chunk) => chunk.includes('event:'))
    .map((chunk) => ({ event: /event: (.*)/.exec(chunk)![1], data: JSON.parse(/data: (.*)/.exec(chunk)![1]) }))

beforeEach(() => {
  for (const f of Object.values(run)) f.mockReset()
  run.findWaitingPlan.mockResolvedValue(waiting)
  run.resumePlanTurn.mockResolvedValue(true)
  run.runStoredTurn.mockResolvedValue(true)
  run.storePersonTurn.mockResolvedValue({ id: 't2', typed: 'Hello', quoted: null })
})

describe('a plan answer', () => {
  it('resumes a waiting plan with the kept steps', async () => {
    const res = await resume([S2, S1])
    expect(res.status).toBe(200)
    expect(run.findWaitingPlan).toHaveBeenCalledWith(db, 'u1', 'c1', PLAN)
    expect(run.resumePlanTurn).toHaveBeenCalledWith(db, 'u1', 'c1', waiting, { plan_id: PLAN, keep: [S2, S1] }, expect.objectContaining({ emit: expect.any(Function) }))
    expect(run.storePersonTurn).not.toHaveBeenCalled()
    expect(run.runStoredTurn).not.toHaveBeenCalled()
    expect(await events(res)).toEqual([{ event: 'metadata', data: { thread_id: 'c1', turn_id: 't1' } }])
  })

  it('cancels with keep null', async () => {
    const res = await resume(null)
    expect(res.status).toBe(200)
    expect(run.resumePlanTurn).toHaveBeenCalledWith(db, 'u1', 'c1', waiting, { plan_id: PLAN, keep: null }, expect.anything())
    await res.text()
  })

  it('says the chat is busy when the turn could not be taken', async () => {
    run.resumePlanTurn.mockResolvedValue(false)
    expect(await events(await resume([S1]))).toEqual([
      { event: 'metadata', data: { thread_id: 'c1', turn_id: 't1' } },
      { event: 'custom', data: { type: 'busy', text: 'Cello is still finishing something in this chat. Try again in a minute.' } },
    ])
  })

  it('refuses a plan that is not waiting or a step that is not in it', async () => {
    run.findWaitingPlan.mockResolvedValue(null)
    const gone = await resume([S1])
    expect(gone.status).toBe(409)
    expect(await gone.json()).toEqual({ error: 'refused', message: 'This plan is no longer waiting. Ask again in a new message.' })
    run.findWaitingPlan.mockResolvedValue(waiting)
    const changed = await resume([S1, S3])
    expect(changed.status).toBe(400)
    expect(await changed.json()).toMatchObject({ message: 'That plan changed. Open the chat again.' })
    // The shape of the answer: not a uuid, empty, repeated, too many, an extra field, or no plan.
    const unclear = { error: 'bad_request', message: 'That answer to the plan was not understood. Open the chat again.' }
    for (const bad of [[], [S1, S1], ['x'], 'all', Array.from({ length: 51 }, (_, i) => `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`)]) {
      const res = await resume(bad)
      expect([res.status, await res.json()]).toEqual([400, unclear])
    }
    expect((await resume([S1], 'nope')).status).toBe(400)
    expect((await post({ command: { resume: { plan_id: PLAN, keep: [S1], more: 1 } } })).status).toBe(400)
    expect((await post({ command: { resume: null } })).status).toBe(400)
    expect(run.resumePlanTurn).not.toHaveBeenCalled()
  })
})

describe('a typed message', () => {
  it('still stores and streams a typed message', async () => {
    const res = await post({ input: { messages: [{ type: 'human', content: 'Hello' }] }, context: {} })
    expect(res.status).toBe(200)
    expect(run.storePersonTurn).toHaveBeenCalledWith(db, 'u1', 'c1', { typed: 'Hello', quoted: null })
    expect(run.runStoredTurn).toHaveBeenCalledWith(db, 'u1', 'c1', { id: 't2', typed: 'Hello', quoted: null }, { emit: expect.any(Function) })
    expect(run.findWaitingPlan).not.toHaveBeenCalled()
    expect(await events(res)).toEqual([{ event: 'metadata', data: { thread_id: 'c1', turn_id: 't2' } }])
  })

  it('asks for words when there are none', async () => {
    expect((await post({ input: { messages: [] } })).status).toBe(400)
    expect(run.storePersonTurn).not.toHaveBeenCalled()
  })
})
