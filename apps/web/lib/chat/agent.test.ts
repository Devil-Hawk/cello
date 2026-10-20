import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { describe, expect, it, vi } from 'vitest'
import { CommandRefusal } from '@/lib/commands/define'
import type { AdminClient } from '@/lib/harness/types'
import { Command } from '@langchain/langgraph'
import { chatAgent } from './agent'
import { MovedError } from './workers'

const CAP = 'The draft could not be written: Free models allow 5 drafts a day. Add credit or choose another way to run.'

const seen = vi.hoisted(() => [] as { callKey?: string }[])
const gate = vi.hoisted(() => ({ wait: null as Promise<void> | null }))
vi.mock('@/lib/commands', async (orig) => ({
  ...(await orig<typeof import('@/lib/commands')>()),
  runCommand: async (_def: unknown, ctx: { callKey?: string }) => {
    seen.push(ctx)
    if (gate.wait) await gate.wait
    throw new CommandRefusal(502, CAP, 'failed')
  },
}))

type Tool = { name: string; invoke: (args: unknown, config?: unknown) => Promise<unknown> }

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

describe('a turn that carries on in the background', () => {
  type State = { next: readonly string[]; tasks?: { interrupts?: { value?: unknown }[] }[]; values?: { messages?: BaseMessage[] } }
  const answered = { messages: [new AIMessage('ok')], structuredResponse: { parts: [{ about: [], text: 'Done' }] } }
  /** An agent whose checkpoint reads as each given state in turn; the inputs and configs it was run with are kept. */
  const withStates = (...states: State[]) => {
    const runs: { input: unknown; config: Record<string, unknown> | undefined }[] = []
    let read = 0
    const build = () => ({
      invoke: async (i: unknown, config?: Record<string, unknown>) => {
        runs.push({ input: i, config })
        return answered
      },
      getState: async () => states[Math.min(read++, states.length - 1)],
    })
    return { build, runs }
  }

  it('throws moved when the graph stops at the slice deadline', async () => {
    const { build } = withStates({ next: ['model_request'], tasks: [{ interrupts: [{ value: { kind: 'slice' } }] }] })
    // A refusal met earlier in the turn must not turn the move into a refusal line.
    const calling = ({ tools }: { tools: unknown[] }) => ({
      ...build(),
      invoke: async () => {
        await (tools as Tool[]).find((t) => t.name === 'documents_draft')!.invoke({ type: 'message', job_id: 'j1', instructions: 'ask about the timeline' })
        return answered
      },
    })
    await expect(chatAgent(deps(calling))(input)).rejects.toBeInstanceOf(MovedError)
    const plain = withStates({ next: ['model_request'] })
    await expect(chatAgent(deps(plain.build))(input)).rejects.toBeInstanceOf(MovedError)
    expect(plain.runs[0]!.config).toMatchObject({ durability: 'sync', configurable: { thread_id: 't1' } })
  })

  it('answers when the graph ran to its end', async () => {
    const { build } = withStates({ next: [] })
    const out = await chatAgent(deps(build))(input)
    expect(out.answer.parts).toEqual([{ about: [], text: 'Done' }])
  })

  it('resumes with a resume command when the checkpoint holds an interrupt, and with null when it holds a pending step', async () => {
    const held = withStates({ next: ['model_request'], tasks: [{ interrupts: [{ value: { kind: 'slice' } }] }] }, { next: [] })
    await chatAgent({ ...deps(held.build), resume: true })(input)
    expect(held.runs[0]!.input).toBeInstanceOf(Command)
    expect((held.runs[0]!.input as Command).resume).toBe('continue')

    const crashed = withStates({ next: ['tools'], tasks: [{ interrupts: [] }] }, { next: [] })
    await chatAgent({ ...deps(crashed.build), resume: true })(input)
    expect(crashed.runs[0]!.input).toBeNull()

    // No checkpoint to continue (the turn took the routed path): the normal messages, and only the first call resumes.
    const none = withStates({ next: [] })
    const run = chatAgent({ ...deps(none.build), resume: true })
    await run(input)
    await run({ ...input, feedback: 'Fix it.' })
    expect(none.runs[0]!.input).toMatchObject({ messages: [expect.objectContaining({ content: input.typed })] })
    expect(none.runs[1]!.input).toMatchObject({ messages: expect.any(Array) })
  })

  it('reads the earlier slices tool results back from the checkpoint, so the answer is checked against all of them', async () => {
    const thing = { kind: 'role', id: 'r1', title: 'AI Engineer', company: 'Stripe', place: null, pay: null, chance: null, posted: null, notes: [] }
    const earlier = [
      new ToolMessage({ name: 'roles_find', tool_call_id: 'call_1', content: JSON.stringify({ things: [thing], sentence: 'Searched your 146 stored roles: 1 match.', matched: 1 }) }),
      new ToolMessage({ name: 'documents_draft', tool_call_id: 'call_2', content: JSON.stringify({ error: CAP, fix: 'Tell the person.' }) }),
    ]
    const { build } = withStates({ next: ['model_request'], tasks: [{ interrupts: [{ value: { kind: 'slice' } }] }], values: { messages: earlier } }, { next: [] })
    const out = await chatAgent({ ...deps(build), resume: true })(input)
    expect(out.tools).toEqual([{ label: 'Find roles' }])
    expect(out.sources).toEqual([{ title: 'AI Engineer', host: 'Stripe' }])
    expect(out.results).toEqual(expect.arrayContaining([expect.objectContaining({ object: { kind: 'role', ref: 'r1' } }), { object: null, text: 'Searched your 146 stored roles: 1 match.' }, { object: null, text: CAP }]))
    expect(out.answer.cards).toEqual([{ kind: 'role', id: 'r1' }])
    expect(out.answer.parts.map((p) => p.text)).toContain(CAP)
  })

  it('gives each tool call a call key from the turn and the call id', async () => {
    seen.length = 0
    const calls = ({ tools }: { tools: unknown[] }) => ({
      invoke: async () => {
        const draft = (tools as Tool[]).find((t) => t.name === 'documents_draft')!
        const args = { type: 'message', job_id: 'j1', instructions: 'ask about the timeline' }
        await draft.invoke({ type: 'tool_call', id: 'call_a', name: 'documents_draft', args })
        await draft.invoke({ type: 'tool_call', id: 'call_b', name: 'documents_draft', args })
        await draft.invoke(args)
        return answered
      },
    })
    await chatAgent(deps(calls))(input)
    expect(seen.map((c) => c.callKey)).toEqual(['t1:call_a', 't1:call_b', undefined])
  })

  it('reads the length of a slice from the environment', async () => {
    const { chatSliceMs } = await import('./agent')
    expect(chatSliceMs()).toBe(240_000)
    process.env.CHAT_SLICE_MS = '20000'
    expect(chatSliceMs()).toBe(20_000)
    delete process.env.CHAT_SLICE_MS
  })
})

