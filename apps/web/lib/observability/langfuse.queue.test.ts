// A slow Langfuse must not grow the replay queue without bound. Its own file:
// the hung exporter below blocks every later replay in the same module instance.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SpanBuffer, type SpanRecord } from '../trace/spans'
import { __setLangfuseForTest, exportTrace } from './langfuse'

const REQ_CTX = Symbol.for('@vercel/request-context')
const g = globalThis as unknown as Record<symbol, unknown>

const rows = (): SpanRecord[] => [
  {
    trace_id: 'ignored',
    span_id: 'root',
    parent_span_id: null,
    user_id: 'u',
    thread_id: null,
    run_id: null,
    kind: 'graph',
    name: 'copilot',
    start_time: new Date().toISOString(),
    end_time: new Date().toISOString(),
    status: 'ok',
    attributes: null,
    events: null,
  },
]

beforeEach(() => {
  vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-lf-fake')
  vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-fake')
  vi.stubEnv('LANGFUSE_BASE_URL', 'https://langfuse.example.com')
  g[REQ_CTX] = { get: () => ({ waitUntil: () => undefined }) }
})
afterEach(() => {
  vi.unstubAllEnvs()
  delete g[REQ_CTX]
})

describe('replay queue', () => {
  it('drops a trace once 20 are already waiting behind a hung export', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const hung = { export: () => undefined, shutdown: async () => undefined, forceFlush: async () => undefined } as never
    __setLangfuseForTest({ exporter: hung })
    for (let i = 0; i < 25; i++) await exportTrace(new SpanBuffer('u', null, undefined, { isDemo: false }), rows())
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('export queue full'))).toHaveLength(5)
  })
})
