// The plan gate against a real agent loop: a scripted model, a checkpointer, tools that record what ran, and an
// in-memory database. What is checked is what ran, in what order, and what the rows say.

import { describe, expect, it } from 'vitest'
import { createAgent, createMiddleware, tool } from 'langchain'
import { Command, MemorySaver, interrupt } from '@langchain/langgraph'
import { HumanMessage } from '@langchain/core/messages'
import { z } from 'zod'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import { ScriptedChatModel, callTools, say } from '@/lib/agents/testing/scripted-model'
import { PLAN_ABOVE, planGate, type PlanInterrupt } from './plan'

type Row = Record<string, unknown>

function scene() {
  const admin = makeFakeAdmin({
    person_jobs: [
      { id: 'j1', viewer_id: 'u1', title: 'Staff Engineer', viewer_company_name: 'Acme' },
      { id: 'j2', viewer_id: 'u1', title: 'Designer', viewer_company_name: 'Globex' },
      { id: 'j3', viewer_id: 'u1', title: 'Analyst', viewer_company_name: null },
      { id: 'j4', viewer_id: 'u1', title: 'Support Lead', viewer_company_name: 'Initech' },
    ],
    contacts: [{ id: 'c1', user_id: 'u1', name: 'Dana Lee' }],
  })
  const scope = { db: admin, userId: 'u1', threadId: 'chat-1', chatId: 'chat-1', turnId: 'turn-1', model: 'test/scripted', rung: 'free' }
  const ran: string[] = []
  const record = (name: string) => async (args: Record<string, unknown>) => {
    ran.push(`${name} ${JSON.stringify(args)}`)
    return 'ok'
  }
  const tools = [
    tool(record('applications_start'), { name: 'applications_start', description: 'Start.', schema: z.object({ job_id: z.string().optional(), job_ids: z.array(z.string()).optional() }) }),
    tool(record('documents_draft'), { name: 'documents_draft', description: 'Draft.', schema: z.object({ type: z.string(), job_id: z.string().optional(), contact_id: z.string().optional() }) }),
    tool(record('task'), { name: 'task', description: 'Delegate.', schema: z.object({ description: z.string() }) }),
    tool(record('read_thing'), { name: 'read_thing', description: 'Read.', schema: z.object({}) }),
  ]
  const rows = () => (admin.tables.agent_tasks ?? []) as Row[]
  const plan = () => rows().find((r) => r.command === 'chat.plan')
  const steps = () => rows().filter((r) => r.command === 'chat.plan.step')
  const build = (model: ScriptedChatModel, saver: MemorySaver, extra: unknown[] = []) =>
    createAgent({ model, tools, middleware: [...extra, planGate(scope)] as never, checkpointer: saver }) as unknown as Built
  return { admin, scope, ran, tools, rows, plan, steps, build }
}

// The graph's own types are deep; the tests only invoke it and read the messages and the interrupt back.
type Built = { invoke: (input: unknown, config?: { configurable: { thread_id: string } }) => Promise<{ messages: { content: unknown; tool_calls?: unknown[] }[]; __interrupt__?: { value: unknown }[] }> }
const cfg = { configurable: { thread_id: 'thread-1' } }
const start = (agent: Built, thread = cfg) => agent.invoke({ messages: [new HumanMessage('do it')] }, thread)
const resume = (agent: Built, value: unknown, thread = cfg) => agent.invoke(new Command({ resume: value }), thread)

// Four things: two applications, a draft and a piece of research.
const four = () =>
  callTools([
    { name: 'applications_start', args: { job_id: 'j1' }, id: 'a1' },
    { name: 'applications_start', args: { job_id: 'j2' }, id: 'a2' },
    { name: 'documents_draft', args: { type: 'cover_letter', job_id: 'j1' }, id: 'd1' },
    { name: 'task', args: { description: 'Acme hiring plans' }, id: 't1' },
  ])

