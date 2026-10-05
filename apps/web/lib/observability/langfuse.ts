// Langfuse export for prompt monitoring. trace_spans (lib/trace/spans.ts)
// stays the system of record and the ONLY capture point: SpanBuffer.flush()
// hands the buffered records to exportTrace() below, which replays them as
// Langfuse observations with their real start and end times. There is no
// second span tree, no live OpenTelemetry context and no LangGraph callback.
//
// SDK: @langfuse/tracing + @langfuse/otel (v5, the OpenTelemetry based SDK).
// Docs: https://langfuse.com/docs/observability/sdk/instrumentation and
// https://langfuse.com/docs/observability/features/masking. This file is the
// only place that imports `@langfuse/*` or calls startObservation (a guard
// test in lib/graph/graph-chokepoints.test.ts holds that).
//
// COMPLETE NO-OP WHEN UNCONFIGURED. Unless LANGFUSE_PUBLIC_KEY,
// LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL are ALL set, SpanBuffer never
// builds an `lf` payload, exportTrace returns at once, and no `@langfuse/*`
// module is imported (the imports are dynamic, behind the synchronous gate).
//
// PROVIDER ISOLATION. The processor sits on its own BasicTracerProvider that
// is NEVER registered globally. Sentry (lib/observability/sentry.ts) owns the
// global provider and context manager and keeps them. Every observation gets
// an explicit parentSpanContext and our AlwaysOnSampler ignores parents, so an
// unsampled Sentry request span can neither drop nor adopt our spans.
//
// DELIVERY ON SERVERLESS. When Vercel exposes a request context, the replay
// and the OTLP POST run inside its waitUntil and add about 0 ms to the
// response. Without one (local dev, scripts, or Vercel with no context) the
// export is awaited with a 2000 ms deadline, so there is never a silent loss
// path and never an unbounded wait. Replays run one at a time per instance so
// the batch queue holds at most one trace (400 observations).
//
// MASKING. Layer 1: every string written here goes through redactString
// (linear time, see scrub.ts), via scrubText/scrubPayload for input and
// output and via clean() for everything else. Layer 2: finalize() re-scrubs
// every string attribute on a span just before it ends, because the
// processor's `mask` only sees the exact keys langfuse.observation.input /
// output / metadata (our flat metadata keys never match them). `mask` stays on
// as a second layer for input and output.
//
// WHY POSTGRES STAYS THE SYSTEM OF RECORD, NOT LANGFUSE
//   Langfuse Cloud's free (Hobby) tier is 50,000 units a month (a unit is a
//   trace, an observation or a score) with 30 days of retention. trace_spans
//   has no such cap and is written regardless. The sampling knobs, the
//   per-trace caps and the demo defaults below keep Langfuse inside the cap.

import { createHash } from 'node:crypto'
import type { LangfuseClient } from '@langfuse/client'
import type { LangfuseSpanProcessor } from '@langfuse/otel'
import type { Span } from '@opentelemetry/api'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import { capPayload } from '../graph/journal'
import type { LfPayload, LfType, PendingScore, SpanBuffer, SpanRecord } from '../trace/spans'
import { redactString, scrubMetadata } from './scrub'

// --- knobs ---------------------------------------------------------------------

/** Longest the request waits on an awaited (no request context) export. */
export const FLUSH_DEADLINE_MS = 2000
/** Per-string cap for captured prompt/completion text (non-system roles). */
export const CONTENT_CAP_CHARS = 16 * 1024
/** A system prompt is the task definition, so it gets room for the whole
 *  composed prompt (shared + voice + mode doc + dynamic context blocks). */
export const SYSTEM_CAP_CHARS = 64 * 1024
/** Per-generation cap on the captured non-system messages together. */
export const GENERATION_INPUT_CAP_CHARS = 48 * 1024
/** Cap on structured input/output (tool args, agent IO), in JSON bytes. */
export const PAYLOAD_CAP_BYTES = 4096
export const MAX_OBSERVATIONS_PER_TRACE = 400
export const MAX_SCORES_PER_TRACE = 50
/** All captured content of one trace together (bounds scrub CPU and POST size). */
export const TRACE_CONTENT_BUDGET_CHARS = 256 * 1024
const BUDGET_EXHAUSTED = '[trace content budget exhausted]'

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined

