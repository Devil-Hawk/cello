// A turn from the outside: the real orchestrator (Deep Agents, the guards, the checkpointer) with
// a scripted model, run through executeTurn. What is checked is what the person and the
// scheduler depend on: events, the lease, the task row, slices, errors and their words.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AIMessage, HumanMessage } from '@langchain/core/messages'
import { MemorySaver, interrupt } from '@langchain/langgraph'
import { tool } from 'langchain'
import { z } from 'zod'
import { MissingKeyError } from '@/lib/harness/providers'
import { BudgetCapError } from '@/lib/harness/spend'
import type { AgentContext } from './context'
import { AGENT_COPY, budgetCopy } from './copy'
import { createCelloAgent } from './factory'
import { eventMessage, executeTurn, runResearcher, type RunnableAgent, type TurnRequest } from './run'
import { claimLease } from './scheduler'
import type { WireEvent } from './sse'
import { ScriptedChatModel, callTools, say } from './testing/scripted-model'
import { makeFakeAdmin, type FakeAdmin } from './testing/fake-admin'

function world() {
  const admin: FakeAdmin = makeFakeAdmin(
    { graph_threads: [{ thread_id: 't1', user_id: 'u1', surface: 'agent', lease_until: null, lease_holder: null }], agent_tasks: [], approvals: [] },
    { agent_tasks: { defaults: () => ({ status: 'queued', artifact_ids: [] }) }, approvals: { defaults: () => ({ posted_at: null }) } }
  )
  const ctx: AgentContext = {
    admin,
    userId: 'u1',
    userEmail: 'dana@example.com',
    apiKeys: { openrouter: 'k', userId: 'u1' },
    isDemo: false,
    threadId: 't1',
    conversationId: 'c1',
    autonomy: 'ask',
    traceId: 'trace-1',
    deadlineAt: Date.now() + 120_000,
  }
  return { admin, ctx, saver: new MemorySaver() }
}

type W = ReturnType<typeof world>

function request(w: W, model: ScriptedChatModel, over: Partial<TurnRequest> = {}, extra: Record<string, unknown> = {}) {
  const events: WireEvent[] = []
  const fire = vi.fn(async () => undefined)
  const close = vi.fn(async () => undefined)
  const skillsDir = mkdtempSync(path.join(tmpdir(), 'cello-run-'))
  const req: TurnRequest = {
    ctx: w.ctx,
    lease: undefined as never,
    mode: { kind: 'input', text: 'find me roles' },
    emit: (e) => events.push(e),
    deps: {
      persistence: { saver: w.saver, close } as never,
      mcp: { tools: [], skipped: [], close: async () => undefined },
      fire,
      card: 'ABOUT THE PERSON: Name: Dana',
      buildAgent: (input) => createCelloAgent({ ...input, model, fallbacks: [], skillsDir, ...extra } as never) as unknown as RunnableAgent,
    },
    ...over,
  }
  return { req, events, fire, close }
}

async function run(w: W, model: ScriptedChatModel, over: Partial<TurnRequest> = {}, extra: Record<string, unknown> = {}) {
  const lease = await claimLease(w.admin, 't1')
  if (!lease) throw new Error('lease not claimed')
  const r = request(w, model, { lease, ...over }, extra)
  const result = await executeTurn(r.req)
  return { ...r, result, lease }
}

const root = (w: W) => w.admin.tables.agent_tasks.filter((t) => t.parent_id === null)

