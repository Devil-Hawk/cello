// Pure decision logic behind the copilot page's stream-drop recovery.
//
// A copilot turn is a long-lived SSE connection (app/api/copilot/route.ts) —
// a deploy, a hot reload, a flaky network, or a proxy timeout can sever it
// mid-turn with no warning. Before this module existed, ANY interruption
// other than the user's own Stop button surfaced as a raw browser "Load
// failed" and the turn was gone; see page.tsx's runStream/reconnect for the
// IO side (fetch, ReadableStream, timers) that this module's decisions feed.
//
// Kept dependency-free (no React, no fetch, no DOM) on purpose: these are the
// three judgment calls that actually determine correctness — everything else
// is plumbing — so they can be verified without a browser or a live server.

/** Bounded retries: a few attempts with backoff, then a clear failed state —
 *  never an infinite reconnect loop (see page.tsx's `reconnect`). */
export const RECONNECT_MAX_ATTEMPTS = 5

/** Exponential backoff (1s, 2s, 4s, 8s, capped) for the Nth attempt (1-indexed). */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 8000)
}

export type StreamFailureKind = 'stopped' | 'dropped'

/**
 * Classifies a thrown fetch/reader error. AbortController.abort() is called
 * in exactly one place in this app — the user's own Stop button (see
 * page.tsx's handleStop) — and that is the ONLY thing that throws a
 * DOMException named 'AbortError' here. Everything else (a network drop, a
 * reset connection, the browser going offline, a proxy cutting the stream)
 * must never be mistaken for a deliberate stop, or a real interruption would
 * silently look like the user meant to cancel.
 */
export function classifyStreamError(e: unknown): StreamFailureKind {
  return e instanceof DOMException && e.name === 'AbortError' ? 'stopped' : 'dropped'
}

export interface PersistedMessageLike {
  id?: string
  role?: string
  content?: unknown
  trace?: unknown
  created_at?: string
}

/**
 * A GET ?conversationId= resync only proves the dropped turn has actually
 * concluded server-side once the LAST persisted row is the assistant's half
 * of the exchange — the server always appends that synchronously as part of
 * handling an aborted request (see route.ts's top-level catch persisting a
 * partial/fallback message before the function returns). If the last row is
 * still the user's message, the server hasn't caught up yet: keep retrying
 * rather than showing a transcript that's silently missing its answer.
 */
export function findResolvedAssistantMessage(rawMessages: unknown): PersistedMessageLike | null {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) return null
  const last = rawMessages[rawMessages.length - 1] as PersistedMessageLike | undefined
  if (!last || last.role !== 'assistant') return null
  return last
}

export interface RunTurnOpts {
  message: string
  directive?: string
  resumeId?: string
  confirmToolCall?: boolean
  editMessageId?: string
}

export interface RequestComposerSettings {
  enabledAgents: string[]
  model: string
  thinkingMode: 'auto' | 'review'
  bypassMode: boolean
}

/** Builds the POST body for a turn (fresh send, resume, or a reconnect's
 *  from-scratch retry — see page.tsx's `reconnect`) — extracted so the same
 *  construction is used, and testable, in every place a turn can start. */
export function buildCopilotRequestBody(
  opts: RunTurnOpts,
  settings: RequestComposerSettings,
  allAgentsCount: number,
  defaultModelSentinel: string,
  conversationId: string | undefined
): Record<string, unknown> {
  const isResume = Boolean(opts.resumeId)
  const allAgentsEnabled = settings.enabledAgents.length === allAgentsCount
  const body: Record<string, unknown> = {
    message: isResume ? '' : opts.message,
    thinkingMode: settings.thinkingMode,
    bypassMode: settings.bypassMode,
  }
  if (conversationId) body.conversationId = conversationId
  if (!allAgentsEnabled) body.enabledAgents = settings.enabledAgents
  if (settings.model !== defaultModelSentinel) body.model = settings.model
  if (isResume) body.directive = opts.directive ?? ''
  if (opts.confirmToolCall) body.confirmToolCall = true
  if (opts.editMessageId) body.editMessageId = opts.editMessageId
  return body
}
