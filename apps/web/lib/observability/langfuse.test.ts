// Tests for lib/observability/langfuse.ts: the Langfuse replay.
//
// ZERO real network. The REAL @langfuse/otel LangfuseSpanProcessor and the real
// OpenTelemetry provider run, with an InMemorySpanExporter in place of the OTLP
// exporter (the __setLangfuseForTest seam), so what the assertions read is
// exactly what would have been POSTed: names, parents, times, attributes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { SpanBuffer, type SpanRecord } from '../trace/spans'
import {
  FLUSH_DEADLINE_MS,
  MAX_OBSERVATIONS_PER_TRACE,
  __setLangfuseForTest,
  contentCaptureFor,
  exportTrace,
  finalize,
  langfuseCaptureDemoEnabled,
  langfuseCaptureEnabled,
  langfuseConfigured,
  langfuseDemoSampleRate,
  langfuseSampleRate,
  safeName,
  scrubText,
  selectRows,
  traceSampled,
} from './langfuse'

const REQ_CTX = Symbol.for('@vercel/request-context')
const g = globalThis as unknown as Record<symbol, unknown>

function configure() {
  vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-lf-fake')
  vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-fake')
  vi.stubEnv('LANGFUSE_BASE_URL', 'https://langfuse.example.com')
}

const T0 = Date.parse('2026-10-04T12:00:00.000Z')
let seq = 0
function row(overrides: Partial<SpanRecord> & { name: string }): SpanRecord {
  seq += 1
  return {
    trace_id: 'ignored',
    span_id: `span-${seq}`,
    parent_span_id: null,
    user_id: 'user-1',
    thread_id: null,
    run_id: null,
    kind: 'node',
    start_time: new Date(T0 + seq).toISOString(),
    end_time: new Date(T0 + seq + 500).toISOString(),
    status: 'ok',
    attributes: null,
    events: null,
    ...overrides,
  }
}

/** root (graph) -> agent (node) -> generation (llm) -> nothing, plus a judge. */
function tree() {
  const root = row({ name: 'copilot', kind: 'graph', span_id: 'root' })
  const agent = row({
    name: 'run-agent-step',
    kind: 'node',
    span_id: 'agent',
    parent_span_id: 'root',
    run_id: '11111111-1111-4111-8111-111111111111',
    lf: { name: 'run-job-matcher', type: 'agent', metadata: { agent_type: 'matcher' } },
  })
  const gen = row({
    name: 'llm',
    kind: 'llm',
    span_id: 'gen',
    parent_span_id: 'agent',
    lf: {
      name: 'score-job-match',
      type: 'generation',
      model: 'anthropic/claude-sonnet-5',
      modelParameters: { max_tokens: 512, json: 'true' },
      usage: { input: 100, output: 40, total: 140 },
      cost: { input: 0.0002, output: 0.0004 },
      metadata: { provider: 'openrouter', metered: true },
      input: [{ role: 'user', content: 'Score this job for me.' }],
      output: { role: 'assistant', content: 'Score 82.' },
    },
  })
  const judge = row({
    name: 'judge',
    kind: 'judge',
    span_id: 'judge',
    parent_span_id: 'agent',
    lf: { name: 'judge-groundedness', usage: { input: 10, output: 2, total: 12 }, cost: { input: 0, output: 0 } },
  })
  return [root, agent, gen, judge]
}

let exporter: InMemorySpanExporter
const spans = (): ReadableSpan[] => exporter.getFinishedSpans()
const byName = (name: string) => {
  const s = spans().find((x) => x.name === name)
  if (!s) throw new Error(`no exported span named ${name}: ${spans().map((x) => x.name).join(',')}`)
  return s
}
const ms = (t: [number, number]) => t[0] * 1000 + t[1] / 1e6
const dump = () => JSON.stringify(spans().map((s) => ({ n: s.name, a: s.attributes, s: s.status, e: s.events })))

/** Export with no request context: awaited, so the spans are in the exporter on return. */
async function run(buffer: SpanBuffer, rows: SpanRecord[]) {
  await exportTrace(buffer, rows)
}

