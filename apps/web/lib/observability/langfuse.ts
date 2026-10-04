// Optional trace mirror to Langfuse. trace_spans (lib/trace/spans.ts) stays
// the system of record; this module only ever ADDS a second, best-effort
// copy so Langfuse's UI can show prompts, completions, tokens and cost.
//
// GATING MIRRORS lib/observability/sentry.ts: unless LANGFUSE_PUBLIC_KEY,
// LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL are ALL set (a half-configured
// state is the same as unset: a key with nowhere to send it, or a host with
// nothing to authenticate), this module is a complete no-op. No network
// call, and `langfuse` is never even imported (it is a dynamic import behind
// the synchronous `langfuseConfigured()` check, so cold start stays clean).
//
// WHAT IS SENT
//   - one trace per trace_id, named after the surface (the root 'graph'
//     span's name), with environment (VERCEL_ENV) and release
//     (VERCEL_GIT_COMMIT_SHA) so production and preview never mix
//   - 'llm' rows as GENERATIONS: model, token usage, cost, timing, error
//     level, and (unless LANGFUSE_CAPTURE_CONTENT=0) the prompt messages and
//     completion text
//   - 'node' / 'graph' rows as plain spans
//   Prompt and completion text exist only in memory (SpanRecord's
//   non-persisted `content` field, stripped before the Postgres insert) and
//   every string passes through redactString and a 16KB cap right here, the
//   single gate. Metadata goes through scrubMetadata, which redacts strings
//   and sensitive keys but keeps the numeric metrics.
//
// WHY POSTGRES STAYS THE SYSTEM OF RECORD, NOT LANGFUSE
//   Langfuse Cloud's free (Hobby) tier is 50,000 units a month, where a
//   unit is a trace, an observation or a score, with 30 days of retention.
//   Past the cap it stops accepting data. trace_spans has no such cap and is
//   written regardless. LANGFUSE_SAMPLE_RATE keeps whole traces together
//   (hash of trace_id) when the budget needs stretching.
//
// WHY AWAITED WITH A DEADLINE, NOT FIRE-AND-FORGET
//   Next 14 has no after()/waitUntil, and a Vercel function can freeze the
//   moment the response is sent, so a floating promise silently loses the
//   export. SpanBuffer.flush awaits mirrorSpansWithDeadline, which races the
//   export against MIRROR_DEADLINE_MS: a slow or down Langfuse costs a
//   request at most that long, and nothing here ever throws.

import { createHash } from 'node:crypto'
import type { Langfuse } from 'langfuse'
import type { SpanRecord } from '../trace/spans'
import { redactString, scrubMetadata } from './scrub'

/** Longest a request may wait on the Langfuse export. */
export const MIRROR_DEADLINE_MS = 2500
/** Per-string cap for captured prompt/completion text. */
export const CONTENT_CAP_CHARS = 16 * 1024

let cachedClient: Langfuse | null = null

/** The single on/off switch for this module. All three must be non-blank. */
export function langfuseConfigured(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY?.trim() &&
      process.env.LANGFUSE_SECRET_KEY?.trim() &&
      process.env.LANGFUSE_BASE_URL?.trim()
  )
}

/** Prompt/completion capture is on by default once Langfuse is configured;
 *  LANGFUSE_CAPTURE_CONTENT=0 (or false/off) turns it off. */
export function langfuseCaptureEnabled(): boolean {
  if (!langfuseConfigured()) return false
  return !/^(0|false|off|no)$/i.test(process.env.LANGFUSE_CAPTURE_CONTENT?.trim() ?? '')
}

/** LANGFUSE_SAMPLE_RATE clamped to 0..1; unset, blank or invalid means 1. */
export function langfuseSampleRate(): number {
  const raw = process.env.LANGFUSE_SAMPLE_RATE?.trim()
  if (!raw) return 1
  const n = Number(raw)
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1
}

/** Deterministic per-trace sampling: the same trace_id always lands on the
 *  same side, so a trace is exported whole or not at all. */
export function traceSampled(traceId: string, rate: number = langfuseSampleRate()): boolean {
  if (rate >= 1) return true
  if (rate <= 0) return false
  return createHash('sha256').update(traceId).digest().readUInt32BE(0) / 2 ** 32 < rate
}

/** Langfuse only accepts lowercase [a-z0-9_-] and nothing starting with
 *  'langfuse'. VERCEL_ENV is production, preview or development. */
function tracingEnvironment(): string {
  const env = (process.env.VERCEL_ENV?.trim() || 'development').toLowerCase().replace(/[^a-z0-9_-]/g, '-')
  return env.startsWith('langfuse') ? 'development' : env
}

