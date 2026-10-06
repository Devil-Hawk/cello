// Server-sent events for useStream.
//
// The UI uses LangGraph's own React hook with its FetchStreamTransport, which POSTs to our
// route and reads SSE. A LangGraph server would send each chunk as an event named for its
// stream mode, with the subgraph path after a bar: "values", "messages", "updates", "custom",
// and "values|tools:call_1" for a subagent. Messages must be plain dicts ({type: "ai", ...}),
// not LangChain's constructor form, because the hook reads them as dicts. sse.test.ts feeds
// this output through the SDK's own transport and checks both.

import { BaseMessage } from '@langchain/core/messages'

export interface WireEvent {
  event: string
  data: unknown
}

/** "values", or "values|tools:abc" when the chunk came from inside a subagent. */
export function eventName(namespace: readonly string[], mode: string): string {
  return namespace.length > 0 ? `${mode}|${namespace.join('|')}` : mode
}

/** A message as the hook reads it: its fields with a `type` ("ai", "human", "tool"). */
export function messageToWire(m: BaseMessage): Record<string, unknown> {
  const { type, data } = m.toDict() as unknown as { type: string; data: Record<string, unknown> }
  return { ...data, type }
}

/** Replace every message in a value with its wire form. Depth-limited so a cycle cannot hang a stream. */
export function toWire(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value
  if (BaseMessage.isInstance(value)) return messageToWire(value)
  if (depth > 6) return undefined
  if (Array.isArray(value)) return value.map((v) => toWire(v, depth + 1))
  if (value instanceof Date) return value.toISOString()
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toWire(v, depth + 1)
  return out
}

/** One chunk of agent.stream({streamMode: [...], subgraphs: true}) as an event. */
export function chunkToEvent(chunk: readonly [readonly string[], string, unknown]): WireEvent {
  const [namespace, mode, data] = chunk
  // The messages mode carries a [message, metadata] pair.
  if (mode === 'messages' && Array.isArray(data)) return { event: eventName(namespace, mode), data: [toWire(data[0]), toWire(data[1])] }
  return { event: eventName(namespace, mode), data: toWire(data) }
}

const encoder = new TextEncoder()

export function encodeEvent(e: WireEvent): Uint8Array {
  return encoder.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data ?? null)}\n\n`)
}

/** Keeps a quiet connection open through proxies. Comments are ignored by the reader. */
const KEEPALIVE = encoder.encode(': keepalive\n\n')
const KEEPALIVE_MS = 15_000

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const

/**
 * A streaming response. `produce` runs to completion and calls `emit` for each event; a throw
 * becomes an error event the hook shows, and the stream always closes.
 */
export function toSseResponse(produce: (emit: (e: WireEvent) => void, signal: AbortSignal) => Promise<void>, onAbort?: AbortSignal): Response {
  const abort = new AbortController()
  onAbort?.addEventListener('abort', () => abort.abort(), { once: true })
  let timer: ReturnType<typeof setInterval> | undefined
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (bytes: Uint8Array) => {
        try {
          controller.enqueue(bytes)
        } catch {
          // The reader went away.
        }
      }
      timer = setInterval(() => send(KEEPALIVE), KEEPALIVE_MS)
      try {
        await produce((e) => send(encodeEvent(e)), abort.signal)
      } catch (e) {
        send(encodeEvent({ event: 'error', data: { error: 'Error', message: e instanceof Error ? e.message : String(e) } }))
      } finally {
        if (timer) clearInterval(timer)
        try {
          controller.close()
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      if (timer) clearInterval(timer)
      abort.abort()
    },
  })
  return new Response(stream, { headers: SSE_HEADERS })
}