beforeEach(() => {
  seq = 0
  exporter = new InMemorySpanExporter()
  __setLangfuseForTest({ exporter })
  configure()
  // Demo traces are sampled at 0.25 by default; the replay tests need them in.
  vi.stubEnv('LANGFUSE_DEMO_SAMPLE_RATE', '1')
  delete g[REQ_CTX]
})
afterEach(() => {
  vi.unstubAllEnvs()
  delete g[REQ_CTX]
  vi.restoreAllMocks()
})

describe('env gates', () => {
  it('langfuseConfigured needs all three non-blank', () => {
    vi.unstubAllEnvs()
    expect(langfuseConfigured()).toBe(false)
    for (const missing of ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL']) {
      vi.unstubAllEnvs()
      configure()
      vi.stubEnv(missing, '   ')
      expect(langfuseConfigured()).toBe(false)
    }
    vi.unstubAllEnvs()
    configure()
    expect(langfuseConfigured()).toBe(true)
  })

  it('the kill switch fails closed: only unset, blank or 1/true/on/yes keep capture on', () => {
    expect(langfuseCaptureEnabled()).toBe(true)
    vi.stubEnv('LANGFUSE_CAPTURE_CONTENT', '  ')
    expect(langfuseCaptureEnabled()).toBe(true)
    for (const on of ['1', 'true', 'ON', 'yes']) {
      vi.stubEnv('LANGFUSE_CAPTURE_CONTENT', on)
      expect(langfuseCaptureEnabled()).toBe(true)
    }
    for (const off of ['0', 'false', 'off', 'no', 'disabled', 'of']) {
      vi.stubEnv('LANGFUSE_CAPTURE_CONTENT', off)
      expect(langfuseCaptureEnabled()).toBe(false)
    }
    vi.unstubAllEnvs()
    expect(langfuseCaptureEnabled()).toBe(false) // unconfigured
  })

  it('demo content is off by default and only an explicit on turns it on', () => {
    expect(langfuseCaptureDemoEnabled()).toBe(false)
    expect(contentCaptureFor(false)).toBe(true)
    expect(contentCaptureFor(true)).toBe(false)
    expect(contentCaptureFor(undefined)).toBe(false) // unknown counts as demo
    vi.stubEnv('LANGFUSE_CAPTURE_DEMO_CONTENT', 'typo')
    expect(contentCaptureFor(true)).toBe(false)
    vi.stubEnv('LANGFUSE_CAPTURE_DEMO_CONTENT', '1')
    expect(contentCaptureFor(true)).toBe(true)
    expect(contentCaptureFor(undefined)).toBe(true)
    vi.stubEnv('LANGFUSE_CAPTURE_CONTENT', '0')
    expect(contentCaptureFor(false)).toBe(false) // the kill switch beats everything
    expect(contentCaptureFor(true)).toBe(false)
  })

  it('sample rates parse and clamp; demo defaults to 0.25', () => {
    vi.stubEnv('LANGFUSE_DEMO_SAMPLE_RATE', '')
    expect(langfuseSampleRate()).toBe(1)
    expect(langfuseDemoSampleRate()).toBe(0.25)
    vi.stubEnv('LANGFUSE_SAMPLE_RATE', 'lots')
    expect(langfuseSampleRate()).toBe(1)
    vi.stubEnv('LANGFUSE_SAMPLE_RATE', '7')
    expect(langfuseSampleRate()).toBe(1)
    vi.stubEnv('LANGFUSE_SAMPLE_RATE', '-3')
    expect(langfuseSampleRate()).toBe(0)
    vi.stubEnv('LANGFUSE_DEMO_SAMPLE_RATE', '0.5')
    expect(langfuseDemoSampleRate()).toBe(0.5)
  })

  it('traceSampled: per-trace deterministic; demo uses min(rate, demoRate); owner uses the rate', () => {
    vi.stubEnv('LANGFUSE_DEMO_SAMPLE_RATE', '')
    const ids = Array.from({ length: 2000 }, (_, i) => `trace-${i}`)
    const share = (isDemo: boolean) => ids.filter((id) => traceSampled(id, isDemo)).length / ids.length
    expect(share(false)).toBe(1)
    expect(share(true)).toBeGreaterThan(0.2)
    expect(share(true)).toBeLessThan(0.3)
    expect(ids.map((id) => traceSampled(id, true))).toEqual(ids.map((id) => traceSampled(id, true)))
    vi.stubEnv('LANGFUSE_SAMPLE_RATE', '0.1')
    expect(share(false)).toBeLessThan(0.15)
    expect(share(true)).toBeLessThan(0.15) // min(0.1, 0.25)
    vi.stubEnv('LANGFUSE_SAMPLE_RATE', '0')
    expect(ids.some((id) => traceSampled(id, false))).toBe(false)
    // a trace sampled in at a low rate stays in at a higher one
    vi.stubEnv('LANGFUSE_SAMPLE_RATE', '0.1')
    const low = ids.map((id) => traceSampled(id, false))
    vi.stubEnv('LANGFUSE_SAMPLE_RATE', '0.6')
    ids.forEach((id, i) => {
      if (low[i]) expect(traceSampled(id, false)).toBe(true)
    })
  })
})

