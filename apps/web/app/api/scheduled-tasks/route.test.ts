// /api/scheduled-tasks, its [id] route and Run now: closed (404) while SCHEDULED_TASKS_ON is false, and
// once open, who may call them, what they refuse, and that the person (not a model) is the only one
// who can set "act within my rules".

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { makeFakeAdmin, type FakeAdmin } from '@/lib/agents/testing/fake-admin'

const flag = vi.hoisted(() => ({ on: true }))
const state = vi.hoisted(() => ({ user: { id: 'u1' } as { id: string } | null, admin: null as unknown, fire: vi.fn(async () => undefined) }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }) }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => state.admin }))
vi.mock('@/lib/agents/schedule-schemas', async (orig) => {
  const real = await orig<typeof import('@/lib/agents/schedule-schemas')>()
  return { ...real, get SCHEDULED_TASKS_ON() { return flag.on } }
})
vi.mock('@/lib/agents/scheduler', async (orig) => ({ ...(await orig<typeof import('@/lib/agents/scheduler')>()), fireContinue: state.fire }))

import { GET, POST } from './route'
import { DELETE, PATCH } from './[id]/route'
import { POST as run } from './[id]/run/route'

let admin: FakeAdmin
beforeEach(() => {
  vi.clearAllMocks()
  flag.on = true
  state.user = { id: 'u1' }
  admin = makeFakeAdmin(
    { profiles: [{ id: 'u1', is_demo: false, demo_expires_at: null }, { id: 'u2', is_demo: true, demo_expires_at: '2099-01-01T00:00:00Z' }] },
    { scheduled_tasks: { defaults: () => ({ id: crypto.randomUUID(), status: 'active', last_run_at: null, last_status: null, last_result: null, poked_at: null, created_at: new Date().toISOString() }) } }
  )
  state.admin = admin
})

const req = (method: string, body?: unknown) => new NextRequest('http://localhost/api/scheduled-tasks', { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) })
const valid = { name: 'Morning roles', instruction: 'Find new product roles in Austin.', schedule: { every: 'weekday', at: '08:00', timezone: 'America/Chicago' } }

describe('POST and GET /api/scheduled-tasks', () => {
  it('needs a signed in person', async () => {
    state.user = null
    expect((await GET()).status).toBe(401)
    expect((await POST(req('POST', valid))).status).toBe(401)
  })

  it('creates a task from a structured schedule and shows its card; no cron is accepted from outside', async () => {
    const res = await POST(req('POST', { ...valid, cron: '* * * * *' }))
    expect(res.status).toBe(201)
    const { task } = await res.json()
    expect(task).toMatchObject({ name: 'Morning roles', cron: '0 8 * * 1-5', timezone: 'America/Chicago', autonomy: 'ask', status: 'active' })
    expect(task.card.schedule).toMatch(/weekday/i)
    expect(task.next_run_at).toBeTruthy()
    const list = await (await GET()).json()
    expect(list.tasks).toHaveLength(1)
    expect(list.tasks[0].card).toBeDefined()
  })

  it('a bad body or a bad time zone is a 400 with what to fix', async () => {
    expect((await POST(req('POST', { name: 'x' }))).status).toBe(400)
    const bad = await POST(req('POST', { ...valid, schedule: { ...valid.schedule, timezone: 'Mars/Olympus' } }))
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: expect.stringContaining('not a time zone'), fix: expect.stringContaining('IANA') })
    expect(admin.tables.scheduled_tasks ?? []).toHaveLength(0)
  })

  it('a demo cannot schedule anything', async () => {
    state.user = { id: 'u2' }
    const res = await POST(req('POST', valid))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'Demo accounts cannot schedule tasks.' })
    expect(admin.tables.scheduled_tasks ?? []).toHaveLength(0)
  })

  it('the person can set act within my rules here, with the rules named', async () => {
    const res = await POST(req('POST', { ...valid, autonomy: 'act', rules: { allow_send_email: true } }))
    expect((await res.json()).task).toMatchObject({ autonomy: 'act', rules: { allow_send_email: true } })
  })
})