/** The single on/off switch for this module. All three must be non-blank. */
export function langfuseConfigured(): boolean {
  return Boolean(env('LANGFUSE_PUBLIC_KEY') && env('LANGFUSE_SECRET_KEY') && env('LANGFUSE_BASE_URL'))
}

/** Fail-closed flag parse: unset or blank gives `dflt`, 1/true/on/yes is on,
 *  anything else (a typo such as "disabled" included) is off. */
function flag(name: string, dflt: boolean): boolean {
  const raw = env(name)
  if (raw === undefined) return dflt
  return /^(1|true|on|yes)$/i.test(raw)
}

/** Prompt/completion capture, the kill switch. On by default once Langfuse is
 *  configured; LANGFUSE_CAPTURE_CONTENT=0 (or any typo) turns it off. */
export function langfuseCaptureEnabled(): boolean {
  return langfuseConfigured() && flag('LANGFUSE_CAPTURE_CONTENT', true)
}

/** Demo workspaces (public, strangers' text) send no content unless
 *  LANGFUSE_CAPTURE_DEMO_CONTENT is explicitly on. */
export function langfuseCaptureDemoEnabled(): boolean {
  return flag('LANGFUSE_CAPTURE_DEMO_CONTENT', false)
}

/** May prompt text of this trace leave the process? isDemo undefined counts as
 *  demo: the fail-closed side. */
export function contentCaptureFor(isDemo: boolean | undefined): boolean {
  return langfuseCaptureEnabled() && (isDemo === false || langfuseCaptureDemoEnabled())
}

function rate(name: string, dflt: number): number {
  const raw = env(name)
  if (!raw) return dflt
  const n = Number(raw)
  // A typo must not raise volume: an unparseable value means 0, fail closed.
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0
}

/** LANGFUSE_SAMPLE_RATE clamped to 0..1; unset or blank means 1, an invalid
 *  value means 0 (fail closed, like the kill switch).
 *  The SDK itself does not read this variable (5.11.1), so there is no double
 *  sampling. */
export function langfuseSampleRate(): number {
  return rate('LANGFUSE_SAMPLE_RATE', 1)
}

/** LANGFUSE_DEMO_SAMPLE_RATE, default 0.25: protects the unit budget from a
 *  public-demo burst. */
export function langfuseDemoSampleRate(): number {
  return rate('LANGFUSE_DEMO_SAMPLE_RATE', 0.25)
}

/** Deterministic per-trace sampling: the same trace id always lands on the
 *  same side, so a trace is exported whole or not at all. Demo (and unknown)
 *  traces use the lower of the two rates. */
export function traceSampled(traceId: string, isDemo?: boolean): boolean {
  const r = isDemo === false ? langfuseSampleRate() : Math.min(langfuseSampleRate(), langfuseDemoSampleRate())
  if (r >= 1) return true
  if (r <= 0) return false
  return createHash('sha256').update(traceId).digest().readUInt32BE(0) / 2 ** 32 < r
}

/** Langfuse only accepts lowercase [a-z0-9_-] and nothing starting with
 *  'langfuse'. VERCEL_ENV is production, preview or development. */
function tracingEnvironment(): string {
  const e = (env('VERCEL_ENV') || 'development').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40)
  return e.startsWith('langfuse') ? 'development' : e
}

// --- masking choke points ---------------------------------------------------------

/** Redact secret/PII-shaped substrings, then cap. The slice BEFORE redaction
 *  bounds regex work; the 512 chars of headroom mean a secret that straddles
 *  the cap is still replaced whole before the final cut. */
export function scrubText(text: string, cap: number = CONTENT_CAP_CHARS): string {
  const redacted = redactString(text.slice(0, cap + 512))
  return text.length > cap || redacted.length > cap ? `${redacted.slice(0, cap)}…[truncated]` : redacted
}

/** Structured payloads: bounded first (capPayload also bounds wide objects),
 *  then key deny-list plus patterns (resume, email, token... keys are blanked). */