describe('replay: structure, times, types', () => {
  it('parents match parent_span_id, one app root, trace id is the uuid hex, times equal the records', async () => {
    const buffer = new SpanBuffer('user-1', 't', '0f7b5d5a-1d75-4c5b-9d31-e984c3b9e5b6', { isDemo: false })
    const rows = tree()
    await run(buffer, rows)

    expect(spans()).toHaveLength(4)
    const root = byName('copilot')
    const agent = byName('run-job-matcher')
    const gen = byName('score-job-match')
    const judge = byName('judge-groundedness')
    for (const s of spans()) expect(s.spanContext().traceId).toBe('0f7b5d5a1d754c5b9d31e984c3b9e5b6')
    expect(agent.parentSpanContext?.spanId).toBe(root.spanContext().spanId)
    expect(gen.parentSpanContext?.spanId).toBe(agent.spanContext().spanId)
    expect(judge.parentSpanContext?.spanId).toBe(agent.spanContext().spanId)
    expect(spans().filter((s) => s.attributes['langfuse.internal.is_app_root'] === true)).toHaveLength(1)
    expect(root.attributes['langfuse.internal.is_app_root']).toBe(true)

    for (const [name, r] of [['score-job-match', rows[2]], ['run-job-matcher', rows[1]]] as const) {
      const s = byName(name)
      expect(ms(s.startTime)).toBe(Date.parse(r.start_time))
      expect(ms(s.endTime)).toBe(Date.parse(r.end_time))
    }
  })

  it('maps types from kind and lf.type; only generations carry model, usage and cost', async () => {
    const buffer = new SpanBuffer('user-1', null, undefined, { isDemo: false })
    const extra = [
      row({ name: 'search_kb', kind: 'tool', span_id: 'tool', parent_span_id: 'root', lf: { type: 'retriever', usage: { input: 5 }, cost: { input: 1 }, model: 'm' } }),
      row({ name: 'http', kind: 'http', span_id: 'http', parent_span_id: 'root', lf: { usage: { input: 5 }, model: 'm' } }),
    ]
    await run(buffer, [...tree(), ...extra])
    const type = (n: string) => byName(n).attributes['langfuse.observation.type']
    expect(type('copilot')).toBe('chain')
    expect(type('run-job-matcher')).toBe('agent')
    expect(type('score-job-match')).toBe('generation')
    expect(type('judge-groundedness')).toBe('generation')
    expect(type('search_kb')).toBe('retriever')
    expect(type('http')).toBe('span')

    const gen = byName('score-job-match').attributes
    expect(gen['langfuse.observation.model.name']).toBe('anthropic/claude-sonnet-5')
    expect(JSON.parse(String(gen['langfuse.observation.usage_details']))).toEqual({ input: 100, output: 40, total: 140 })
    expect(JSON.parse(String(gen['langfuse.observation.cost_details']))).toEqual({ input: 0.0002, output: 0.0004 })
    expect(JSON.parse(String(gen['langfuse.observation.model.parameters']))).toEqual({ max_tokens: 512, json: 'true' })
    for (const n of ['copilot', 'run-job-matcher', 'search_kb', 'http']) {
      const keys = Object.keys(byName(n).attributes).join(' ')
      expect(keys).not.toMatch(/usage_details|cost_details|model\.name/)
    }
  })

  it('environment and release come from VERCEL_ENV and VERCEL_GIT_COMMIT_SHA', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview')
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'abc1234')
    __setLangfuseForTest({ exporter })
    await run(new SpanBuffer('user-1', null, undefined, { isDemo: false }), tree())
    for (const s of spans()) {
      expect(s.attributes['langfuse.environment']).toBe('preview')
      expect(s.attributes['langfuse.release']).toBe('abc1234')
    }
  })

  it('an unmetered generation keeps its explicit zero cost; an error span is level ERROR with a code', async () => {
    const root = row({ name: 'refresh', kind: 'graph', span_id: 'root' })
    const gen = row({
      name: 'llm',
      kind: 'llm',
      parent_span_id: 'root',
      status: 'error',
      lf: { name: 'call-llm', type: 'generation', cost: { input: 0, output: 0 }, errorCode: 'http_429', errorMessage: 'rate limited' },
    })
    await run(new SpanBuffer('user-1', null, undefined, { isDemo: false }), [root, gen])
    const a = byName('call-llm').attributes
    expect(a['langfuse.observation.level']).toBe('ERROR')
    expect(JSON.parse(String(a['langfuse.observation.cost_details']))).toEqual({ input: 0, output: 0 })
    expect(a['langfuse.observation.status_message']).toBe('http_429: rate limited')
  })

  it('trace attributes sit on every span: name, user, session, tags, metadata', async () => {
    const buffer = new SpanBuffer('11111111-2222-4333-8444-555555555555', 'th', undefined, {
      isDemo: false,
      sessionId: 'conv-1',
      metadata: { surface: 'copilot', leg: 'turn' },
    })
    await run(buffer, tree())
    for (const s of spans()) {
      expect(s.attributes['langfuse.trace.name']).toBe('copilot')
      expect(s.attributes['user.id']).toBe('11111111-2222-4333-8444-555555555555')
      expect(s.attributes['session.id']).toBe('conv-1')
      expect(s.attributes['langfuse.trace.tags']).toEqual(['feature:copilot', 'owner'])
      expect(s.attributes['langfuse.trace.metadata.feature']).toBe('copilot')
      expect(s.attributes['langfuse.trace.metadata.surface']).toBe('copilot')
      expect(s.attributes['langfuse.trace.metadata.leg']).toBe('turn')
    }
  })

  it('demo traces are tagged demo; an unknown isDemo is demo too', async () => {
    await run(new SpanBuffer('u', null, undefined, {}), tree())
    expect(byName('copilot').attributes['langfuse.trace.tags']).toEqual(['feature:copilot', 'demo'])
  })
})

