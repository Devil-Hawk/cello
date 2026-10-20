// The factory builds a real Deep Agent with a scripted model, so what is checked here is the
// agent itself: its guards, its tools, its specialists, and how deep delegation can go.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HumanMessage, ToolMessage } from '@langchain/core/messages'
import { tool } from '@langchain/core/tools'
import { MemorySaver } from '@langchain/langgraph'
import { z } from 'zod'

vi.mock('@/lib/search', () => ({
  webSearch: async () => ({ ok: true, backend: 'test', results: [{ title: 'Acme', url: 'https://acme.example', snippet: 'Robots' }] }),
}))

import { MissingKeyError } from '@/lib/harness/providers'
import type { AgentContext } from './context'
import { SKILLS_OFF } from './backends'
import { createCelloAgent, researcherSpec, specialists } from './factory'
import { AGENT_CAPS, GUARD_ORDER, MAX_ANSWER_ASKS, recursionLimitFor } from './middleware'
import { ScriptedChatModel, callTools, say } from './testing/scripted-model'
import { makeFakeAdmin } from './testing/fake-admin'
import { CELLO_TOOLS } from './tools/registry'

function skills() {
  const dir = mkdtempSync(path.join(tmpdir(), 'cello-skills-'))
  for (const name of ['company-research', 'visa-sponsorship']) {
    mkdirSync(path.join(dir, name))
    writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill.\n---\n# ${name}\nFollow the ${name} procedure.\n`)
  }
  return dir
}

const ctx = (over: Partial<AgentContext> = {}): AgentContext => ({
  admin: makeFakeAdmin(),
  userId: 'u1',
  userEmail: 'dana@example.com',
  apiKeys: { openrouter: 'k', userId: 'u1' },
  isDemo: false,
  threadId: 't1',
  conversationId: 'c1',
  autonomy: 'ask',
  traceId: 'trace-1',
  deadlineAt: Date.now() + 120_000,
  ...over,
})

type Built = { options: { middleware: { name: string; tools?: { name: string; schema: unknown }[] }[]; tools: { name: string }[]; systemPrompt: string } }

function build(over: Record<string, unknown> = {}, model = new ScriptedChatModel({ model: 'google/gemma-4-26b-a4b-it:free', script: [say('ok')] })) {
  const input = { kind: 'orchestrator' as const, ctx: ctx(), saver: new MemorySaver(), model, fallbacks: [], skillsDir: skills(), ...over }
  return { agent: createCelloAgent(input as never) as unknown as Built, model }
}

const spec = () => researcherSpec({ ctx: ctx(), model: new ScriptedChatModel({ script: [] }), fallbacks: [], skillsDir: skills() } as never)