export function scrubPayload(value: unknown): unknown {
  return scrubMetadata(capPayload(value, PAYLOAD_CAP_BYTES))
}

/** The one choke function for every non-input/output string: slice, redact, cut. */
function clean(value: unknown, max: number): string {
  return redactString(String(value).slice(0, max + 512)).slice(0, max)
}

const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/
/** Names come from code constants. A name that is not one (a bug, or a planner
 *  label that slipped through) becomes `unnamed` rather than carrying free
 *  text to Langfuse. */
export function safeName(name: string | undefined): string {
  return name !== undefined && NAME_RE.test(name) ? name : 'unnamed'
}

const SAFE_META_RE = /^[A-Za-z0-9_.:/-]{1,200}$/

/** Metadata is ids, enums and numbers. Anything else is dropped, never cleaned
 *  into something that looks fine. */
function safeMetadata(meta: Record<string, string | number | boolean> | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(meta ?? {})) {
    if (!NAME_RE.test(k.toLowerCase())) continue
    if (typeof v === 'number' ? Number.isFinite(v) : typeof v === 'boolean' || (typeof v === 'string' && SAFE_META_RE.test(v) && clean(v, 200) === v)) out[k] = v
  }
  return out
}

/** Per-trace capture state: the content budget plus the system prompts already
 *  captured in full (sha256 prefix -> name of the first observation). */
type Budget = { left: number; systems: Map<string, string> }
/** What was cut from one observation's input or output. */
type Cut = { chars: number; truncated: boolean }
type Msg = { role: string; content: string; reasoning?: string; thinking?: { content: string }[] }
const isMsg = (v: unknown): v is Msg => {
  const o = v as Record<string, unknown> | null
  return typeof o === 'object' && o !== null && typeof o.role === 'string' && typeof o.content === 'string'
}

/** Chat messages keep their readable text. The first copy of a system prompt in
 *  a trace is captured whole (64 KB); a later identical one (every Copilot step
 *  re-sends it) becomes a one-line pointer and costs no budget. Other roles get
 *  16 KB each and 48 KB together. */
function scrubMessages(msgs: Msg[], budget: Budget, name: string, cut: Cut): Msg[] {
  let left = GENERATION_INPUT_CAP_CHARS
  return msgs.map((m) => {
    cut.chars += m.content.length
    let content: string
    if (m.role === 'system') {
      const hash = createHash('sha256').update(m.content).digest('hex').slice(0, 8)
      const first = budget.systems.get(hash)
      if (first !== undefined) content = `[system prompt identical to ${first}, sha256:${hash}]`
      else {
        budget.systems.set(hash, name)
        content = scrubText(m.content, SYSTEM_CAP_CHARS)
      }
    } else {
      content = scrubText(m.content, Math.max(0, Math.min(CONTENT_CAP_CHARS, left)))
      left -= content.length
    }
    if (content.endsWith('…[truncated]')) cut.truncated = true
    return {
      role: clean(m.role, 20),
      content,
      // Langfuse renders a Thinking block from message.thinking ([{ content, summary? }]); a plain
      // `reasoning` string is shown nowhere.
      ...(typeof m.reasoning === 'string' ? { thinking: [{ content: scrubText(m.reasoning) }] } : {}),
    }
  })
}

/** Input/output of one observation, charged against the trace budget (a
 *  generation's output is exempt: small, and the decision you most need). */
function scrubIo(value: unknown, budget: Budget, name: string, cut: Cut, exempt = false): unknown {
  if (value === undefined) return undefined
  if (!exempt && budget.left <= 0) {
    cut.truncated = true
    return BUDGET_EXHAUSTED
  }
  let out: unknown
  if (typeof value === 'string') {
    cut.chars += value.length
    out = scrubText(value)
    if (value.length > CONTENT_CAP_CHARS) cut.truncated = true
  } else if (isMsg(value)) out = scrubMessages([value], budget, name, cut)[0]
  else if (Array.isArray(value) && value.length > 0 && value.every(isMsg)) out = scrubMessages(value, budget, name, cut)
  else out = scrubPayload(value)
  if (!exempt) {
    try {
      budget.left -= JSON.stringify(out)?.length ?? 0
    } catch {
      budget.left = 0
    }
  }
  return out
}

