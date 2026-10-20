import { AIMessage } from '@langchain/core/messages'
import { describe, expect, it, vi } from 'vitest'
import { CommandRefusal } from '@/lib/commands/define'
import type { AdminClient } from '@/lib/harness/types'
import { chatAgent } from './agent'
import { createCelloAgent } from '@/lib/agents/factory'

vi.mock('@/lib/agents/factory', async (orig) => ({
  ...(await orig<typeof import('@/lib/agents/factory')>()),
  createCelloAgent: vi.fn(() => ({ invoke: async () => ({ messages: [new AIMessage('ok')], structuredResponse: { parts: [{ about: [], text: 'Done.' }] } }) })),
}))

const CAP = 'The draft could not be written: Free models allow 5 drafts a day. Add credit or choose another way to run.'

vi.mock('@/lib/commands', async (orig) => ({
  ...(await orig<typeof import('@/lib/commands')>()),
  runCommand: async () => {
    throw new CommandRefusal(502, CAP, 'failed')
  },
}))

type Tool = { name: string; invoke: (args: unknown) => Promise<unknown> }

/** A model that calls the draft tool, then answers with the given parts and nothing about the refusal. */
function modelSaying(parts: { about: []; text: string }[]) {
  return ({ tools }: { tools: unknown[] }) => ({
    invoke: async () => {
      const draft = (tools as Tool[]).find((t) => t.name === 'documents_draft')!
      await draft.invoke({ type: 'message', job_id: 'j1', instructions: 'ask about the timeline' })
      return { messages: [new AIMessage('ok')], structuredResponse: { parts } }
    },
  })
}

const input = { chatId: 'c1', turnId: 't1', screen: null, typed: 'Prepare a short outreach to Datadog', feedback: null, returned: new Set<string>() }
const deps = (build: NonNullable<Parameters<typeof chatAgent>[0]['build']>) => ({
  db: {} as AdminClient,
  userId: 'u1',
  keys: { userId: 'u1' },
  isDemo: false,
  ran: { rung: 'R3' as const, model: 'x:free', effort: 'low' as const },
  build,
})

describe('a tool refused with a reason code knows', () => {
  it('is said by code when the model leaves it out, and stands as evidence for the part', async () => {
    const out = await chatAgent(deps(modelSaying([])))(input)
    expect(out.answer.parts).toEqual([{ about: [], text: CAP }])
    expect(out.results).toContainEqual({ object: null, text: CAP })
  })

  it('is not said twice when the model already carries it', async () => {
    const out = await chatAgent(deps(modelSaying([{ about: [], text: `I could not write it. ${CAP}` }])))(input)
    expect(out.answer.parts).toHaveLength(1)
  })
})

describe('the loop dying after a refusal', () => {
  it('ends the turn with the refusal, not a generic line', async () => {
    const crashing = ({ tools }: { tools: unknown[] }) => ({
      invoke: async () => {
        await (tools as Tool[]).find((t) => t.name === 'documents_draft')!.invoke({ type: 'message', job_id: 'j1', instructions: 'ask about the timeline' })
        throw new Error('InvalidUpdateError: Can receive only one value per step. Use an Annotation.Root with a reducer.')
      },
    })
    await expect(chatAgent(deps(crashing))(input)).rejects.toMatchObject({ name: 'CommandRefusal', status: 502, message: CAP })
  })

  it('a crash with nothing refused is thrown as it is', async () => {
    const crashing = () => ({
      invoke: async () => {
        throw new Error('boom')
      },
    })
    await expect(chatAgent(deps(crashing))(input)).rejects.toThrow('boom')
  })
})

describe('the model-call cap ending the loop', () => {
  it("says so in Cello's words, not the library's", async () => {
    const capped = () => ({ invoke: async () => ({ messages: [new AIMessage('Model call limits exceeded: run limit (24/24)')], structuredResponse: undefined }) })
    const out = await chatAgent(deps(capped))(input)
    expect(out.answer.parts).toHaveLength(1)
    expect(out.answer.parts[0].text).toMatch(/Ask again/)
    expect(out.answer.parts[0].text).not.toMatch(/limits exceeded/i)
  })
})

