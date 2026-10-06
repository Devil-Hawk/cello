// The factory builds a real Deep Agent with a scripted model, so what is checked here is the
// agent itself: its guards, its tools, its specialists, and how deep delegation can go.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HumanMessage, ToolMessage } from '@langchain/core/messages'
import { MemorySaver } from '@langchain/langgraph'

vi.mock('@/lib/search', () => ({
  webSearch: async () => ({ ok: true, backend: 'test', results: [{ title: 'Acme', url: 'https://acme.example', snippet: 'Robots' }] }),
}))

import { MissingKeyError } from '@/lib/harness/providers'
import type { AgentContext } from './context'
import { createCelloAgent, researcherSpec, specialists } from './factory'
import { GUARD_ORDER } from './middleware'
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

function build(over: Record<string, unknown> = {}, model = new ScriptedChatModel({ model: 'qwen/qwen3.8-27b:free', script: [say('ok')] })) {
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
    const { agent, model } = build({ skillsDir: dir })
    await (agent as unknown as { invoke: (i: unknown, c: unknown) => Promise<unknown> }).invoke({ messages: [new HumanMessage('hi')] }, { configurable: { thread_id: 't-skills' } })
    const content = model.calls[0][0].content
    const system = typeof content === 'string' ? content : content.map((b) => (b as { text?: string }).text ?? '').join('')
    expect(system).toContain('role-fit')
    expect(system).toContain('Judge how well a role fits the person.')
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
    const researcherModel = new ScriptedChatModel({ model: 'qwen/qwen3.8-27b:free', script: researcherScript, repeatLast })
    const orchestratorModel = new ScriptedChatModel({ model: 'qwen/qwen3.8-27b:free', script: [task, say('Acme makes robots, per its own site.')] })
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
