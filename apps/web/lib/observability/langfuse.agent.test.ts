// Agent tracing: the CallbackHandler joins the request's trace, carries the conversation as the
// session, exists only when content may be captured, and reactions become scores.
// No network: the real processor and provider run with an in-memory exporter.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { RunnableLambda } from '@langchain/core/runnables'
import { __setLangfuseForTest, agentCallbacks, flushAgentSpans, scoreTrace, withAgentSpanContext } from './langfuse'

const TRACE = '3f2b8a14-9c7d-4e51-8a6b-0d1e2f3a4b5c'
const HEX = TRACE.replace(/-/g, '')

function configure() {
  vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-lf-fake')
  vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-fake')
  vi.stubEnv('LANGFUSE_BASE_URL', 'https://langfuse.example.com')
}

let exporter: InMemorySpanExporter

beforeEach(() => {
  exporter = new InMemorySpanExporter()
  __setLangfuseForTest({ exporter })
  configure()
  vi.stubEnv('LANGFUSE_DEMO_SAMPLE_RATE', '1')
  vi.stubEnv('LANGFUSE_CONTENT_USER_IDS', 'user-1')
})
afterEach(() => {
  vi.unstubAllEnvs()
  __setLangfuseForTest()
})

const input = (over = {}) => ({ traceId: TRACE, sessionId: 'conv-1', userId: 'user-1', isDemo: false, name: 'agent-turn', ...over })

describe('agentCallbacks', () => {
  it('is empty when Langfuse is not configured', async () => {
    vi.unstubAllEnvs()
    expect(await agentCallbacks(input())).toEqual([])
  })

  it('is empty for a demo and for anyone not on the content allowlist, because the handler sends prompts and results', async () => {
    expect(await agentCallbacks(input({ isDemo: true }))).toEqual([])
    expect(await agentCallbacks(input({ userId: 'someone-else' }))).toEqual([])
    vi.stubEnv('LANGFUSE_CONTENT_USER_IDS', '')
    expect(await agentCallbacks(input())).toEqual([])
  })

  it('is empty when the content kill switch is off and when the trace is sampled out', async () => {
    vi.stubEnv('LANGFUSE_CAPTURE_CONTENT', '0')
    expect(await agentCallbacks(input())).toEqual([])
    vi.stubEnv('LANGFUSE_CAPTURE_CONTENT', '1')
    vi.stubEnv('LANGFUSE_SAMPLE_RATE', '0')
    expect(await agentCallbacks(input())).toEqual([])
  })

  it('one handler for an owner, and its observations join the request trace under the conversation', async () => {
    const callbacks = await agentCallbacks(input())
    expect(callbacks).toHaveLength(1)
    const chain = RunnableLambda.from(async (x: string) => `${x}!`).withConfig({ runName: 'cello' })
    const out = await withAgentSpanContext(TRACE, () => chain.invoke('hi', { callbacks }))
    expect(out).toBe('hi!')
    await flushAgentSpans()
    const spans = exporter.getFinishedSpans()
    expect(spans.length).toBeGreaterThan(0)
    const root = spans.find((s) => s.name === 'cello')!
    expect(root.spanContext().traceId).toBe(HEX)
    expect(root.parentSpanContext?.spanId).toBe(HEX.slice(16))
    expect(JSON.stringify(root.attributes)).toContain('conv-1')
    expect(JSON.stringify(root.attributes)).toContain('user-1')
  })

  it('two agent turns in two traces stay in two traces', async () => {
    const other = '11111111-2222-4333-8444-555555555555'
    const chain = RunnableLambda.from(async (x: string) => x).withConfig({ runName: 'cello' })
    for (const id of [TRACE, other]) {
      const cb = await agentCallbacks(input({ traceId: id }))
      await withAgentSpanContext(id, () => chain.invoke('x', { callbacks: cb }))
    }
    await flushAgentSpans()
    const ids = new Set(exporter.getFinishedSpans().map((s) => s.spanContext().traceId))
    expect(ids).toEqual(new Set([HEX, other.replace(/-/g, '')]))
  })
})

describe('scoreTrace', () => {
  function sink() {
    const created: Record<string, unknown>[] = []
    return { created, scores: { score: { create: (s: Record<string, unknown>) => void created.push(s) }, flush: async () => undefined } as never }
  }

  it('scores the trace the reaction belongs to, with a stable id', async () => {
    const s = sink()
    __setLangfuseForTest({ exporter, scores: s.scores })
    await scoreTrace(TRACE, 'draft_approved', 1, 'Sent to Dana Lee')
    await scoreTrace(TRACE, 'draft_approved', 1)
    expect(s.created).toHaveLength(2)
    expect(s.created[0]).toMatchObject({ traceId: HEX, name: 'draft_approved', value: 1, dataType: 'NUMERIC', comment: 'Sent to Dana Lee' })
    // The same reaction on the same trace is the same score, so a repeat updates it.
    expect(s.created[0].id).toBe(s.created[1].id)
    await scoreTrace(TRACE, 'draft_skipped', 0)
    expect(s.created[2].id).not.toBe(s.created[0].id)
  })

  it('does nothing when Langfuse is off, and never throws', async () => {
    vi.unstubAllEnvs()
    await expect(scoreTrace(TRACE, 'draft_approved', 1)).resolves.toBeUndefined()
  })
})