describe('names stay constants', () => {
  it('every exported span name and the trace name match the name rule, whatever the Postgres name is', async () => {
    const root = row({ name: 'copilot', kind: 'graph', span_id: 'root' })
    const agent = row({ name: 'tailor-cv-acme#3', span_id: 'agent', parent_span_id: 'root' }) // no lf.name: planner label
    const mcp = row({
      name: 'evil sk-ant-api03-CANARY_name_abcdefghij',
      kind: 'tool',
      parent_span_id: 'agent',
      lf: { name: 'call-mcp-tool', detail: { mcp_server: 'evil sk-ant-api03-CANARY_server_abcdef' } },
    })
    await run(new SpanBuffer('u', null, undefined, { isDemo: false }), [root, agent, mcp])
    const names = spans().map((s) => s.name)
    expect(names).toEqual(expect.arrayContaining(['copilot', 'unnamed', 'call-mcp-tool']))
    for (const n of names) {
      expect(n).toMatch(/^[a-z][a-z0-9_-]{0,63}$/)
      expect(n).not.toMatch(/#|[0-9a-f]{8}-[0-9a-f]{4}/)
    }
    for (const s of spans()) expect(s.attributes['langfuse.trace.name']).toBe('copilot')
    expect(safeName('Run Agent')).toBe('unnamed')
    expect(safeName(undefined)).toBe('unnamed')
    expect(safeName('score-job-match')).toBe('score-job-match')
  })
})

describe('masking canary: nothing planted survives', () => {
  const KEY = 'sk-ant-api03-CANARY_abc-DEF_1234567890'
  const MAIL = 'canary@example.com'
  const PW = 'password=CANARYPW'
  const planted = `my key ${KEY} and mail ${MAIL} and ${PW}`
  const canary = /CANARY|canary@example|sk-ant-api03/i

  const plantedRows = () => {
    const root = row({ name: 'copilot', kind: 'graph', span_id: 'root', status: 'error', lf: { name: 'copilot', errorMessage: planted, errorCode: 'http_500', input: { message: planted }, output: { reply: planted } } })
    const gen = row({
      name: 'llm',
      kind: 'llm',
      parent_span_id: 'root',
      status: 'error',
      lf: {
        name: 'call-llm',
        input: [{ role: 'user', content: planted }, { role: 'system', content: planted }],
        output: { role: 'assistant', content: planted, reasoning: planted },
        metadata: { note: planted, count: 3, ok: true, mcp_server: planted },
        detail: { step_label: planted, mcp_server: planted },
        errorMessage: planted,
        version: planted,
        model: planted,
      },
    })
    return [root, gen]
  }

  it('capture on: readable text, secrets masked, no planted substring in ANY attribute, name or status', async () => {
    const buffer = new SpanBuffer(`user-${KEY}`, null, undefined, {
      isDemo: false,
      sessionId: planted,
      name: undefined,
      metadata: { leg: planted, surface: KEY },
    })
    await run(buffer, plantedRows())
    expect(spans()).toHaveLength(2)
    const all = dump()
    expect(all).not.toMatch(canary)
    expect(all).not.toContain('CANARYPW')
    // still readable where it is safe
    const input = String(byName('call-llm').attributes['langfuse.observation.input'])
    expect(input).toContain('my key')
    expect(input).toContain('[redacted-key]')
    for (const s of spans()) expect(s.status.message ?? '').toBe('')
  })

  it('capture off (kill switch): no input/output, no detail keys, status is the code only, nothing planted', async () => {
    vi.stubEnv('LANGFUSE_CAPTURE_CONTENT', '0')
    const buffer = new SpanBuffer('user-1', null, undefined, { isDemo: false, sessionId: 'conv-9' })
    await run(buffer, plantedRows())
    expect(spans()).toHaveLength(2)
    for (const s of spans()) {
      const keys = Object.keys(s.attributes).join(' ')
      expect(keys).not.toMatch(/observation\.(input|output)|metadata\.(step_label|mcp_server)/)
      expect(s.status.message ?? '').toBe('')
    }
    expect(byName('copilot').attributes['langfuse.observation.status_message']).toBe('http_500')
    expect(byName('call-llm').attributes['langfuse.observation.status_message']).toBe('error')
    expect(dump()).not.toMatch(canary)
  })

  it('demo traces send no content by default, and LANGFUSE_CAPTURE_DEMO_CONTENT=1 restores it', async () => {
    for (const isDemo of [true, undefined]) {
      exporter.reset()
      await run(new SpanBuffer('u', null, undefined, { isDemo }), tree())
      for (const s of spans()) expect(Object.keys(s.attributes).join(' ')).not.toMatch(/observation\.(input|output)/)
    }
    exporter.reset()
    vi.stubEnv('LANGFUSE_CAPTURE_DEMO_CONTENT', '1')
    await run(new SpanBuffer('u', null, undefined, { isDemo: true }), tree())
    expect(byName('score-job-match').attributes['langfuse.observation.input']).toBeDefined()
  })

  it('structured payloads blank sensitive keys and drop non-safe metadata values', async () => {
    const root = row({ name: 'copilot', kind: 'graph', span_id: 'root', lf: { input: { jobId: 'j1', resume: 'my whole resume', email: MAIL, nested: { token: 'abc' } }, metadata: { thread: 'has spaces', ok: 'a-b_c' } } })
    await run(new SpanBuffer('u', null, undefined, { isDemo: false }), [root])
    const a = byName('copilot').attributes
    const input = JSON.parse(String(a['langfuse.observation.input']))
    expect(input).toMatchObject({ jobId: 'j1', resume: '[redacted]', email: '[redacted]', nested: { token: '[redacted]' } })
    expect(a['langfuse.observation.metadata.thread']).toBeUndefined()
    expect(a['langfuse.observation.metadata.ok']).toBe('a-b_c')
  })

  it('finalize (layer 2) re-scrubs every string and string[] attribute except input/output, and fails closed when attributes are unreadable', () => {
    const set: Record<string, unknown> = {}
    const span = {
      attributes: {
        'langfuse.observation.metadata.note': `leak ${KEY} ${MAIL}`,
        'langfuse.trace.tags': [`feature:${KEY}`, 'owner'],
        'langfuse.observation.input': `kept as is ${KEY}`,
        'langfuse.observation.type': 'agent',
        count: 3,
      },
      setAttribute: (k: string, v: unknown) => {
        set[k] = v
      },
    }
    finalize(span as never)
    expect(JSON.stringify(set)).not.toMatch(canary)
    expect(set['langfuse.observation.metadata.note']).toContain('leak')
    expect(Object.keys(set)).not.toContain('langfuse.observation.input')
    expect(Object.keys(set)).not.toContain('count')
    expect(() => finalize({ setAttribute: () => undefined } as never)).toThrow(/not readable/)
  })

  it('scrubText bounds and redacts: 16 KB cap, a secret at the edge never survives', () => {
    const edge = `${'a '.repeat(8190)}sk-ant-api03-EDGE_abc-DEF_1234567890 tail`
    const out = scrubText(edge)
    expect(out).not.toMatch(/EDGE_abc|1234567890/)
    expect(out.length).toBeLessThanOrEqual(16 * 1024 + 20)
    expect(scrubText('x'.repeat(40_000))).toMatch(/…\[truncated\]$/)
  })

  it('scrubText stays fast on hostile 64 KB inputs', () => {
    const shapes = ['a', 'a/', 'a@', 'a:', 'sk-', 'eyJ-', 'Bearer ', 'password=', 'ya29.', 'a.a.', ' ', 'QUJD'].map((s) => s.repeat(Math.ceil(65536 / s.length)).slice(0, 65536))
    for (const text of shapes) {
      const t0 = performance.now()
      scrubText(text)
      expect(performance.now() - t0).toBeLessThan(150)
    }
  })
})

describe('caps and the content budget', () => {
  it('3000 records export at most 400 spans; root, error and judge (with ancestors) survive; parents exist', async () => {
    const root = row({ name: 'refresh', kind: 'graph', span_id: 'root' })
    const rows: SpanRecord[] = [root]
    for (let i = 0; i < 2996; i += 1) {
      rows.push(row({ name: 'call-llm', kind: 'llm', parent_span_id: 'root', span_id: `leaf-${i}`, lf: { name: 'score-job-match', type: 'generation' } }))
    }
    // deep chain at the END of start order: only priority can keep it
    rows.push(row({ name: 'deep-a', span_id: 'deep-a', parent_span_id: 'root', lf: { name: 'deep-a' } }))
    rows.push(row({ name: 'deep-b', span_id: 'deep-b', parent_span_id: 'deep-a', lf: { name: 'deep-b' } }))
    rows.push(row({ name: 'deep-err', kind: 'llm', span_id: 'deep-err', parent_span_id: 'deep-b', status: 'error', lf: { name: 'deep-err', type: 'generation' } }))
    rows.push(row({ name: 'judge', kind: 'judge', span_id: 'judge', parent_span_id: 'deep-a', lf: { name: 'judge-groundedness' } }))
    expect(rows).toHaveLength(3001)

    await run(new SpanBuffer('u', null, undefined, { isDemo: false }), rows)
    const out = spans()
    expect(out.length).toBeLessThanOrEqual(MAX_OBSERVATIONS_PER_TRACE)
    const names = new Set(out.map((s) => s.name))
    for (const n of ['refresh', 'deep-a', 'deep-b', 'deep-err', 'judge-groundedness']) expect(names.has(n)).toBe(true)
    const ids = new Set(out.map((s) => s.spanContext().spanId))
    const rootSpan = byName('refresh')
    for (const s of out) {
      if (s === rootSpan) continue
      expect(ids.has(s.parentSpanContext?.spanId ?? '')).toBe(true)
    }
    expect(rootSpan.attributes['langfuse.trace.metadata.dropped_observations']).toBe(String(3001 - out.length))
  })

  it('selectRows keeps everything under the cap and never splits a parent from its child', () => {
    const rows = tree()
    expect(selectRows(rows, 10)).toEqual({ rows, dropped: 0 })
    const small = selectRows(rows, 3)
    expect(small.rows.length).toBeLessThanOrEqual(3)
    const kept = new Set(small.rows.map((r) => r.span_id))
    for (const r of small.rows) if (r.parent_span_id) expect(kept.has(r.parent_span_id)).toBe(true)
    expect(kept.has('judge')).toBe(true) // judge outranks the plain generation
  })

  it('the trace content budget stops capture past 128 KB', async () => {
    const root = row({ name: 'copilot', kind: 'graph', span_id: 'root' })
    const gens = Array.from({ length: 12 }, (_, i) =>
      row({
        name: 'llm',
        kind: 'llm',
        parent_span_id: 'root',
        span_id: `g${i}`,
        lf: { name: 'call-llm', type: 'generation', input: [{ role: 'user', content: 'word '.repeat(3000) }], output: { role: 'assistant', content: 'ok ' } },
      })
    )
    await run(new SpanBuffer('u', null, undefined, { isDemo: false }), [root, ...gens])
    const inputs = spans().filter((s) => s.name === 'call-llm').map((s) => String(s.attributes['langfuse.observation.input']))
    expect(inputs.some((i) => i.includes('word word'))).toBe(true)
    expect(inputs.some((i) => i === '[trace content budget exhausted]')).toBe(true)
  })
})

describe('delivery', () => {
  it('with a Vercel request context, waitUntil gets the export and the call resolves at once', async () => {
    const waitUntil = vi.fn()
    g[REQ_CTX] = { get: () => ({ waitUntil }) }
    const done = await Promise.race([exportTrace(new SpanBuffer('u', null, undefined, { isDemo: false }), tree()).then(() => 'resolved'), new Promise((r) => setTimeout(() => r('slow'), 200))])
    expect(done).toBe('resolved')
    expect(waitUntil).toHaveBeenCalledTimes(1)
    // the export itself completes inside the waitUntil promise
    await waitUntil.mock.calls[0][0]
    expect(spans()).toHaveLength(4)
  })

  it('no request context on Vercel: awaited, bounded by the deadline against a hung exporter', async () => {
    vi.stubEnv('VERCEL', '1')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const hung = { export: () => undefined, shutdown: async () => undefined, forceFlush: async () => undefined } as never
    __setLangfuseForTest({ exporter: hung })
    const t0 = Date.now()
    await exportTrace(new SpanBuffer('u', null, undefined, { isDemo: false }), tree())
    // the hung exporter never calls back, so BatchSpanProcessor.forceFlush hangs: only the deadline ends it
    expect(Date.now() - t0).toBeGreaterThanOrEqual(FLUSH_DEADLINE_MS - 100)
    expect(Date.now() - t0).toBeLessThan(FLUSH_DEADLINE_MS + 1500)
  }, 10_000)

  it('no request context on Vercel warns exactly once per instance and still delivers', async () => {
    vi.stubEnv('VERCEL', '1')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await exportTrace(new SpanBuffer('u', null, undefined, { isDemo: false }), tree())
    await exportTrace(new SpanBuffer('u', null, undefined, { isDemo: false }), tree())
    expect(spans()).toHaveLength(8)
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('no Vercel request context'))).toHaveLength(1)
  })

  it('off Vercel there is no warning, and a failing exporter never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(exportTrace(new SpanBuffer('u', null, undefined, { isDemo: false }), tree())).resolves.toBeUndefined()
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('no Vercel request context'))).toHaveLength(0)
  })

  it('a replay that throws is logged and swallowed, never thrown to the request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // sabotage: a row whose lf getter throws makes send() throw mid-replay
    const bad = row({ name: 'copilot', kind: 'graph', span_id: 'root' })
    Object.defineProperty(bad, 'lf', { get: () => { throw new Error('boom') } })
    await expect(exportTrace(new SpanBuffer('u', null, undefined, { isDemo: false }), [bad])).resolves.toBeUndefined()
    expect(warn.mock.calls.some((c) => String(c[0]).includes('[langfuse] export failed'))).toBe(true)
  })
})