// --- observation building ------------------------------------------------------------

type Attrs = Record<string, unknown>
/** What exportTrace needs of an observation. */
interface Obs {
  id: string
  otelSpan: Span
  end(endTime?: Date): void
}
type StartFn = (name: string, attributes: Attrs, options: Attrs) => Obs

const DEFAULT_TYPE: Record<SpanRecord['kind'], LfType> = {
  graph: 'chain',
  node: 'agent',
  llm: 'generation',
  tool: 'tool',
  judge: 'generation',
  http: 'span',
}
const typeOf = (r: SpanRecord): LfType => r.lf?.type ?? DEFAULT_TYPE[r.kind]
const hasUsage = (t: LfType) => t === 'generation' || t === 'embedding'

function toAttributes(r: SpanRecord, budget: Budget, capture: boolean): Attrs {
  const lf: LfPayload = r.lf ?? {}
  const type = typeOf(r)
  const name = safeName(lf.name ?? r.name)
  const metadata: Record<string, string | number | boolean> = { kind: r.kind, ...safeMetadata(lf.metadata) }
  const inCut: Cut = { chars: 0, truncated: false }
  const outCut: Cut = { chars: 0, truncated: false }
  const input = capture ? scrubIo(lf.input, budget, name, inCut) : undefined
  const output = capture ? scrubIo(lf.output, budget, name, outCut, type === 'generation') : undefined
  if (inCut.truncated) Object.assign(metadata, { input_chars: inCut.chars, input_truncated: true })
  if (outCut.truncated) Object.assign(metadata, { output_chars: outCut.chars, output_truncated: true })
  if (r.run_id) metadata.run_id = r.run_id
  // Empty input and output on a demo or kill-switched trace is deliberate; say so.
  if (!capture) metadata.content = 'withheld'
  if (capture) {
    for (const [k, v] of Object.entries(lf.detail ?? {})) if (NAME_RE.test(k)) metadata[k] = clean(v, 200)
  }
  const failed = r.status === 'error' && !lf.expected
  const level = failed ? 'ERROR' : lf.level
  // With capture off no message text leaves, only the short code.
  const code = lf.errorCode ?? (failed ? 'error' : undefined)
  const statusMessage = !level
    ? undefined
    : capture && lf.errorMessage
      ? clean(`${code ?? 'error'}: ${lf.errorMessage}`, 500)
      : code
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    metadata,
    version: lf.version ? clean(lf.version, 64) : undefined,
    level,
    statusMessage,
    ...(hasUsage(type)
      ? {
          model: lf.model ? clean(lf.model, 100) : undefined,
          modelParameters: safeMetadata(lf.modelParameters),
          usageDetails: lf.usage,
          costDetails: lf.cost,
        }
      : {}),
  }
}

function buildTraceAttrs(
  buffer: SpanBuffer,
  rows: SpanRecord[],
  dropped: { observations: number; scores: number }
): Record<string, string | string[]> {
  const root = rows.find((r) => !r.parent_span_id) ?? rows[0]
  const name = safeName(buffer.meta.name ?? root.lf?.name ?? root.name)
  const feature = safeName(buffer.meta.feature ?? name)
  const attrs: Record<string, string | string[]> = {
    'langfuse.trace.name': name,
    'user.id': clean(buffer.userId, 200),
    'langfuse.trace.tags': [`feature:${feature}`, buffer.meta.isDemo === false ? 'owner' : 'demo'],
    'langfuse.trace.metadata.feature': feature,
  }
  if (buffer.meta.sessionId) attrs['session.id'] = clean(buffer.meta.sessionId, 200)
  const meta: Record<string, string> = { ...buffer.meta.metadata }
  if (dropped.observations > 0) meta.dropped_observations = String(dropped.observations)
  if (dropped.scores > 0) meta.dropped_scores = String(dropped.scores)
  for (const [k, v] of Object.entries(meta)) {
    if (NAME_RE.test(k) && SAFE_META_RE.test(v)) attrs[`langfuse.trace.metadata.${k}`] = v
  }
  return attrs
}