describe('streaming a structured answer', () => {
  it('sends growing words from partial tool-call chunks and flushes the last one', async () => {
    const { AIMessageChunk } = await import('@langchain/core/messages')
    const chunk = (args: string, first = false) => new AIMessageChunk({ content: '', id: 'm1', tool_call_chunks: [{ ...(first ? { name: 'AnswerSchema', id: 'x' } : {}), args, index: 0, type: 'tool_call_chunk' }] })
    const pieces = [chunk('{"parts":[{"about":[],"text":"First', true), chunk(' sentence"},'), chunk('{"about":[],"text":"Second'), chunk(' one"}]}')]
    const final = { parts: [{ about: [], text: 'First sentence' }, { about: [], text: 'Second one' }] }
    const streaming = () => ({
      invoke: async () => ({ messages: [new AIMessage('ok')], structuredResponse: final }),
      stream: async function* (): AsyncGenerator<unknown> {
        for (const piece of pieces) {
          yield [[], 'messages', [piece, {}]]
          await new Promise((r) => setTimeout(r, 60))
        }
        yield [[], 'values', { messages: [new AIMessage('ok')], structuredResponse: final }]
      },
    })
    const events: { type: string; text?: string }[] = []
    const out = await chatAgent({ ...deps(streaming), emit: (e) => events.push(e.data as { type: string; text?: string }) })(input)
    const words = events.filter((e) => e.type === 'words').map((e) => e.text)
    expect(words.length).toBeGreaterThanOrEqual(2)
    expect(words[0]).toBe('First')
    for (let i = 1; i < words.length; i++) expect(words[i]!.length).toBeGreaterThan(words[i - 1]!.length)
    expect(words.at(-1)).toBe('First sentence\nSecond one')
    expect(out.answer.parts).toEqual(final.parts)
  })
})

describe('the live words across messages and the answer check', () => {
  type Ev = { type: string; text?: string; label?: string; phase?: string }
  const run = async (script: (call: number) => [string, string][]) => {
    const { AIMessageChunk } = await import('@langchain/core/messages')
    // One streamed piece: [message id, words]. The words are written as a part of the structured answer.
    const piece = ([id, text]: [string, string]) => new AIMessageChunk({ content: '', id, tool_call_chunks: text ? [{ name: 'AnswerSchema', id, args: JSON.stringify({ parts: [{ about: [], text }] }), index: 0, type: 'tool_call_chunk' }] : [] })
    const final = { parts: [{ about: [], text: 'Done' }] }
    let call = 0
    const streaming = () => ({
      invoke: async () => ({ messages: [new AIMessage('ok')], structuredResponse: final }),
      stream: async function* (): AsyncGenerator<unknown> {
        const mine = ++call
        for (const p of script(mine)) {
          yield [[], 'messages', [piece(p), {}]]
          await new Promise((r) => setTimeout(r, 160))
        }
        yield [[], 'values', { messages: [new AIMessage('ok')], structuredResponse: final }]
      },
    })
    const events: Ev[][] = [[], []]
    const agent = chatAgent({ ...deps(streaming), emit: (e) => events[which]!.push(e.data as Ev) })
    let which = 0
    await agent(input)
    which = 1
    await agent({ ...input, feedback: 'Fix the unsupported numbers.' })
    const words = (i: number) => events[i]!.filter((e) => e.type === 'words').map((e) => e.text)
    return { words, tools: (i: number) => events[i]!.filter((e) => e.type === 'tool').map((e) => `${e.label}:${e.phase}`) }
  }

  it('keeps the earlier message and appends the next one after a blank line', async () => {
    const { words } = await run((n) => (n === 1 ? [['m1', 'First message'], ['m2', 'Second message']] : []))
    const w = words(0)
    expect(w).toContain('First message')
    expect(w.at(-1)).toBe('First message\n\nSecond message')
    for (let i = 1; i < w.length; i++) expect(w[i]!.length).toBeGreaterThanOrEqual(w[i - 1]!.length)
  })

  it('adds nothing for a message with no words', async () => {
    const { words } = await run((n) => (n === 1 ? [['m1', 'Only words'], ['m2', '']] : []))
    expect(words(0).at(-1)).toBe('Only words')
  })

  it('streams no words in the retry the answer check asks for, and shows the check as a tool', async () => {
    const { words, tools } = await run((n) => (n === 1 ? [['m1', 'The draft']] : [['r1', 'You are right. Let me fix it.']]))
    expect(words(0).at(-1)).toBe('The draft')
    expect(words(1)).toEqual([])
    expect(tools(1)).toEqual(['Checking the answer:start', 'Checking the answer:end'])
    expect(tools(0)).toEqual([])
  })
})

describe('the eval seams', () => {
  const lastBuild = () => vi.mocked(createCelloAgent).mock.calls.at(-1)![0] as unknown as Record<string, unknown>

  it('uses the given model for the loop and for the Researcher, and passes the core', async () => {
    const model = { _llmType: () => 'scripted' }
    await chatAgent({ ...deps(undefined as never), build: undefined, model: model as never, core: 'plain', roles: { researcher: { rung: 'R3', model: 'paid/x', effort: 'low' } } })(input)
    expect(lastBuild()).toMatchObject({ kind: 'chat', core: 'plain', model, researcherModel: model })
  })

  it('leaves the core unset and builds its own model when no seam is given', async () => {
    await chatAgent({ ...deps(undefined as never), keys: { userId: 'u1', openrouter: 'k' }, build: undefined })(input)
    expect(lastBuild().core).toBeUndefined()
    expect(lastBuild().model).toBeDefined()
    expect(lastBuild().researcherModel).toBeUndefined()
  })
})