describe('createCelloAgent', () => {
  it('attaches every guard, in order, after the built-ins, and summarizes once', () => {
    const names = build().agent.options.middleware.map((m) => m.name)
    const ours = names.filter((n) => (GUARD_ORDER as readonly string[]).includes(n))
    expect(ours).toEqual([...GUARD_ORDER])
    expect(names.filter((n) => n === 'SummarizationMiddleware')).toHaveLength(1)
    // The delegation cap sits with the other call limits.
    expect(names).toContain('ToolCallLimitMiddleware[task]')
    expect(names.indexOf('CelloDemoRules')).toBeGreaterThan(names.indexOf('SummarizationMiddleware'))
  })

  it('holds the registered Cello tools, none named run or thread, and the file tools Deep Agents adds', () => {
    const names = build().agent.options.tools.map((t) => t.name)
    for (const n of CELLO_TOOLS.map((t) => t.name)) expect(names).toContain(n)
    expect(names).not.toContain('schedule_task')
    for (const n of names) expect(n).not.toMatch(/run|thread/i)
  })

  it('the task tool offers exactly scout, writer and the researcher under the reserved name', () => {
    const task = build().agent.options.middleware.find((m) => m.name === 'subAgentMiddleware')!.tools![0] as unknown as { description: string }
    for (const n of ['general-purpose', 'scout', 'writer']) expect(task.description).toContain(n)
    const names = specialists({ kind: 'orchestrator', ctx: ctx(), model: new ScriptedChatModel({ script: [] }), fallbacks: [], skillsDir: skills() } as never).map((s) => s.name)
    expect(names.sort()).toEqual(['general-purpose', 'scout', 'writer'])
  })

  it('gives the orchestrator its prompt and the card about the person', () => {
    const { agent } = build({ profileCard: 'ABOUT THE PERSON: Name: Dana Lee' })
    expect(agent.options.systemPrompt).toContain('You are Cello')
    expect(agent.options.systemPrompt).toContain('Name: Dana Lee')
  })

  it('loads the skills it is given and shows the orchestrator their names and descriptions', async () => {
    const dir = skills()
    mkdirSync(path.join(dir, 'role-fit'))
    writeFileSync(path.join(dir, 'role-fit', 'SKILL.md'), '---\nname: role-fit\ndescription: Judge how well a role fits the person.\n---\n# Role fit\nSay Strong, Possible or Stretch.\n')
    const { agent, model } = build({ skillsDir: dir, hiddenSkills: [] })
    await (agent as unknown as { invoke: (i: unknown, c: unknown) => Promise<unknown> }).invoke({ messages: [new HumanMessage('hi')] }, { configurable: { thread_id: 't-skills' } })
    const content = model.calls[0][0].content
    const system = typeof content === 'string' ? content : content.map((b) => (b as { text?: string }).text ?? '').join('')
    expect(system).toContain('role-fit')
    expect(system).toContain('Judge how well a role fits the person.')
  })

  it('shows the orchestrator all nine real skills, by name and description, when none is switched off', async () => {
    const { agent, model } = build({ skillsDir: path.join(process.cwd(), 'skills'), hiddenSkills: [] })
    await (agent as unknown as { invoke: (i: unknown, c: unknown) => Promise<unknown> }).invoke({ messages: [new HumanMessage('hi')] }, { configurable: { thread_id: 't-real-skills' } })
    const content = model.calls[0][0].content
    const system = typeof content === 'string' ? content : content.map((b) => (b as { text?: string }).text ?? '').join('')
    for (const name of ['role-fit', 'tailor-resume', 'cover-letter', 'cold-outreach', 'follow-up', 'company-research', 'visa-sponsorship', 'negotiation', 'search-strategy']) {
      expect(system, name).toContain(`**${name}**`)
    }
    expect(system).toContain('Judge how well one role fits the person')
  })

  it('cannot be built without an OpenRouter key, with an error the route turns into the key message', () => {
    expect(() => createCelloAgent({ kind: 'orchestrator', ctx: ctx({ apiKeys: {} }), saver: new MemorySaver(), skillsDir: skills() })).toThrow(MissingKeyError)
  })
})

describe('the Researcher', () => {
  it('is a spec with its own guard stack, read-only permissions, read tools and its skills in the prompt', () => {
    const s = spec()
    expect((s.middleware ?? []).map((m) => m.name).filter((n) => (GUARD_ORDER as readonly string[]).includes(n))).toEqual([...GUARD_ORDER])
    expect(s.permissions).toEqual([
      { operations: ['read'], paths: ['/**'], mode: 'allow' },
      { operations: ['write'], paths: ['/**'], mode: 'deny' },
    ])
    expect((s.tools ?? []).map((t) => t.name).sort()).toEqual(['people', 'read_page', 'search_knowledge', 'web_search'])
    expect(String(s.systemPrompt)).toContain('You research one company, person or topic')
    expect(String(s.systemPrompt)).toContain('Follow the company-research procedure.')
  })

  it('holds no tool that writes, saves, sends or delegates', () => {
    for (const t of spec().tools ?? []) expect(t.name).not.toMatch(/remember|create_artifact|update_artifact|request_approval|schedule_task|triage_role|pipeline|task|write|send/)
  })
})