const IO_KEYS = new Set(['langfuse.observation.input', 'langfuse.observation.output'])

/** Layer 2: re-scrub every string (and string[]) attribute except input and
 *  output (those are scrubbed and masked already). Throws when the SDK stops
 *  exposing `attributes`: the whole trace is then dropped (fail closed). */
export function finalize(span: Span): void {
  const attrs = (span as unknown as ReadableSpan).attributes
  if (!attrs || typeof attrs !== 'object') throw new Error('finalize: span attributes not readable')
  for (const [k, v] of Object.entries(attrs)) {
    if (IO_KEYS.has(k)) continue
    if (typeof v === 'string') span.setAttribute(k, clean(v, 1000))
    else if (Array.isArray(v)) span.setAttribute(k, v.map((x) => (typeof x === 'string' ? clean(x, 200) : x)) as string[])
  }
}

/** Which records fit the per-trace cap. The root, error spans and judge spans
 *  (with all their ancestors) are always kept, then the rest in start order, so
 *  every kept record's parent is kept too. */
export function selectRows(rows: SpanRecord[], cap: number = MAX_OBSERVATIONS_PER_TRACE): { rows: SpanRecord[]; dropped: number } {
  if (rows.length <= cap) return { rows, dropped: 0 }
  const byId = new Map(rows.map((r) => [r.span_id, r]))
  const keep = new Set<string>()
  const chain = (r: SpanRecord): SpanRecord[] => {
    const out: SpanRecord[] = []
    for (let c: SpanRecord | undefined = r; c && !keep.has(c.span_id); c = c.parent_span_id ? byId.get(c.parent_span_id) : undefined) out.push(c)
    return out
  }
  const admit = (r: SpanRecord) => {
    const c = chain(r)
    if (keep.size + c.length <= cap) for (const x of c) keep.add(x.span_id)
  }
  const important = [
    ...rows.filter((r) => !r.parent_span_id),
    ...rows.filter((r) => r.kind === 'judge' || r.lf?.name?.startsWith('judge-')),
    ...rows.filter((r) => r.status === 'error'),
  ]
  for (const r of important) admit(r)
  for (const r of [...rows].sort((a, b) => (a.start_time < b.start_time ? -1 : a.start_time > b.start_time ? 1 : 0))) {
    if (keep.size >= cap) break
    admit(r)
  }
  const kept = rows.filter((r) => keep.has(r.span_id))
  return { rows: kept, dropped: rows.length - kept.length }
}

// --- init (lazy, Node only, one per instance) ----------------------------------------

/** What a score needs of the client (a test replaces it with a recorder). */
type ScoreSink = Pick<LangfuseClient, 'flush'> & { score: Pick<LangfuseClient['score'], 'create'> }

interface Lf {
  processor: LangfuseSpanProcessor
  startObservation: StartFn
  client: ScoreSink
}

const KEY = Symbol.for('cello.langfuse')
let testExporter: SpanExporter | undefined
let testScoreSink: ScoreSink | undefined

type Holder = { [KEY]?: Promise<Lf | null> }

async function getLangfuse(): Promise<Lf | null> {
  const g = globalThis as Holder
  g[KEY] ??= init().catch((err) => {
    console.warn(`[langfuse] init failed, export disabled for 60s: ${redactString(String(err).slice(0, 300))}`)
    setTimeout(() => {
      delete g[KEY]
    }, 60_000).unref()
    return null
  })
  return g[KEY] as Promise<Lf | null>
}

