import { AIMessage } from '@langchain/core/messages'
import { describe, expect, it, vi } from 'vitest'
import { CommandRefusal } from '@/lib/commands/define'
import type { AdminClient } from '@/lib/harness/types'
import { chatAgent } from './agent'

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
const deps = (build: ReturnType<typeof modelSaying>) => ({
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
      stream: async function* () {
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