describe('delegation is one level deep', () => {
  const answer = '{"summary":"Acme makes robots.","sources":[{"title":"About","url":"https://acme.example/about"}],"enough_information":true}'
  const task = callTools([{ name: 'task', args: { description: '{"subject":"Acme","kind":"company"}', subagent_type: 'general-purpose' } }])

  async function delegate(researcherScript: ConstructorParameters<typeof ScriptedChatModel>[0]['script'], repeatLast = false) {
    const researcherModel = new ScriptedChatModel({ model: 'google/gemma-4-26b-a4b-it:free', script: researcherScript, repeatLast })
    const orchestratorModel = new ScriptedChatModel({ model: 'google/gemma-4-26b-a4b-it:free', script: [task, say('Acme makes robots, per its own site.')] })
    const agent = createCelloAgent({
      kind: 'orchestrator',
      ctx: ctx(),
      saver: new MemorySaver(),
      model: orchestratorModel,
      researcherModel,
      fallbacks: [],
      skillsDir: skills(),
    }) as unknown as { invoke: (i: unknown, c: unknown) => Promise<{ messages: unknown[] }> }
    const out = await agent.invoke({ messages: [new HumanMessage('research Acme')] }, { configurable: { thread_id: `t-${Math.random()}` }, recursionLimit: 80 })
    return { out, researcherModel, orchestratorModel }
  }

  const taskResult = (messages: unknown[]) => messages.find((m) => ToolMessage.isInstance(m) && m.name === 'task') as ToolMessage

  it('the researcher runs on its own model with read tools and no task tool, and its answer comes back quoted as data', async () => {
    const { out, researcherModel, orchestratorModel } = await delegate([say(answer)])
    expect(researcherModel.calls).toHaveLength(1)
    expect(researcherModel.boundTools).toEqual(expect.arrayContaining(['web_search', 'read_page', 'search_knowledge', 'people']))
    // Depth is two: the orchestrator has the task tool, the specialist it delegated to does not.
    expect(orchestratorModel.boundTools).toContain('task')
    expect(researcherModel.boundTools).not.toContain('task')
    expect(String(taskResult(out.messages).content)).toContain('<untrusted_data source="task">')
    expect(String(taskResult(out.messages).content)).toContain('Acme makes robots.')
    expect(String((out.messages.at(-1) as { content: string }).content)).toBe('Acme makes robots, per its own site.')
  })

  it('a researcher that keeps searching stops at eight model calls, and the orchestrator carries on', async () => {
    const { out, researcherModel } = await delegate([() => callTools([{ name: 'web_search', args: { query: 'acme robots' } }])], true)
    expect(researcherModel.calls).toHaveLength(8)
    expect(String((out.messages.at(-1) as { content: string }).content)).toBe('Acme makes robots, per its own site.')
  })

  it('the researcher cannot write: a write_file call is denied by its permissions', async () => {
    const { out, researcherModel } = await delegate([callTools([{ name: 'write_file', args: { file_path: '/scratch/notes.md', content: 'x' } }]), say(answer)])
    expect(researcherModel.calls).toHaveLength(2)
    const denied = researcherModel.calls[1].find((m) => ToolMessage.isInstance(m)) as ToolMessage
    expect(String(denied.content)).toMatch(/denied|permission/i)
    expect(String(taskResult(out.messages).content)).toContain('Acme makes robots.')
  })
})

describe('no subagent runs above the highest the person allows', () => {
  const free = { openrouter: 'k', userId: 'u1', model: 'anthropic/claude-sonnet-5', models: { ceiling: 'R3' as const, order: [], creditBought: false } }

  it('the Researcher built for a Free person is on a free model, not the server default', () => {
    const s = researcherSpec({ ctx: ctx({ apiKeys: free }), fallbacks: [], skillsDir: skills() }, 'general-purpose')
    expect((s.model as unknown as { model: string }).model).toMatch(/:free$/)
  })

  it('gives the Researcher its own model, apart from the one Chat runs on', () => {
    const chat = new ScriptedChatModel({ model: 'google/gemma-4-26b-a4b-it:free', script: [] })
    const research = new ScriptedChatModel({ model: 'qwen/qwen3.8-27b:free', script: [] })
    const s = researcherSpec({ ctx: ctx(), model: chat, researcherModel: research, fallbacks: [], skillsDir: skills() }, 'general-purpose')
    expect(s.model).toBe(research)
    expect(s.model).not.toBe(chat)
  })

  it("the Researcher runs on the turn's model when one was resolved for it", () => {
    const model = new ScriptedChatModel({ model: 'google/gemma-4-26b-a4b-it:free', script: [] })
    expect(researcherSpec({ ctx: ctx(), model, fallbacks: [], skillsDir: skills() }, 'general-purpose').model).toBe(model)
  })
})