async function init(): Promise<Lf> {
  const [{ LangfuseSpanProcessor }, { BasicTracerProvider, AlwaysOnSampler }, tracing, { LangfuseClient }, { resourceFromAttributes }] = await Promise.all([
    import('@langfuse/otel'),
    import('@opentelemetry/sdk-trace-base'),
    import('@langfuse/tracing'),
    import('@langfuse/client'),
    import('@opentelemetry/resources'),
  ])
  const creds = { publicKey: env('LANGFUSE_PUBLIC_KEY'), secretKey: env('LANGFUSE_SECRET_KEY'), baseUrl: env('LANGFUSE_BASE_URL') }
  const processor = new LangfuseSpanProcessor({
    ...creds,
    ...(testExporter ? { exporter: testExporter } : {}),
    environment: tracingEnvironment(),
    // The SDK has no Vercel auto-detect (5.11.1 source).
    release: env('VERCEL_GIT_COMMIT_SHA'),
    mediaUploadEnabled: false,
    // maxExportBatchSize, above MAX_OBSERVATIONS_PER_TRACE: one trace is about one POST.
    flushAt: 512,
    additionalHeaders: { 'x-langfuse-ingestion-version': '4' },
    // Second layer for input/output only: the processor applies it to the
    // exact keys langfuse.observation.input / output / metadata, as stringified JSON.
    mask: ({ data }) => (typeof data === 'string' ? redactString(data.slice(0, 256 * 1024)) : data),
  })
  const provider = new BasicTracerProvider({
    sampler: new AlwaysOnSampler(),
    spanProcessors: [processor],
    // A meaningful service name instead of unknown_service:/usr/local/bin/node.
    resource: resourceFromAttributes({ 'service.name': 'cello-web' }),
  })
  // Isolated: never provider.register(), Sentry owns the global one.
  tracing.setLangfuseTracerProvider(provider)
  return {
    processor,
    startObservation: tracing.startObservation as unknown as StartFn,
    client: testScoreSink ?? new LangfuseClient(creds),
  }
}

/** Test seam: drop the singleton and route the next init to `exporter`
 *  (an in-memory exporter), or to the real OTLP exporter when omitted. */
export function __setLangfuseForTest(opts?: { exporter?: SpanExporter; scores?: ScoreSink }): void {
  testExporter = opts?.exporter
  testScoreSink = opts?.scores
  delete (globalThis as Holder)[KEY]
  tail = Promise.resolve()
  warnedNoContext = false
}

// --- replay ---------------------------------------------------------------------------

async function send(buffer: SpanBuffer, all: SpanRecord[], allScores: PendingScore[]): Promise<void> {
  const lf = await getLangfuse()
  if (!lf) return
  const capture = buffer.captureContent
  const { rows, dropped } = selectRows(all)
  const traceHex = buffer.traceId.replace(/-/g, '')
  const scores = allScores.slice(0, MAX_SCORES_PER_TRACE)
  const traceAttrs = buildTraceAttrs(buffer, rows, { observations: dropped, scores: allScores.length - scores.length })
  const budget: Budget = { left: TRACE_CONTENT_BUDGET_CHARS, systems: new Map() }
  const byId = new Map<string, Obs>()
  const rowsById = new Map(rows.map((r) => [r.span_id, r]))

  // 1) START every observation, parents first, and end nothing until all are
  //    started (the processor's app-root logic keys on currently open spans).
  const start = (r: SpanRecord): Obs => {
    const seen = byId.get(r.span_id)
    if (seen) return seen
    const parentRow = r.parent_span_id ? rowsById.get(r.parent_span_id) : undefined
    const parentSpanContext = parentRow
      ? start(parentRow).otelSpan.spanContext()
      : { traceId: traceHex, spanId: traceHex.slice(16), traceFlags: 1 }
    // Top-level startObservation, NOT parent.startObservation(): the child
    // method drops startTime (5.11.1).
    const obs = lf.startObservation(safeName(r.lf?.name ?? r.name), toAttributes(r, budget, capture), {
      asType: typeOf(r),
      startTime: new Date(r.start_time),
      parentSpanContext,
    })
    obs.otelSpan.setAttributes(traceAttrs)
    byId.set(r.span_id, obs)
    return obs
  }
  for (const r of rows) start(r)

  // 2) FINALIZE then END. finalize() is the only guarantee for non-IO strings.
  for (const r of rows) {
    const o = byId.get(r.span_id) as Obs
    finalize(o.otelSpan)
    o.end(new Date(r.end_time))
  }
  // 3) Scores, attached to the judge generation that produced them (a dropped
  //    or unknown span leaves the score on the trace).
  for (const s of scores) lf.client.score.create(toScore(s, traceHex, byId.get(s.spanId ?? '')?.id, capture))
  // One failing sink never hides the other.
  await Promise.allSettled([lf.processor.forceFlush(), lf.client.flush()])
}