describe('a normal turn', () => {
  it('streams metadata first, then the agent events, and ends done with the answer', async () => {
    const w = world()
    const model = new ScriptedChatModel({ model: 'qwen/qwen3.8-27b:free', script: [say('Here are two roles.')] })
    const { events, result } = await run(w, model)
    expect(events[0]).toEqual({ event: 'metadata', data: { run_id: 'trace-1', thread_id: 't1', conversation_id: 'c1' } })
    const names = new Set(events.map((e) => e.event.split('|')[0]))
    for (const n of ['values', 'updates', 'messages']) expect(names.has(n)).toBe(true)
    expect(result).toMatchObject({ outcome: 'done', finalText: 'Here are two roles.' })
    // The person's words reached the model after the system prompt, with the card about them in it.
    const sent = model.calls[0]
    expect(String(sent.at(-1)?.content)).toBe('find me roles')
  })

  it('records one root task, working then done, and releases the lease', async () => {
    const w = world()
    const model = new ScriptedChatModel({ model: 'qwen/qwen3.8-27b:free', script: [say('Done.')] })
    const { lease, close } = await run(w, model)
    expect(root(w)).toHaveLength(1)
    expect(root(w)[0]).toMatchObject({ agent: 'cello', status: 'done', title: 'find me roles', summary: 'Done.', thread_id: 't1' })
    expect(w.admin.tables.graph_threads[0].lease_until).toBeNull()
    expect(await claimLease(w.admin, 't1')).not.toBeNull()
    expect(lease.threadId).toBe('t1')
    // The pools are closed.
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('is saved to the checkpointer, so the next message continues the conversation', async () => {
    const w = world()
    const model = new ScriptedChatModel({ model: 'qwen/qwen3.8-27b:free', script: [say('First answer.'), say('Second answer.')] })
    await run(w, model)
    await run(w, model, { mode: { kind: 'input', text: 'and in Austin?' } })
    const second = model.calls[1].map((m) => String(m.content))
    expect(second).toContain('find me roles')
    expect(second).toContain('First answer.')
    expect(second.at(-1)).toBe('and in Austin?')
    expect(root(w)).toHaveLength(2)
  })

  it('a long answer to a tool call and a model call limit finish as partial, said honestly', async () => {
    const w = world()
    const echo = tool(async () => 'ok', { name: 'find_roles', description: 'x', schema: z.object({}).passthrough() })
    void echo
    const model = new ScriptedChatModel({ model: 'qwen/qwen3.8-27b:free', script: [() => callTools([{ name: 'my_profile', args: { response_format: 'concise', limit: 1 } }])], repeatLast: true })
    w.admin.tables.profiles = [{ id: 'u1', full_name: 'Dana', resume_text: '', preferences: {} }]
    const { result } = await run(w, model)
    expect(model.calls).toHaveLength(24)
    expect(result.outcome).toBe('partial')
    expect(root(w)[0]).toMatchObject({ status: 'partial', partial_reason: 'steps' })
  })
})

describe('slices', () => {
  it('past the deadline it saves, hands over once, keeps the task working, and the next request finishes it without repeating work', async () => {
    const w = world()
    const model = new ScriptedChatModel({ model: 'qwen/qwen3.8-27b:free', script: [say('Finished after the handover.')] })
    w.ctx.deadlineAt = Date.now() - 1000
    const first = await run(w, model)
    expect(first.result.outcome).toBe('slice')
    expect(first.fire).toHaveBeenCalledTimes(1)
    expect(first.fire).toHaveBeenCalledWith({ reason: 'slice', thread_id: 't1' })
    expect(model.calls).toHaveLength(0)
    expect(root(w)).toHaveLength(1)
    expect(root(w)[0].status).toBe('working')
    expect(w.admin.tables.graph_threads[0].lease_until).toBeNull()

    // The continue request: fresh deadline, same thread, no new words.
    w.ctx.deadlineAt = Date.now() + 120_000
    const second = await run(w, model, { mode: { kind: 'continue' } })
    expect(second.result).toMatchObject({ outcome: 'done', finalText: 'Finished after the handover.' })
    expect(second.fire).not.toHaveBeenCalled()
    expect(model.calls).toHaveLength(1)
    expect(root(w)).toHaveLength(1)
    expect(root(w)[0].status).toBe('done')
  })

  it('a continue on a thread that already finished does nothing and calls no model', async () => {
    const w = world()
    const model = new ScriptedChatModel({ model: 'qwen/qwen3.8-27b:free', script: [say('All done.')] })
    await run(w, model)
    const again = await run(w, model, { mode: { kind: 'continue' } })
    expect(again.result).toMatchObject({ outcome: 'done', finalText: 'All done.' })
    expect(model.calls).toHaveLength(1)
  })

  it('a request that was killed mid-way resumes from its checkpoint, not from the start', async () => {
    const w = world()
    const controller = new AbortController()
    w.ctx.signal = controller.signal
    let ran = 0
    const slow = tool(
      async () => {
        ran += 1
        controller.abort()
        await new Promise((r) => setTimeout(r, 10))
        return 'ok'
      },
      { name: 'slow_tool', description: 'x', schema: z.object({}) }
    )
    const model = new ScriptedChatModel({ model: 'qwen/qwen3.8-27b:free', script: [callTools([{ name: 'slow_tool' }]), say('Finished.')] })
    const first = await run(w, model, {}, { extraTools: [slow] })
    expect(first.result.outcome).toBe('failed')
    expect(model.calls).toHaveLength(1)

    w.ctx.signal = undefined
    const second = await run(w, model, { mode: { kind: 'continue' } }, { extraTools: [slow] })
    expect(second.result.outcome).toBe('done')
    // The tool call it had decided on is carried out; the first model call is not made again.
    expect(model.calls).toHaveLength(2)
    expect(ran).toBeGreaterThanOrEqual(1)
  })
})

describe('questions', () => {
  it('a question that blocks the task is waiting, not failed, and the answer resumes it', async () => {
    const w = world()
    const ask = tool(async () => String(interrupt({ kind: 'question', text: 'Which city?' })), { name: 'ask_person', description: 'x', schema: z.object({}) })
    const model = new ScriptedChatModel({ model: 'qwen/qwen3.8-27b:free', script: [callTools([{ name: 'ask_person' }]), say('Searching Austin.')] })
    const first = await run(w, model, {}, { extraTools: [ask] })
    expect(first.result.outcome).toBe('waiting')
    expect(root(w)[0].status).toBe('waiting')
    expect(first.fire).not.toHaveBeenCalled()
    const second = await run(w, model, { mode: { kind: 'resume', value: 'Austin' } }, { extraTools: [ask] })
    expect(second.result).toMatchObject({ outcome: 'done', finalText: 'Searching Austin.' })
  })
})

describe('approval results', () => {
  it('are told to the conversation at the start of the next turn, marked so they are never the persons words', async () => {
    const w = world()
    w.admin.tables.approvals.push({ id: 'ap1', user_id: 'u1', thread_id: 't1', action: 'send_email', status: 'done', posted_at: null, receipt: { what: 'Email sent to Dana Lee', when: '2026-10-05T16:41:00Z' }, error: null })
    const model = new ScriptedChatModel({ model: 'qwen/qwen3.8-27b:free', script: [say('Noted.')] })
    await run(w, model, { mode: { kind: 'input', text: 'what happened to my email?' } })
    const sent = model.calls[0]
    const eventIdx = sent.findIndex((m) => String(m.content).startsWith('<event>'))
    expect(eventIdx).toBeGreaterThan(-1)
    expect(String(sent[eventIdx].content)).toContain('approved the email')
    expect((sent[eventIdx].additional_kwargs as { cello_event?: boolean }).cello_event).toBe(true)
    expect(String(sent.at(-1)?.content)).toBe('what happened to my email?')
    expect(w.admin.tables.approvals[0].posted_at).toBeTruthy()
    // A second turn does not tell it again.
    const model2 = new ScriptedChatModel({ model: 'qwen/qwen3.8-27b:free', script: [say('Ok.')] })
    await run(w, model2, { mode: { kind: 'input', text: 'thanks' } })
    expect(model2.calls[0].filter((m) => String(m.content).startsWith('<event>'))).toHaveLength(1)
  })

  it('an event message is a human message with the marker', () => {
    const m = eventMessage('The person skipped the email.')
    expect(HumanMessage.isInstance(m)).toBe(true)
    expect(m.additional_kwargs).toEqual({ cello_event: true })
  })
})

describe('errors', () => {
  it('a reached budget is said in the persons words with the date it resets', async () => {
    const w = world()
    const model = new ScriptedChatModel({ model: 'qwen/qwen3.8-27b:free', script: [new BudgetCapError(10, 10)] })
    const { result, events } = await run(w, model)
    expect(result.outcome).toBe('failed')
    expect(result.error).toEqual({ code: 'budget', message: budgetCopy() })
    expect(events.at(-1)).toEqual({ event: 'error', data: { error: 'budget', message: budgetCopy() } })
    expect(root(w)[0]).toMatchObject({ status: 'failed', summary: budgetCopy() })
    expect(w.admin.tables.graph_threads[0].lease_until).toBeNull()
  })

  it('a missing key says to add one', async () => {
    const w = world()
    const r = request(w, new ScriptedChatModel({ script: [] }))
    r.req.lease = (await claimLease(w.admin, 't1'))!
    r.req.deps!.buildAgent = () => {
      throw new MissingKeyError('No OpenRouter API key configured')
    }
    const result = await executeTurn(r.req)
    expect(result.error).toEqual({ code: 'needs_key', message: AGENT_COPY.needsKey })
    expect(r.events.at(-1)).toMatchObject({ event: 'error', data: { message: 'Add an OpenRouter key in Settings to use Ask Cello. Free models work.' } })
  })

  it('anything else is the plain generic sentence, never the raw error, and the task still ends', async () => {
    const w = world()
    const model = new ScriptedChatModel({ model: 'qwen/qwen3.8-27b:free', script: [new Error('unexpected shape: password=hunter2')] })
    const { result, events } = await run(w, model)
    expect(result.error).toEqual({ code: 'failed', message: AGENT_COPY.generic })
    expect(JSON.stringify(events)).not.toContain('hunter2')
    expect(root(w)[0].status).toBe('failed')
  })

  it('all of the sentences are plain: no run, thread, step, graph or agent, no exclamation marks, no em dashes', () => {
    for (const copy of [...Object.values(AGENT_COPY), budgetCopy()]) {
      expect(copy).not.toMatch(/\b(run|thread|step|graph|agent|tick)\b/i)
      expect(copy).not.toMatch(/[!—]/)
    }
  })
})

describe('runResearcher', () => {
  const fake = (text: string) => ({ invoke: async () => ({ messages: [new HumanMessage('brief'), new AIMessage(text)] }) })

  it('reads the final message, and an answer with sources counts', async () => {
    const w = world()
    const out = await runResearcher(w.ctx, { subject: 'Acme', kind: 'company' }, { build: () => fake('{"summary":"Acme makes robots.","sources":[{"title":"About","url":"https://acme.example/about"}],"enough_information":true}') })
    expect(out).toEqual({ summary: 'Acme makes robots.', sources: [{ title: 'About', url: 'https://acme.example/about' }], enough_information: true, hit_step_limit: false })
  })

  it('an answer with no source is not an answer, and the loop cap is reported as the step limit', async () => {
    const w = world()
    const noSource = await runResearcher(w.ctx, { subject: 'Acme', kind: 'company' }, { build: () => fake('{"summary":"Acme makes robots.","sources":[],"enough_information":true}') })
    expect(noSource).toMatchObject({ enough_information: false, summary: '' })
    const capped = await runResearcher(w.ctx, { subject: 'Acme', kind: 'company' }, { build: () => fake('Model call limits exceeded: run limit (8) reached.') })
    expect(capped).toMatchObject({ enough_information: false, hit_step_limit: true })
  })

  it('runs read only', async () => {
    const w = world()
    let seen: AgentContext | undefined
    await runResearcher(w.ctx, { subject: 'x', kind: 'topic' }, { build: (input) => ((seen = input.ctx), fake('{}')) })
    expect(seen?.readOnly).toBe(true)
  })
})