describe('the chat loop with a structured answer', () => {
  const Answer = z.object({ text: z.string().max(8) })
  const ping = tool(async () => 'pong', { name: 'ping', description: 'Ping.', schema: z.object({}) })
  // langchain names the answer tool extract-N from a counter shared by every agent, so the script reads the name the model was given.
  const answers = (...texts: string[]) => (model: () => ScriptedChatModel) => () => {
    const name = model().boundTools.find((n) => n.startsWith('extract-'))!
    return callTools(texts.map((text) => ({ name, args: { text } })))
  }
  const pings = (n: number) => () => () => callTools(Array.from({ length: n }, () => ({ name: 'ping' })))
  type Step = (model: () => ScriptedChatModel) => () => ReturnType<typeof callTools>
  const start = (steps: Step[], repeatLast = false, over: Partial<AgentContext> = {}) => {
    const model: ScriptedChatModel = new ScriptedChatModel({ model: 'google/gemma-4-26b-a4b-it:free', script: steps.map((step) => step(() => model)), repeatLast })
    const agent = createCelloAgent({ kind: 'chat', ctx: ctx(over), saver: new MemorySaver(), model, fallbacks: [], skillsDir: skills(), tools: [ping], responseFormat: Answer as never } as never)
    const invoke = (recursionLimit = 80) => (agent as unknown as { invoke: (i: unknown, c: unknown) => Promise<{ structuredResponse: unknown }> }).invoke({ messages: [new HumanMessage('hi')] }, { configurable: { thread_id: `t-${Math.random()}` }, recursionLimit })
    return { model, invoke }
  }
  const run = (...steps: Step[]) => start(steps).invoke()
  const bad = 'x'.repeat(30)

  it('keeps one structured answer as it is', async () => {
    expect((await run(answers('only'))).structuredResponse).toEqual({ text: 'only' })
  })

  it('keeps the first of two structured answers in one model message instead of crashing on jumpTo', async () => {
    expect((await run(answers('first', 'second'))).structuredResponse).toEqual({ text: 'first' })
  })

  it('asks again once when an answer does not fit the shape, and tells the model why', async () => {
    const { model, invoke } = start([answers(bad), answers('fixed')])
    expect((await invoke()).structuredResponse).toEqual({ text: 'fixed' })
    expect(model.calls).toHaveLength(2)
    const told = model.calls[1].filter((m) => ToolMessage.isInstance(m)).map((m) => String(m.content))
    expect(told.join('\n')).toMatch(/text/)
  })

  it('asks again when two answers in one message are both unusable, and when an answer comes after tool calls', async () => {
    const { model, invoke } = start([pings(2), answers(bad, bad), answers('fixed')])
    expect((await invoke()).structuredResponse).toEqual({ text: 'fixed' })
    expect(model.calls).toHaveLength(3)
  })

  it('runs parallel tool calls and then takes the answer', async () => {
    const { model, invoke } = start([pings(3), pings(2), answers('done')])
    expect((await invoke()).structuredResponse).toEqual({ text: 'done' })
    expect(model.calls).toHaveLength(3)
  })

  it('gives up on an answer that never fits after three tries, with its own error, not jumpTo or the step limit', async () => {
    const { model, invoke } = start([answers(bad)], true)
    const err = await invoke().then(() => null, (e: Error) => e)
    expect(String(err)).toMatch(/AnswerShapeError/)
    expect(String(err)).not.toMatch(/jumpTo|INVALID_CONCURRENT|Recursion/i)
    expect(model.calls).toHaveLength(MAX_ANSWER_ASKS)
  })

  it('reads Stop before it asks again, and asks nobody once the person has stopped', async () => {
    let reads = 0
    const { model, invoke } = start([answers(bad)], true, { stop: async () => ++reads > 1 })
    expect(String(await invoke().then(() => null, (e: Error) => e))).toMatch(/Stopped/)
    expect(model.calls).toHaveLength(1)
  })

  it('a model that keeps calling tools is ended by the model-call cap, politely, before the step limit', async () => {
    const { model, invoke } = start([pings(1)], true)
    const out = (await invoke(recursionLimitFor('orchestrator'))) as unknown as { messages: { content: unknown }[] }
    expect(model.calls).toHaveLength(AGENT_CAPS.orchestrator.modelCalls)
    expect(String(out.messages.at(-1)!.content)).toMatch(/model call limit/i)
  })

  it('the step limit sits above what the model-call cap needs', async () => {
    const { model, invoke } = start([pings(1)], true)
    await invoke(recursionLimitFor('orchestrator')).catch(() => null)
    expect(model.calls.length * 7).toBeLessThanOrEqual(recursionLimitFor('orchestrator'))
    // The old limit of 80 ended the same loop at 11 model calls with a GraphRecursionError.
    const old = start([pings(1)], true)
    expect(String(await old.invoke(80).then(() => null, (e: Error) => e))).toMatch(/Recursion/)
    expect(old.model.calls.length).toBeLessThan(AGENT_CAPS.orchestrator.modelCalls)
  })
})

