// Optional trace mirror to Langfuse — trace_spans (lib/trace/spans.ts) stays
// the system of record; this module only ever ADDS a second, best-effort
// copy for whoever wants Langfuse's UI on top of the same spans.
//
// GATING MIRRORS lib/observability/sentry.ts EXACTLY (read that file's header
// first): a self-hoster who never sets LANGFUSE_SECRET_KEY + LANGFUSE_BASE_URL
// (both are required — there is no useful half-configured state, a secret key
// with nowhere to send it or a URL with nothing to authenticate is the same
// as unset) must see zero behavioral difference from this module existing —
// no network call, no `langfuse` import into memory. Every exported function
// starts with the synchronous `langfuseConfigured()` check BEFORE the dynamic
// `import('langfuse')`, so the package is never even loaded when unconfigured
// — a bundle-conscious dynamic import, not a top-level one, is what keeps
// cold start clean for the common (unconfigured) case.
//
// WHY POSTGRES STAYS THE SYSTEM OF RECORD, NOT LANGFUSE
//   Langfuse Cloud's free (Hobby) tier caps ingestion at 50,000 observations
//   a month; a self-hosted Langfuse has its own storage limits an operator
//   set up separately from Cello's. Either way, an account that runs past
//   whatever cap is in front of it silently stops accepting new spans —
//   trace_spans in Postgres has no such cap and is written first, directly,
//   by the same three chokepoints (invoke.ts/unit.ts/llm.ts) regardless of
//   whether Langfuse is configured at all. This module is a mirror an
//   operator opted into for Langfuse's UI, never a second place a span's
//   existence depends on.
//
// WHY FIRE-AND-FORGET, NOT AWAITED
//   SpanBuffer.flush() (lib/trace/spans.ts) already awaits the Postgres
//   insert — that's the write the request actually depends on. Awaiting a
//   THIRD-PARTY network call on top of that would tax every request's
//   latency by however slow Langfuse's ingestion endpoint is that day, for a
//   copy nothing reads synchronously. mirrorSpansToLangfuse itself never
//   rejects (see the try/catch below); flush() additionally never awaits its
//   promise, only attaches `.catch(log)` — belt-and-suspenders against that
//   contract ever slipping, exactly like logHarnessError's `void
//   captureError(...)` call.

import type { SpanRecord } from '../trace/spans'

/** Trimmed, structurally-typed surface of the `langfuse` module this file
 *  actually calls — avoids a static `import type` of the package so nothing
 *  here forces the SDK's types to be resolved when unused. */
interface LangfuseSpanClient {
  trace(body: { id: string; userId?: string; sessionId?: string }): unknown
  span(body: {
    id: string
    traceId: string
    parentObservationId?: string
    name: string
    startTime: Date
    endTime: Date
    metadata?: Record<string, unknown>
    level?: 'DEFAULT' | 'ERROR'
  }): unknown
  flushAsync(): Promise<void>
}

interface LangfuseModule {
  Langfuse: new (params: { secretKey?: string; publicKey?: string; baseUrl?: string }) => LangfuseSpanClient
}

let cachedClient: LangfuseSpanClient | null = null

/** Trimmed env vars, or undefined if either is unset/blank. The single
 *  on/off switch for this entire module — see file header for why both are
 *  required together. LANGFUSE_PUBLIC_KEY is read too (Langfuse's own auth
 *  header needs a key pair) but is not part of the gate: an operator who
 *  omits it gets Langfuse's own "no public key" warning and a no-op export,
 *  never a Cello-side crash. */
export function langfuseConfigured(): boolean {
  const secret = process.env.LANGFUSE_SECRET_KEY?.trim()
  const baseUrl = process.env.LANGFUSE_BASE_URL?.trim()
  return Boolean(secret && baseUrl)
}

async function getClient(): Promise<LangfuseSpanClient | null> {
  if (!langfuseConfigured()) return null
  if (cachedClient) return cachedClient
  const { Langfuse } = (await import('langfuse')) as unknown as LangfuseModule
  cachedClient = new Langfuse({
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL,
  })
  return cachedClient
}

/**
 * Mirror already-flushed trace_spans rows to Langfuse. Complete no-op with no
 * `langfuse` import when unconfigured. NEVER throws and NEVER rejects — a
 * down Langfuse endpoint, a bad key, a network timeout, all land here as one
 * logged line, not a failed run (see judge.ts's meteredFetch and log.ts's
 * logHarnessError for the same "report, never propagate" shape elsewhere in
 * this codebase).
 */
export async function mirrorSpansToLangfuse(rows: SpanRecord[]): Promise<void> {
  if (rows.length === 0 || !langfuseConfigured()) return
  try {
    const client = await getClient()
    if (!client) return
    const tracedIds = new Set<string>()
    for (const row of rows) {
      if (!tracedIds.has(row.trace_id)) {
        tracedIds.add(row.trace_id)
        client.trace({ id: row.trace_id, userId: row.user_id, sessionId: row.thread_id ?? undefined })
      }
      client.span({
        id: row.span_id,
        traceId: row.trace_id,
        parentObservationId: row.parent_span_id ?? undefined,
        name: row.name,
        startTime: new Date(row.start_time),
        endTime: new Date(row.end_time),
        metadata: row.attributes ?? undefined,
        level: row.status === 'error' ? 'ERROR' : 'DEFAULT',
      })
    }
    await client.flushAsync()
  } catch (err) {
    console.error(
      `[observability] Langfuse export failed (${rows.length} span(s) not mirrored): ${err instanceof Error ? err.message : String(err)}`
    )
  }
}