describe('the plan gate', () => {
  it('runs nothing and lists the steps when four things would be touched', async () => {
    const s = scene()
    const model = new ScriptedChatModel({ script: [four(), say('done')] })
    const paused = await start(s.build(model, new MemorySaver()))
    const plan = s.plan()!
    expect(PLAN_ABOVE).toBe(3)
    expect(paused.__interrupt__?.[0]?.value).toEqual({ kind: 'plan', plan_id: plan.id as string } satisfies PlanInterrupt)
    expect(s.ran).toEqual([])
    expect(plan).toMatchObject({ command: 'chat.plan', status: 'waiting', title: 'Plan: 4 things', parent_id: null, user_id: 'u1', chat_id: 'chat-1', thread_id: 'chat-1', turn_id: 'turn-1', model: 'test/scripted', rung: 'free' })
    const steps = s.steps()
    expect(steps.map((r) => [r.status, r.parent_id, r.branch_index])).toEqual([0, 1, 2, 3].map((i) => ['queued', plan.id, i]))
    expect(steps.map((r) => (r.object as Row).tool_call_id)).toEqual(['a1', 'a2', 'd1', 't1'])
    expect(model.calls).toHaveLength(1)
  })

  it('runs only the kept steps in the kept order', async () => {
    const s = scene()
    const model = new ScriptedChatModel({ script: [four(), say('done')] })
    const saver = new MemorySaver()
    const agent = s.build(model, saver)
    await start(agent)
    const plan = s.plan()!
    const [a1, a2, d1, t1] = s.steps().map((r) => r.id as string)

    const out = await resume(agent, { plan_id: plan.id, keep: [t1, a2, d1] })
    expect(s.ran).toEqual(['task {"description":"Acme hiring plans"}', 'applications_start {"job_id":"j2"}', 'documents_draft {"type":"cover_letter","job_id":"j1"}'])
    // The model spoke twice: the ask and the answer. Nothing between the steps.
    expect(model.calls).toHaveLength(2)
    expect(String(out.messages.at(-1)?.content)).toBe('done')
    expect(s.plan()).toMatchObject({ status: 'done', summary: 'Kept 3 of 4' })
    expect(s.plan()?.finished_at).toBeTruthy()
    const byId = (id: string) => s.steps().find((r) => r.id === id)!
    expect(byId(a1)).toMatchObject({ status: 'stopped', summary: 'Removed by you' })
    expect(byId(a1).finished_at).toBeTruthy()
    for (const id of [t1, a2, d1]) expect(byId(id)).toMatchObject({ status: 'done', summary: 'Started' })
    expect([t1, a2, d1].map((id) => byId(id).branch_index)).toEqual([0, 1, 2])
    // No rows beyond the plan and its four steps.
    expect(s.rows()).toHaveLength(5)
  })

  it('needs no plan for three', async () => {
    const s = scene()
    const three = callTools([
      { name: 'applications_start', args: { job_id: 'j1' } },
      { name: 'documents_draft', args: { type: 'note' } },
      { name: 'task', args: { description: 'x' } },
      { name: 'read_thing', args: {} },
    ])
    const model = new ScriptedChatModel({ script: [three, say('done')] })
    const out = await start(s.build(model, new MemorySaver()))
    expect(out.__interrupt__).toBeUndefined()
    expect([...s.ran].sort()).toEqual(['applications_start {"job_id":"j1"}', 'documents_draft {"type":"note"}', 'read_thing {}', 'task {"description":"x"}'])
    expect(s.rows()).toEqual([])
    expect(model.calls).toHaveLength(2)
  })

  it('counts every action of the turn, not just the last message', async () => {
    const s = scene()
    const two = (id: string) => callTools([{ name: 'applications_start', args: { job_ids: ['j1', 'j2'] }, id }])
    const model = new ScriptedChatModel({ script: [two('first'), two('second'), say('done')] })
    const paused = await start(s.build(model, new MemorySaver()))
    // Two ran; the next two would be four things in all, so only they wait.
    expect(s.ran).toHaveLength(1)
    expect(paused.__interrupt__?.[0]?.value).toMatchObject({ kind: 'plan' })
    expect(s.plan()).toMatchObject({ status: 'waiting', title: 'Plan: 2 things' })
  })

  it('cancels with nothing run', async () => {
    const s = scene()
    const model = new ScriptedChatModel({ script: [four(), say('never')] })
    const agent = s.build(model, new MemorySaver())
    await start(agent)
    // Cancel is written by the route, which does not resume the graph.
    s.plan()!.status = 'stopped'
    const out = await resume(agent, { plan_id: s.plan()!.id, keep: null })
    expect(s.ran).toEqual([])
    expect(model.calls).toHaveLength(1)
    expect(out.messages.at(-1)?.tool_calls ?? []).toEqual([])
  })

  it('titles each step from rows, never from the model', async () => {
    const s = scene()
    const model = new ScriptedChatModel({
      script: [
        callTools([
          { name: 'applications_start', args: { job_id: 'j1' } },
          { name: 'applications_start', args: { job_id: 'j3' } },
          { name: 'applications_start', args: { job_id: 'gone' } },
          { name: 'documents_draft', args: { type: 'follow_up', job_id: 'j2' } },
          { name: 'documents_draft', args: { type: 'reply', contact_id: 'c1' } },
          { name: 'documents_draft', args: { type: 'note' } },
          { name: 'task', args: { description: `Look   into\n${'Acme '.repeat(30)}` } },
        ]),
      ],
    })
    await start(s.build(model, new MemorySaver()))
    expect(s.steps().map((r) => r.title)).toEqual([
      'Start an application: Staff Engineer at Acme',
      'Start an application: Analyst',
      'Start an application: a role that is not in your stored roles',
      'Write a follow up for Designer at Globex',
      'Write a reply to Dana Lee',
      'Write a note',
      `Research: ${`Look into ${'Acme '.repeat(30)}`.trim().slice(0, 80)}`,
    ])
    expect(s.plan()?.title).toBe('Plan: 7 things')
  })

  it('splits several roles into one step each', async () => {
    const s = scene()
    const model = new ScriptedChatModel({
      script: [
        callTools([
          { name: 'applications_start', args: { job_ids: ['j1', 'j2', 'j2', 'j4'] }, id: 'multi' },
          { name: 'documents_draft', args: { type: 'note' }, id: 'n1' },
        ]),
        say('done'),
      ],
    })
    const agent = s.build(model, new MemorySaver())
    await start(agent)
    expect(s.steps().map((r) => [(r.object as Row).tool_call_id, (r.object as Row).tool, (r.object as Row).args])).toEqual([
      ['multi:0', 'applications_start', { job_id: 'j1' }],
      ['multi:1', 'applications_start', { job_id: 'j2' }],
      ['multi:2', 'applications_start', { job_id: 'j4' }],
      ['n1', 'documents_draft', { type: 'note' }],
    ])
    const ids = s.steps().map((r) => r.id as string)
    await resume(agent, { plan_id: s.plan()!.id, keep: [ids[2], ids[0], ids[3]] })
    expect(s.ran).toEqual(['applications_start {"job_id":"j4"}', 'applications_start {"job_id":"j1"}', 'documents_draft {"type":"note"}'])
  })

  it('keeps the calls that change nothing, and runs them with the first step', async () => {
    const s = scene()
    const model = new ScriptedChatModel({ script: [callTools([{ name: 'read_thing', args: {}, id: 'r1' }, ...four().tool_calls!.map((c) => ({ name: c.name, args: c.args, id: c.id }))]), say('done')] })
    const agent = s.build(model, new MemorySaver())
    await start(agent)
    expect(s.ran).toEqual([])
    const ids = s.steps().map((r) => r.id as string)
    await resume(agent, { plan_id: s.plan()!.id, keep: [ids[3]] })
    expect([...s.ran].sort()).toEqual(['read_thing {}', 'task {"description":"Acme hiring plans"}'])
  })

  it('a planned step stopped by the person never runs', async () => {
    const s = scene()
    const model = new ScriptedChatModel({ script: [four(), say('done')] })
    const agent = s.build(model, new MemorySaver())
    await start(agent)
    const ids = s.steps().map((r) => r.id as string)
    s.steps()[1].stop_requested_at = new Date().toISOString()
    await resume(agent, { plan_id: s.plan()!.id, keep: ids })
    expect(s.ran.map((r) => r.split(' ')[0])).toEqual(['applications_start', 'documents_draft', 'task'])
    expect(s.ran.join('|')).not.toContain('"j2"')
    expect(s.steps()[1]).toMatchObject({ status: 'stopped', summary: 'Stopped by you' })
    expect(s.steps()[1].finished_at).toBeTruthy()
    expect(model.calls).toHaveLength(2)
  })

  it('a call added after the plan started gets an Added row', async () => {
    const s = scene()
    const extra = callTools([{ name: 'documents_draft', args: { type: 'note', contact_id: 'c1' }, id: 'extra' }])
    const model = new ScriptedChatModel({ script: [four(), extra, say('done')] })
    const agent = s.build(model, new MemorySaver())
    await start(agent)
    const ids = s.steps().map((r) => r.id as string)
    const out = await resume(agent, { plan_id: s.plan()!.id, keep: ids })
    expect(out.__interrupt__).toBeUndefined()
    expect(s.ran).toHaveLength(5)
    const added = s.rows().filter((r) => r.command === 'chat.plan.added')
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ parent_id: s.plan()!.id, status: 'done', title: 'Added: Write a note to Dana Lee', summary: 'Added after the plan started', turn_id: 'turn-1' })
    expect((added[0].object as Row).tool_call_id).toBe('extra')
    expect(s.rows().filter((r) => r.command === 'chat.plan')).toHaveLength(1)
  })

  it('a resumed slice after approval needs no new plan', async () => {
    const s = scene()
    const saver = new MemorySaver()
    const model = new ScriptedChatModel({ script: [four(), say('done')] })
    // The first slice ends after the first step ran: the turn moves to another request.
    let slice = false
    const sliceAfterFirst = createMiddleware({ name: 'Slice', beforeModel: () => (slice ? interrupt({ kind: 'slice' }) : undefined) })
    const first = s.build(model, saver, [sliceAfterFirst])
    await start(first)
    const ids = s.steps().map((r) => r.id as string)
    slice = true
    const paused = await resume(first, { plan_id: s.plan()!.id, keep: [ids[2], ids[0], ids[3]] })
    expect((paused as { __interrupt__?: { value: unknown }[] }).__interrupt__?.[0]?.value).toEqual({ kind: 'slice' })
    expect(s.ran).toHaveLength(1)

    slice = false
    const second = s.build(model, saver, [sliceAfterFirst])
    const out = await resume(second, 'continue')
    expect(s.ran.map((r) => r.split(' ')[0])).toEqual(['documents_draft', 'applications_start', 'task'])
    expect((out as { __interrupt__?: unknown }).__interrupt__).toBeUndefined()
    expect(s.rows().filter((r) => r.command === 'chat.plan')).toHaveLength(1)
    expect(model.calls).toHaveLength(2)
  })

  it('a decision that does not match the plan runs nothing', async () => {
    const bad = (ids: string[], planId: string): unknown[] => [
      { plan_id: 'another-plan', keep: ids },
      { plan_id: planId, keep: [] },
      { plan_id: planId, keep: [ids[0], ids[0]] },
      { plan_id: planId, keep: [ids[0], 'not-a-step'] },
      { plan_id: planId, keep: null },
      'continue',
    ]
    for (let i = 0; i < 6; i++) {
      const s = scene()
      const agent = s.build(new ScriptedChatModel({ script: [four(), say('done')] }), new MemorySaver())
      await start(agent)
      const ids = s.steps().map((r) => r.id as string)
      await expect(resume(agent, bad(ids, s.plan()!.id as string)[i])).rejects.toThrow('The plan answer does not match the plan.')
      expect(s.ran, `decision ${i}`).toEqual([])
      expect(s.plan()?.status).toBe('waiting')
    }
  })

  it('does not write the plan twice when the node runs again', async () => {
    const s = scene()
    const agent = s.build(new ScriptedChatModel({ script: [four(), say('done')] }), new MemorySaver())
    await start(agent)
    // A wrong answer re-enters the node from the top; the rows must stay as they were.
    await resume(agent, 'continue').catch(() => undefined)
    expect(s.rows()).toHaveLength(5)
  })
})