describe('a command that fans out is not the Researcher', () => {
  type Ev = { type: string; label?: string; phase?: string }
  const run = async (nestedWhileACommandRuns: boolean) => {
    const events: Ev[] = []
    const streaming = ({ tools }: { tools: unknown[] }) => ({
      invoke: async () => ({ messages: [new AIMessage('ok')], structuredResponse: { parts: [] } }),
      stream: async function* (): AsyncGenerator<unknown> {
        let release = () => {}
        gate.wait = nestedWhileACommandRuns ? new Promise<void>((r) => (release = r)) : null
        const running = (tools as Tool[]).find((t) => t.name === 'documents_draft')!.invoke({ type: 'message', job_id: 'j1', instructions: 'ask' })
        // Let the tool get inside its command, then a nested graph reports under the tool's own namespace.
        await new Promise((r) => setTimeout(r, 20))
        yield [['tools:call1', 'branch:b1'], 'custom', { type: 'noise' }]
        release()
        await running
        gate.wait = null
        yield [[], 'values', { messages: [new AIMessage('ok')], structuredResponse: { parts: [] } }]
      },
    })
    await chatAgent({ ...deps(streaming), emit: (e) => events.push(e.data as Ev) })(input)
    return events.filter((e) => e.label === 'Research')
  }

  it('shows no Research row for the nested graphs of a running command', async () => {
    expect(await run(true)).toEqual([])
  })

  it('still shows one for a delegation that runs on its own', async () => {
    expect((await run(false)).map((e) => e.phase)).toEqual(['start', 'end'])
  })
})