describe('PATCH and DELETE /api/scheduled-tasks/[id]', () => {
  const at = (id: string) => ({ params: { id } })

  async function made() {
    return (await (await POST(req('POST', valid))).json()).task.id as string
  }

  it('pauses and resumes, recomputing when it is next due', async () => {
    const id = await made()
    const paused = (await (await PATCH(req('PATCH', { status: 'paused' }), at(id))).json()).task
    expect(paused).toMatchObject({ status: 'paused', next_run_at: null })
    const resumed = (await (await PATCH(req('PATCH', { status: 'active' }), at(id))).json()).task
    expect(resumed.status).toBe('active')
    expect(new Date(resumed.next_run_at).getTime()).toBeGreaterThan(Date.now())
  })

  it('a new schedule changes the cron', async () => {
    const id = await made()
    const out = (await (await PATCH(req('PATCH', { schedule: { every: 'day', at: '06:30', timezone: 'UTC' } }), at(id))).json()).task
    expect(out).toMatchObject({ cron: '30 6 * * *', timezone: 'UTC' })
  })

  it('an empty change is a 400, and another persons task is not found', async () => {
    const id = await made()
    expect((await PATCH(req('PATCH', {}), at(id))).status).toBe(400)
    state.user = { id: 'u3' }
    expect((await PATCH(req('PATCH', { status: 'paused' }), at(id))).status).toBe(404)
    expect((await DELETE(req('DELETE'), at(id))).status).toBe(404)
    state.user = { id: 'u1' }
    expect(admin.tables.scheduled_tasks).toHaveLength(1)
  })

  it('deletes a task', async () => {
    const id = await made()
    expect(await (await DELETE(req('DELETE'), at(id))).json()).toEqual({ deleted: true })
    expect(admin.tables.scheduled_tasks).toHaveLength(0)
  })
})

describe('POST /api/scheduled-tasks/[id]/run', () => {
  const at = (id: string) => ({ params: { id } })

  it('starts the task now with a signed request that forces it, and answers 202', async () => {
    const id = (await (await POST(req('POST', valid))).json()).task.id as string
    const res = await run(req('POST'), at(id))
    expect(res.status).toBe(202)
    expect(state.fire).toHaveBeenCalledWith({ reason: 'due', scheduled_task_id: id, force: true })
  })

  it('does nothing for a task that is not the persons, or for a demo, or without signing in', async () => {
    const id = (await (await POST(req('POST', valid))).json()).task.id as string
    state.user = { id: 'u3' }
    expect((await run(req('POST'), at(id))).status).toBe(404)
    state.user = null
    expect((await run(req('POST'), at(id))).status).toBe(401)
    admin.tables.scheduled_tasks.push({ id: 'demo-task', user_id: 'u2', name: 'x', instruction: 'x', cron: '0 8 * * *', timezone: 'UTC', autonomy: 'ask', rules: {}, status: 'active' })
    state.user = { id: 'u2' }
    expect((await run(req('POST'), at('demo-task'))).status).toBe(403)
    expect(state.fire).not.toHaveBeenCalled()
  })
})

describe('while scheduled tasks are closed', () => {
  const at = (id: string) => ({ params: { id } })

  it('every method answers 404 and touches nothing', async () => {
    flag.on = false
    const answers = [
      await GET(),
      await POST(req('POST', valid)),
      await PATCH(req('PATCH', { status: 'paused' }), at('t1')),
      await DELETE(req('DELETE'), at('t1')),
      await run(req('POST'), at('t1')),
    ]
    expect(answers.map((r) => r.status)).toEqual([404, 404, 404, 404, 404])
    expect(admin.log).toEqual([])
    expect(state.fire).not.toHaveBeenCalled()
  })

  it('stay closed until the flag is turned on in code', async () => {
    const real = await vi.importActual<typeof import('@/lib/agents/schedule-schemas')>('@/lib/agents/schedule-schemas')
    expect(real.SCHEDULED_TASKS_ON).toBe(false)
  })
})
