// The agent routes: stream and thread state. The engine under them has its own tests;
// what is checked here is each route's door: who may call it, what it refuses and says, and
// what it hands on.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { FetchStreamTransport } from '@langchain/langgraph-sdk/ui'
import { MemorySaver } from '@langchain/langgraph'
import { AIMessage, HumanMessage } from '@langchain/core/messages'

const state = vi.hoisted(() => ({
  user: { id: 'u1', email: 'dana@example.com' } as { id: string; email: string } | null,
  thread: null as { thread_id: string; user_id: string; surface: string } | null,
}))
const mocks = vi.hoisted(() => ({
  openUserTurn: vi.fn(),
  executeTurn: vi.fn(),
  saver: undefined as unknown,
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }) }))
vi.mock('@/lib/harness/supabase-admin', () => ({
  createAdminClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.thread }) }) }) }) }),
}))
vi.mock('@/lib/agents/turn', async (orig) => ({ ...(await orig<typeof import('@/lib/agents/turn')>()), openUserTurn: mocks.openUserTurn }))
vi.mock('@/lib/agents/run', () => ({ executeTurn: mocks.executeTurn }))
vi.mock('@/lib/agents/traced', () => ({ traced: async (_a: unknown, _u: unknown, _s: unknown, fn: (id: string) => Promise<unknown>) => fn('trace-from-request') }))
vi.mock('@/lib/agents/persistence', () => ({ withAgentPersistence: async (fn: (p: { saver: unknown }) => unknown) => fn({ saver: mocks.saver }) }))

import { POST as stream } from './stream/route'
import { GET as threadState } from './threads/[id]/state/route'

beforeEach(() => {
  vi.clearAllMocks()
  state.user = { id: 'u1', email: 'dana@example.com' }
  state.thread = null
})

const post = (url: string, body: string, headers: Record<string, string> = {}) => new NextRequest(`http://localhost${url}`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } })

describe('POST /api/agent/stream', () => {
  const body = JSON.stringify({ input: { messages: [{ type: 'human', content: 'hi' }] } })

  it('needs a signed in person, and says so in words', async () => {
    state.user = null
    const res = await stream(post('/api/agent/stream', body))
    expect(res.status).toBe(401)
    expect((await res.json()).message).toMatch(/sign in/i)
    expect(mocks.openUserTurn).not.toHaveBeenCalled()
  })

  it('passes a refusal through as JSON with its status and its one sentence, before any streaming', async () => {
    mocks.openUserTurn.mockResolvedValueOnce({ ok: false, status: 402, error: 'needs_key', message: 'Add an OpenRouter key in Settings to use Ask Cello. Free models work.' })
    const res = await stream(post('/api/agent/stream', body))
    expect(res.status).toBe(402)
    expect(res.headers.get('content-type')).toMatch(/json/)
    expect(await res.json()).toEqual({ error: 'needs_key', message: 'Add an OpenRouter key in Settings to use Ask Cello. Free models work.' })
    expect(mocks.executeTurn).not.toHaveBeenCalled()
  })

  it('a body that is not JSON is a 400', async () => {
    expect((await stream(post('/api/agent/stream', 'not json'))).status).toBe(400)
  })

  it('streams the turn in the format the hook reads, with the trace id of this request on the context', async () => {
    const ctx = { threadId: 't1', conversationId: 'c1', traceId: '' }
    mocks.openUserTurn.mockResolvedValueOnce({ ok: true, ctx, lease: { threadId: 't1', holder: 'h' }, mode: { kind: 'input', text: 'hi' } })
    mocks.executeTurn.mockImplementationOnce(async (req: { emit: (e: { event: string; data: unknown }) => void; ctx: { traceId: string } }) => {
      req.emit({ event: 'metadata', data: { run_id: req.ctx.traceId, thread_id: 't1', conversation_id: 'c1' } })
      req.emit({ event: 'values', data: { messages: [{ type: 'ai', content: 'Hello.' }] } })
      return { outcome: 'done', finalText: 'Hello.' }
    })
    const res = await stream(post('/api/agent/stream', body))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)

    // Read it with the SDK's own transport, the way the page does.
    const events: { event: string; data: unknown }[] = []
    const transport = new FetchStreamTransport({ apiUrl: 'http://test/api/agent/stream', fetch: async () => res })
    for await (const e of await transport.stream({ input: {}, signal: new AbortController().signal } as never)) events.push(e as never)
    expect(events.map((e) => e.event)).toEqual(['metadata', 'values'])
    expect(events[0].data).toEqual({ run_id: 'trace-from-request', thread_id: 't1', conversation_id: 'c1' })
    expect(mocks.executeTurn.mock.calls[0][0]).toMatchObject({ mode: { kind: 'input', text: 'hi' }, sessionId: 'c1' })
  })

  it('an error inside the turn arrives as an error event and the stream still closes', async () => {
    mocks.openUserTurn.mockResolvedValueOnce({ ok: true, ctx: { threadId: 't1', conversationId: 'c1', traceId: '' }, lease: {}, mode: { kind: 'input', text: 'hi' } })
    mocks.executeTurn.mockRejectedValueOnce(new Error('boom'))
    const res = await stream(post('/api/agent/stream', body))
    const text = await res.text()
    expect(text).toContain('event: error')
  })
})

describe('GET /api/agent/threads/[id]/state', () => {
  const get = (id: string) => threadState(new NextRequest(`http://localhost/api/agent/threads/${id}/state`), { params: { id } })

  it('needs a signed in person', async () => {
    state.user = null
    expect((await get('t1')).status).toBe(401)
  })

  it("someone else's conversation and a missing one answer the same", async () => {
    state.thread = { thread_id: 't1', user_id: 'u2', surface: 'agent' }
    const other = await get('t1')
    state.thread = null
    const missing = await get('t1')
    expect(other.status).toBe(404)
    expect(await other.json()).toEqual(await missing.json())
  })

  it('a conversation from the earlier Copilot says to start a new one', async () => {
    state.thread = { thread_id: 't1', user_id: 'u1', surface: 'copilot' }
    const res = await get('t1')
    expect(res.status).toBe(409)
    expect((await res.json()).message).toMatch(/Start a new one/)
  })

  it('returns the saved messages in the hook shape for the owner, uncached', async () => {
    const saver = new MemorySaver()
    await saver.put({ configurable: { thread_id: 't1', checkpoint_ns: '' } }, { v: 4, id: '1', ts: new Date().toISOString(), channel_values: { messages: [new HumanMessage('hi'), new AIMessage('Hello.')] }, channel_versions: {}, versions_seen: {} } as never, { source: 'loop', step: 0, parents: {} } as never)
    mocks.saver = saver
    state.thread = { thread_id: 't1', user_id: 'u1', surface: 'agent' }
    const res = await get('t1')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body.values.messages.map((m: { type: string }) => m.type)).toEqual(['human', 'ai'])
    expect(body.interrupts).toEqual([])
  })
})
