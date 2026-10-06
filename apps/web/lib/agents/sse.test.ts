// The wire format, checked with the SDK's own reader: whatever useStream does with a stream,
// FetchStreamTransport is what reads it, so these tests feed our output through it.

import { describe, expect, it } from 'vitest'
import { FetchStreamTransport } from '@langchain/langgraph-sdk/ui'
import { createAgent, tool } from 'langchain'
import { AIMessage, HumanMessage } from '@langchain/core/messages'
import { MemorySaver } from '@langchain/langgraph'
import { z } from 'zod'
import { chunkToEvent, eventName, messageToWire, toSseResponse, toWire, type WireEvent } from './sse'
import { ScriptedChatModel, callTools, say } from './testing/scripted-model'

async function readThrough(response: Response): Promise<{ event: string; data: unknown }[]> {
  const transport = new FetchStreamTransport({ apiUrl: 'http://test/api/agent/stream', fetch: async () => response })
  const stream = await transport.stream({ input: { messages: [] } } as never)
  const out: { event: string; data: unknown }[] = []
  for await (const e of stream as AsyncIterable<{ event: string; data: unknown }>) out.push(e)
  return out
}

describe('event names', () => {
  it('are the stream mode, with the subagent path after a bar', () => {
    expect(eventName([], 'values')).toBe('values')
    expect(eventName(['tools:call_1'], 'values')).toBe('values|tools:call_1')
    expect(eventName(['tools:call_1', 'model_request:x'], 'messages')).toBe('messages|tools:call_1|model_request:x')
  })
})

describe('messages as dicts', () => {
  it('a message becomes its fields with a type the hook reads', () => {
    expect(messageToWire(new HumanMessage({ content: 'hi', id: 'h1' }))).toMatchObject({ type: 'human', content: 'hi', id: 'h1' })
    const ai = messageToWire(new AIMessage({ content: '', id: 'a1', tool_calls: [{ name: 'find_roles', args: { query: 'pm' }, id: 'c1', type: 'tool_call' }] }))
    expect(ai).toMatchObject({ type: 'ai', id: 'a1', tool_calls: [{ name: 'find_roles', id: 'c1' }] })
  })

  it('values with messages inside are converted, and plain data is left alone', () => {
    const out = toWire({ messages: [new HumanMessage('hi')], plan: [{ step: 'a' }], count: 2, when: new Date('2026-10-05T00:00:00Z') }) as Record<string, unknown>
    expect((out.messages as { type: string }[])[0].type).toBe('human')
    expect(out.plan).toEqual([{ step: 'a' }])
    expect(out.when).toBe('2026-10-05T00:00:00.000Z')
  })

  it('a cycle cannot hang the stream', () => {
    const a: Record<string, unknown> = { x: 1 }
    a.self = a
    expect(() => JSON.stringify(toWire(a))).not.toThrow()
  })
})

describe('the response', () => {
  it('the SDK reads every event we send, in order, with its name and data', async () => {
    const events: WireEvent[] = [
      { event: 'metadata', data: { run_id: 'trace-1', thread_id: 't1' } },
      { event: 'values', data: { messages: [] } },
      { event: 'values|tools:call_1', data: { messages: [] } },
      { event: 'custom', data: { kind: 'activity', text: 'Searching Greenhouse, Lever and Ashby' } },
    ]
    const read = await readThrough(toSseResponse(async (emit) => events.forEach(emit)))
    expect(read.map((e) => e.event)).toEqual(['metadata', 'values', 'values|tools:call_1', 'custom'])
    expect(read[3].data).toEqual({ kind: 'activity', text: 'Searching Greenhouse, Lever and Ashby' })
    // The hook finds a subagent by the part after the bar.
    expect(read[2].event.split('|').slice(1)).toEqual(['tools:call_1'])
  })

  it('a failure becomes an error event the hook shows, and the stream ends', async () => {
    const read = await readThrough(
      toSseResponse(async (emit) => {
        emit({ event: 'metadata', data: {} })
        throw new Error('Something went wrong on our side.')
      })
    )
    expect(read.map((e) => e.event)).toEqual(['metadata', 'error'])
    expect(read[1].data).toMatchObject({ message: 'Something went wrong on our side.' })
  })

  it('has the headers a streaming response needs', () => {
    const r = toSseResponse(async () => undefined)
    expect(r.headers.get('content-type')).toContain('text/event-stream')
    expect(r.headers.get('cache-control')).toContain('no-transform')
    expect(r.headers.get('x-accel-buffering')).toBe('no')
  })

  it('a client that goes away aborts the work', async () => {
    let seen: AbortSignal | undefined
    const response = toSseResponse(async (_emit, signal) => {
      seen = signal
      await new Promise((r) => setTimeout(r, 20))
    })
    await response.body!.cancel()
    expect(seen?.aborted).toBe(true)
  })
})

describe('a real agent stream through the wire', () => {
  it('values, messages and custom events survive, and the messages join into the answer', async () => {
    const lookup = tool(async () => 'ok', { name: 'lookup', description: 'x', schema: z.object({}) })
    const model = new ScriptedChatModel({ model: 'qwen/qwen3.8-27b:free', script: [callTools([{ name: 'lookup' }]), say('There are two roles.')] })
    const agent = createAgent({ model, tools: [lookup], checkpointer: new MemorySaver() })
    const response = toSseResponse(async (emit) => {
      emit({ event: 'metadata', data: { run_id: 'r', thread_id: 't' } })
      const stream = await agent.stream({ messages: [new HumanMessage('find roles')] }, { configurable: { thread_id: 't-wire' }, streamMode: ['values', 'updates', 'messages', 'custom'], subgraphs: true } as never)
      for await (const chunk of stream as unknown as AsyncIterable<[string[], string, unknown]>) emit(chunkToEvent(chunk))
    })
    const read = await readThrough(response)
    const names = new Set(read.map((e) => e.event.split('|')[0]))
    expect(names.has('metadata')).toBe(true)
    expect(names.has('values')).toBe(true)
    expect(names.has('updates')).toBe(true)
    const lastValues = [...read].reverse().find((e) => e.event === 'values')!.data as { messages: { type: string; content: string }[] }
    expect(lastValues.messages.map((m) => m.type)).toEqual(['human', 'ai', 'tool', 'ai'])
    expect(lastValues.messages.at(-1)?.content).toBe('There are two roles.')
  })
})