/** A judge verdict as a Langfuse score. A numeric verdict is `NUMERIC` 0..1; a
 *  refusal (no score) is a `CATEGORICAL` outcome under its own name, so one
 *  score name never holds two data types. Ids are deterministic, so a replay
 *  of the same verdict updates instead of duplicating. */
export function toScore(s: PendingScore, traceHex: string, observationId: string | undefined, capture: boolean) {
  const numeric = typeof s.value === 'number' && Number.isFinite(s.value)
  const name = numeric ? clean(s.name, 100) : `${clean(s.name, 90)}.outcome`
  const comment = capture && s.rationale ? clean(`${s.verdict} - ${s.rationale}`, 500) : clean(s.verdict, 100)
  return {
    id: createHash('sha256').update(`${traceHex}|${s.spanId ?? ''}|${name}`).digest('hex').slice(0, 32),
    traceId: traceHex,
    ...(observationId ? { observationId } : {}),
    name,
    ...(numeric ? { value: s.value as number, dataType: 'NUMERIC' as const } : { value: clean(s.verdict, 100), dataType: 'CATEGORICAL' as const }),
    comment,
    environment: tracingEnvironment(),
    metadata: safeMetadata(s.metadata),
  }
}

// --- delivery -----------------------------------------------------------------------------

/** The symbol @vercel/functions' get-context reads (3.9.11). Read directly:
 *  the package does not export getContext and its waitUntil is a silent no-op
 *  without a context, so detecting registration here is the only honest way. */
const REQ_CTX = Symbol.for('@vercel/request-context')
let tail: Promise<unknown> = Promise.resolve() // one replay at a time per instance
let warnedNoContext = false

/** A replay that has not finished by now is abandoned, so one hung export
 *  cannot stall every later trace queued behind it (the OTLP exporter has its
 *  own 5 s timeout; this is the backstop). */
const JOB_TIMEOUT_MS = 15_000

function bounded(job: () => Promise<void>): () => Promise<void> {
  return () =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`export still running after ${JOB_TIMEOUT_MS} ms`)), JOB_TIMEOUT_MS)
      timer.unref()
      job().then(resolve, reject).finally(() => clearTimeout(timer))
    })
}

function deliver(unbounded: () => Promise<void>): Promise<void> {
  const job = bounded(unbounded)
  const run = tail.then(job, job)
  tail = run.catch(() => undefined)
  const safe = run.catch((err) => {
    console.warn(`[langfuse] export failed: ${redactString(String(err).slice(0, 300))}`)
  })
  const ctx = (globalThis as unknown as Record<symbol, { get?: () => { waitUntil?: (p: Promise<unknown>) => void } | undefined } | undefined>)[REQ_CTX]?.get?.()
  if (typeof ctx?.waitUntil === 'function') {
    ctx.waitUntil(safe)
    return Promise.resolve()
  }
  if (process.env.VERCEL && !warnedNoContext) {
    warnedNoContext = true
    console.warn(`[langfuse] no Vercel request context; export awaited with a ${FLUSH_DEADLINE_MS} ms deadline`)
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, FLUSH_DEADLINE_MS)
    timer.unref()
    void safe.then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * Export one flushed buffer to Langfuse. Never rejects, and a complete no-op
 * (no import, no work) when Langfuse is unconfigured or the trace is sampled
 * out. Resolves at once under a Vercel request context, else within
 * FLUSH_DEADLINE_MS.
 */
export function exportTrace(buffer: SpanBuffer, rows: SpanRecord[]): Promise<void> {
  try {
    if (rows.length === 0 || !buffer.exportEnabled) return Promise.resolve()
    // Taken now, not inside the deferred replay, so a later flush of the same
    // buffer never sends them twice.
    const scores = buffer.takeScores()
    return deliver(() => send(buffer, rows, scores))
  } catch (err) {
    console.warn(`[langfuse] export skipped: ${redactString(String(err).slice(0, 300))}`)
    return Promise.resolve()
  }
}