async function getClient(): Promise<Langfuse | null> {
  if (!langfuseConfigured()) return null
  if (cachedClient) return cachedClient
  const { Langfuse: LangfuseCtor } = await import('langfuse')
  cachedClient = new LangfuseCtor({
    secretKey: process.env.LANGFUSE_SECRET_KEY?.trim(),
    publicKey: process.env.LANGFUSE_PUBLIC_KEY?.trim(),
    baseUrl: process.env.LANGFUSE_BASE_URL?.trim(),
    environment: tracingEnvironment(),
    release: process.env.VERCEL_GIT_COMMIT_SHA?.trim() || undefined,
    // Sampling is done per trace in mirrorSpansToLangfuse. Passing 1 stops
    // the SDK from also reading LANGFUSE_SAMPLE_RATE and sampling twice.
    sampleRate: 1,
    // Fail fast: the caller only waits MIRROR_DEADLINE_MS anyway.
    requestTimeout: 2000,
    fetchRetryCount: 1,
    fetchRetryDelay: 300,
  })
  return cachedClient
}

/** Redact secret/PII-shaped substrings, then cap. Slicing BEFORE redaction
 *  only bounds regex work; it is 4x the final cap, so a secret cut in half
 *  by it can never reach the final output. */
function scrubText(text: string): string {
  const redacted = redactString(text.slice(0, CONTENT_CAP_CHARS * 4))
  return redacted.length > CONTENT_CAP_CHARS ? `${redacted.slice(0, CONTENT_CAP_CHARS)}…[truncated]` : redacted
}

function scrubContent(content: SpanRecord['content']) {
  if (!content) return {}
  return {
    input: content.input?.map((m) => ({ role: String(m.role).slice(0, 20), content: scrubText(String(m.content)) })),
    output: content.output === undefined ? undefined : scrubText(String(content.output)),
  }
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/**
 * Mirror already-flushed trace_spans rows to Langfuse. Complete no-op with no
 * `langfuse` import when unconfigured. NEVER throws and NEVER rejects: a
 * down endpoint, a bad key or a timeout all land here as one logged line.
 */
export async function mirrorSpansToLangfuse(rows: SpanRecord[]): Promise<void> {
  if (rows.length === 0 || !langfuseConfigured()) return
  try {
    const rate = langfuseSampleRate()
    const kept = rows.filter((r) => traceSampled(r.trace_id, rate))
    if (kept.length === 0) return
    const client = await getClient()
    if (!client) return
    const capture = langfuseCaptureEnabled()

    const tracedIds = new Set<string>()
    for (const row of kept) {
      if (!tracedIds.has(row.trace_id)) {
        tracedIds.add(row.trace_id)
        // Trace name = the surface = the root graph span's name, else the first row's.
        const mine = kept.filter((r) => r.trace_id === row.trace_id)
        const name = (mine.find((r) => r.kind === 'graph' && !r.parent_span_id) ?? mine[0]).name
        const start = mine.reduce((min, r) => (r.start_time < min ? r.start_time : min), mine[0].start_time)
        client.trace({
          id: row.trace_id,
          name,
          timestamp: new Date(start),
          userId: row.user_id,
          sessionId: row.thread_id ?? undefined,
        })
      }
      const attrs = row.attributes ?? {}
      const failed = row.status === 'error'
      const error = typeof attrs.error === 'string' ? attrs.error : undefined
      const common = {
        id: row.span_id,
        traceId: row.trace_id,
        parentObservationId: row.parent_span_id ?? undefined,
        name: row.name,
        startTime: new Date(row.start_time),
        endTime: new Date(row.end_time),
        metadata: row.attributes ? scrubMetadata(row.attributes) : undefined,
        level: failed ? ('ERROR' as const) : ('DEFAULT' as const),
        statusMessage: failed && error ? scrubText(error) : undefined,
      }
      if (row.kind === 'llm') {
        const usage = { input: num(attrs.promptTokens), output: num(attrs.completionTokens), total: num(attrs.tokensUsed) }
        const cost = num(attrs.costUsd)
        client.generation({
          ...common,
          model: typeof attrs.model === 'string' ? attrs.model : undefined,
          usageDetails: Object.fromEntries(Object.entries(usage).filter(([, v]) => v !== undefined)) as Record<string, number>,
          // Local CLI and local-server calls cost nothing per token; the
          // price table's estimate would be a made-up number there.
          costDetails: cost !== undefined && attrs.metered !== false ? { total: cost } : undefined,
          ...(capture ? scrubContent(row.content) : {}),
        })
      } else {
        client.span(common)
      }
    }
    await client.flushAsync()
  } catch (err) {
    console.error(
      `[observability] Langfuse export failed (${rows.length} span(s) not mirrored): ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/** mirrorSpansToLangfuse raced against a deadline, timer always cleared.
 *  Resolves (never rejects) within `ms` even if Langfuse hangs; the abandoned
 *  export may finish in the background. */
export async function mirrorSpansWithDeadline(rows: SpanRecord[], ms: number = MIRROR_DEADLINE_MS): Promise<void> {
  if (rows.length === 0 || !langfuseConfigured()) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.error(`[observability] Langfuse export still pending after ${ms}ms (${rows.length} span(s)); not waiting`)
      resolve()
    }, ms)
  })
  try {
    await Promise.race([mirrorSpansToLangfuse(rows), deadline])
  } catch (err) {
    console.error(`[observability] Langfuse mirror threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timer)
  }
}