describe('the plain chat core', () => {
  const Answer = z.object({ text: z.string() })
  const echo = tool(async ({ q }: { q: string }) => `found ${q}`, { name: 'roles_find', description: 'Find roles', schema: z.object({ q: z.string() }) })
  const make = (core: 'deep' | 'plain', script: ConstructorParameters<typeof ScriptedChatModel>[0]['script']) => {
    const model = new ScriptedChatModel({ model: 'google/gemma-4-26b-a4b-it:free', script })
    const agent = createCelloAgent({ kind: 'chat', core, ctx: ctx(), saver: new MemorySaver(), model, fallbacks: [], skillsDir: skills(), tools: [echo], responseFormat: Answer as never } as never) as unknown as Built & {
      invoke: (i: unknown, c: unknown) => Promise<{ structuredResponse: unknown }>
    }
    return { agent, model }
  }
  const finish = (model: () => ScriptedChatModel) => () => callTools([{ name: model().boundTools.find((n) => n.startsWith('extract-'))!, args: { text: 'done' } }])

  it('builds the plain core with the same tools, guards and answer shape', async () => {
    const guardsOf = (a: Built) => a.options.middleware.map((m) => m.name).filter((n) => (GUARD_ORDER as readonly string[]).includes(n))
    const deep = make('deep', [])
    const plain = make('plain', [])
    expect(plain.agent.options.tools.map((t) => t.name)).toEqual(['roles_find'])
    const deepTools = [...deep.agent.options.tools, ...deep.agent.options.middleware.flatMap((m) => m.tools ?? [])].map((t) => t.name)
    for (const n of ['task', 'ls', 'read_file', 'write_file', 'edit_file', 'glob', 'grep']) expect(deepTools).toContain(n)
    expect(plain.agent.options.middleware.map((m) => m.name)).not.toContain('subAgentMiddleware')
    expect(guardsOf(plain.agent)).toEqual([...GUARD_ORDER])
    expect(guardsOf(plain.agent)).toEqual(guardsOf(deep.agent))
    for (const core of ['deep', 'plain'] as const) {
      const m: { model: ScriptedChatModel } = { model: undefined as never }
      const built = make(core, [() => finish(() => m.model)()])
      m.model = built.model
      const out = await built.agent.invoke({ messages: [new HumanMessage('hi')] }, { configurable: { thread_id: `t-${Math.random()}` }, recursionLimit: 40 })
      expect(out.structuredResponse).toEqual({ text: 'done' })
    }
  })

  it('lets the deep chat core read a skill that is switched off when hiddenSkills is empty', async () => {
    const off = Object.keys(SKILLS_OFF)[0]
    const read = async (hiddenSkills?: string[]) => {
      const model: ScriptedChatModel = new ScriptedChatModel({ model: 'google/gemma-4-26b-a4b-it:free', script: [callTools([{ name: 'read_file', args: { file_path: `/skills/${off}/SKILL.md` } }]), () => finish(() => model)()] })
      const agent = createCelloAgent({ kind: 'chat', ctx: ctx(), saver: new MemorySaver(), model, fallbacks: [], skillsDir: path.join(process.cwd(), 'skills'), hiddenSkills, tools: [], responseFormat: Answer as never } as never) as unknown as { invoke: (i: unknown, c: unknown) => Promise<{ messages: { content: unknown }[] }> }
      const out = await agent.invoke({ messages: [new HumanMessage('hi')] }, { configurable: { thread_id: `t-${Math.random()}` }, recursionLimit: 40 })
      return JSON.stringify(out.messages.map((m) => m.content))
    }
    expect(await read([])).toContain(`name: ${off}`)
    expect(await read()).not.toContain(`name: ${off}`)
  })
})
