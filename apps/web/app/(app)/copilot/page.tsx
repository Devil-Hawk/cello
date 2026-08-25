'use client'

// Cello Copilot — a single Claude-Code-like surface: a conversation list on
// the left, the tool-calling chat thread in the center, and the agent-run
// rail on the right. Talks the SSE contract served by /api/copilot (see that
// route's doc comment): each POST streams `data: <json>\n\n` events —
// thought/tool_call/observation build up the current turn's step cards live,
// `paused` hands control back to the user in review mode, `final`/`error`
// close the turn out, and a literal "[DONE]" line ends the stream.
//
// HARNESS FEEL: every SSE event (reasoning/thought/final) delivers its full
// string in ONE event — there is no token-by-token streaming on the wire
// (see route.ts). <MessageBubble> below opts newly-arrived ("live") turns
// into a client-simulated typing reveal (useRevealedText, from ./hooks) so
// the transcript still reads as a working agent, not a page that flashes
// text into existence. Reconstructed history never re-animates.
//
// LIGHTWEIGHT: <MessageBubble> is memoized. patchTurn/upsertStep replace
// only the touched message's object in `messages`, so every OTHER message
// keeps the exact same object reference across a re-render — combined with
// memoization, that means an SSE tick for turn N does not re-render turns
// 1..N-1. The row-level callbacks (`actions`) are a single ref-stable object
// created once (see actionsRef below) so passing them down never itself
// invalidates the memo. See PRODUCT-VISION's "no full-list re-render per
// token" ask.
//
// RESILIENCE: a dropped connection (a deploy, a hot reload, a network blip —
// anything that isn't the user's own Stop button) used to surface as a raw
// browser "Load failed" and lose the turn outright. runStream performs ONE
// network attempt and reports what happened (see StreamResult); reconnect
// takes it from there with bounded, backed-off retries — GET ?conversationId=
// to resync against what the server already persisted (its own top-level
// catch in route.ts saves a partial/fallback message the instant a request
// aborts), never a blind repost once a response was ever obtained. The
// composer is freed immediately on a drop (never blocks new input on a
// background recovery), and a `connection` state on the affected ChatMessage
// drives an honest "reconnecting…" / "couldn't reconnect, Retry" banner —
// see ConnectionBanner below. classifyStreamError is the ONE place that
// decides stop-vs-drop: AbortController.abort() is called nowhere but
// handleStop, so an AbortError always means "stopped", never "reconnect".

import type { FormQuestion } from '@/components/copilot/question-form'
import { memo, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Activity, History, Loader2, Pencil, Sparkles, WifiOff, X } from 'lucide-react'
import { toast } from '@/components/ui/use-toast'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { AnimatePresence, motion, transitionFast } from '@/components/ui/motion'
import { cn, newClientId } from '@/lib/utils'
import { STEP_AGENT_TYPES, isStepAgentType, type StepAgentType } from '@/lib/harness/copilot-tool-catalog'
import { DEFAULT_MODEL_ID, getModelInfo, isAllowedModel, resolveModelId } from '@/lib/models'
import { ConversationSidebar } from '@/components/copilot/conversation-sidebar'
import { Composer, DEFAULT_MODEL_SENTINEL } from '@/components/copilot/composer'
import { RunsPanel } from '@/components/copilot/runs-panel'
import { StepList } from '@/components/copilot/step-card'
import { Markdown } from '@/components/copilot/markdown'
import { useIsMobile, useRevealedText } from '@/components/copilot/hooks'
import {
  RECONNECT_MAX_ATTEMPTS,
  buildCopilotRequestBody,
  classifyStreamError,
  findResolvedAssistantMessage,
  reconnectDelayMs,
  type RunTurnOpts,
} from '@/components/copilot/reconnect'
import type { AskOption, ChatMessage, ConnectionState, ConversationSummary, StepEntry } from '@/components/copilot/types'

const SUGGESTIONS = [
  'What are my freshest roles at my dream companies?',
  'Optimize my resume for one of my top jobs',
  "Research a company I'm tracking",
  'Source fresh roles at my dream companies and match them',
]

interface SseEvent {
  type:
    | 'conversation'
    | 'reasoning'
    | 'thought'
    | 'tool_call'
    | 'observation'
    | 'paused'
    | 'question'
    | 'user_message'
    | 'final'
    | 'error'
  conversationId?: string
  title?: string
  step?: number
  thought?: string
  reasoning?: string
  tool?: string
  args?: Record<string, unknown>
  observation?: string
  questions?: FormQuestion[]
  id?: string
  message?: string
  error?: string
  needsKey?: boolean
  requiresConfirmation?: boolean
  reason?: string
  question?: string
  options?: AskOption[]
}

/** Outcome of one attempt to run/resume a turn's SSE stream (see runStream):
 *  - 'done': reached a real terminal event (final/error) AND the server's own
 *    "[DONE]" sentinel — the ordinary, successful path.
 *  - 'stopped': the user's own Stop button (classifyStreamError's ONLY
 *    'stopped' source) — never reconnect.
 *  - 'server_error': the server responded but with something other than a
 *    live event stream (bad auth, bad model, etc.) — a real answer already
 *    surfaced to the user; not a connectivity problem, so not reconnect-worthy.
 *  - 'dropped': the connection died — thrown mid-read, or the stream just
 *    ended without ever sending "[DONE]" (a silent cutoff, previously
 *    invisible to the user). `retriable` is true only when the very first
 *    fetch() never got a response at all, meaning nothing could have reached
 *    the server yet — the ONLY case it's safe to blindly resend the same
 *    POST; once a response was obtained, recovery must always resync via
 *    GET, never risk a duplicate side effect by reposting blind. */
type StreamResult =
  | { kind: 'done' }
  | { kind: 'stopped' }
  | { kind: 'server_error' }
  | { kind: 'dropped'; conversationId?: string; retriable: boolean }

/**
 * Reflects the active conversation in the URL WITHOUT going through Next's
 * router — a plain `history.replaceState` needs no network round trip, so it
 * can never itself turn a dropped connection into a hard page navigation.
 *
 * `router.replace()` here used to do this instead, and it is genuinely
 * dangerous around a network drop: the App Router fetches the target route's
 * RSC payload as part of any `replace`/`push`, and observed behavior (while
 * testing the SSE-drop recovery this file adds — see runStream/reconnect) is
 * that a failed RSC fetch falls back to a hard `window.location` navigation,
 * which then ALSO fails while offline and blanks the whole page — destroying
 * every message currently in memory, exactly what this file's reconnect work
 * exists to prevent. This page never needs Next to re-render a server
 * component for a conversationId change (searchParams is read exactly once,
 * on mount), so there is nothing lost by not routing through it.
 */
function setUrlConversationId(conversationId: string | null) {
  if (typeof window === 'undefined') return
  const url = conversationId ? `/copilot?conversationId=${conversationId}` : '/copilot'
  window.history.replaceState(window.history.state, '', url)
}

function isErrorObservation(obs: unknown): boolean {
  if (obs == null) return false
  let value: unknown = obs
  if (typeof obs === 'string') {
    try {
      value = JSON.parse(obs)
    } catch {
      return false
    }
  }
  return typeof value === 'object' && value !== null && 'error' in (value as Record<string, unknown>)
}

/** Reconstruct a turn's step cards from a persisted `trace` (assumed to be an
 *  array of {step?, tool, args, thought, observation, status?} rows — the
 *  natural shape for the server to journal from the same events it streams).
 *  A `tool: 'ask_user'` row is special-cased: pending (status 'ask', no
 *  observation yet) renders the live question UI; resolved (status 'ok',
 *  observation.answer set) renders the settled Q&A — see route.ts's ask
 *  handling and step-card.tsx. */
function normalizeTrace(trace: unknown): StepEntry[] {
  if (!Array.isArray(trace)) return []
  return trace.map((raw, i) => {
    const t = (raw ?? {}) as Record<string, unknown>
    const rawStatus = typeof t.status === 'string' ? t.status : undefined
    const tool = typeof t.tool === 'string' ? t.tool : undefined
    const args = t.args && typeof t.args === 'object' ? (t.args as Record<string, unknown>) : undefined

    if (tool === 'ask_user') {
      const isPending = rawStatus === 'ask'
      const obs = t.observation && typeof t.observation === 'object' ? (t.observation as Record<string, unknown>) : null
      const question = typeof args?.question === 'string' ? args.question : undefined
      const rawOptions = Array.isArray(args?.options) ? (args.options as unknown[]) : []
      const options = rawOptions.filter(
        (o): o is AskOption => Boolean(o) && typeof o === 'object' && typeof (o as AskOption).label === 'string'
      )
      return {
        step: typeof t.step === 'number' ? t.step : i + 1,
        thought: typeof t.thought === 'string' ? t.thought : undefined,
        tool,
        question,
        options: options.length ? options : undefined,
        answer: typeof obs?.answer === 'string' ? obs.answer : undefined,
        status: isPending ? 'ask' : 'done',
      }
    }

    const status: StepEntry['status'] =
      rawStatus === 'error' || isErrorObservation(t.observation)
        ? 'error'
        : rawStatus === 'skipped'
        ? 'skipped'
        : 'done'
    return {
      step: typeof t.step === 'number' ? t.step : i + 1,
      thought: typeof t.thought === 'string' ? t.thought : undefined,
      tool,
      args,
      observation: t.observation,
      status,
    }
  })
}

const DEFAULT_COMPOSER = {
  enabledAgents: [...STEP_AGENT_TYPES] as StepAgentType[],
  model: DEFAULT_MODEL_SENTINEL,
  thinkingMode: 'auto' as 'auto' | 'review',
  bypassMode: false,
}

/* ------------------------------------------------------------------ */
/* MessageBubble — memoized transcript row                             */
/* ------------------------------------------------------------------ */

interface ChatActions {
  onApprove: (id: string) => void
  onContinue: (id: string, directive: string) => void
  onConfirm: (id: string) => void
  onDecline: (id: string, note?: string) => void
  onAnswer: (id: string, answer: string) => void
  onStartEdit: (id: string) => void
  onCancelEdit: () => void
  onChangeEditText: (text: string) => void
  onConfirmEdit: (id: string) => void
  /** Manual retry after reconnect attempts are exhausted (connection.status
   *  === 'failed') — see the module doc comment's "SURVIVE A DROPPED STREAM". */
  onRetryConnection: (id: string) => void
}

/** Shown on an assistant turn while its stream is being recovered after an
 *  unexpected drop, or once recovery has given up — an honest status instead
 *  of the raw "Load failed" a dropped SSE connection used to surface (or,
 *  worse, a silent hang: the turn just stops updating with no explanation).
 *  Never shown for a deliberate user Stop — see classifyStreamError. */
function ConnectionBanner({ connection, onRetry }: { connection: ConnectionState; onRetry: () => void }) {
  if (connection.status === 'reconnecting') {
    return (
      <div className="mb-2 flex items-center gap-2 rounded-control border border-accent/40 bg-accent-soft/25 px-2.5 py-1.5 text-caption text-accent-deep">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        <span>
          Connection dropped — reconnecting… (attempt {connection.attempt} of {connection.maxAttempts})
        </span>
      </div>
    )
  }
  return (
    <div className="mb-2 flex items-center justify-between gap-2 rounded-control border border-rose-500/30 bg-rose-500/5 px-2.5 py-1.5 text-caption text-rose-700 dark:text-rose-300">
      <span className="flex items-center gap-2">
        <WifiOff className="h-3.5 w-3.5 shrink-0" />
        Connection lost — couldn&apos;t reconnect. What&apos;s above is what came through.
      </span>
      <Button type="button" size="sm" variant="outline" onClick={onRetry} className="h-6 shrink-0 px-2 text-[11px]">
        Retry
      </Button>
    </div>
  )
}

interface MessageBubbleProps {
  message: ChatMessage
  /** True only for a turn actually streaming/resuming this session — see
   *  the module doc comment above for why this drives the typing reveal. */
  live: boolean
  isEditing: boolean
  editText: string
  canEdit: boolean
  actions: ChatActions
}

const MessageBubble = memo(function MessageBubble({
  message: m,
  live,
  isEditing,
  editText,
  canEdit,
  actions,
}: MessageBubbleProps) {
  const settled = !m.pending && !m.paused && !m.question
  const contentReveal = useRevealedText(m.content, live && !m.error)
  const showCaret = live && !m.error && contentReveal.revealing

  return (
    <motion.div
      layout="position"
      initial={live ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={transitionFast}
      className={cn('group/msg flex', m.role === 'user' ? 'justify-end' : 'justify-start')}
    >
      {m.role === 'user' && !isEditing && canEdit && (
        <button
          type="button"
          onClick={() => actions.onStartEdit(m.id)}
          aria-label="Edit message"
          className="mr-1.5 self-center rounded-control p-1.5 text-muted-foreground opacity-60 transition-opacity hover:bg-card hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/msg:opacity-100"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      )}
      <div
        className={cn(
          'rounded-card px-4 py-3',
          m.role === 'user'
            ? isEditing
              ? 'w-full max-w-[75ch] border border-accent/50 bg-card text-foreground'
              : 'max-w-[85%] bg-primary text-primary-foreground sm:max-w-[75ch]'
            : m.error
            ? 'w-full border border-rose-500/30 bg-rose-500/5 text-foreground'
            : 'w-full border border-border bg-card text-foreground'
        )}
      >
        {m.role === 'user' &&
          (isEditing ? (
            <div className="space-y-2">
              <Textarea
                value={editText}
                onChange={(e) => actions.onChangeEditText(e.target.value)}
                className="min-h-[64px] text-caption"
                autoFocus
              />
              <div className="flex justify-end gap-2">
                <Button type="button" size="sm" variant="outline" onClick={actions.onCancelEdit}>
                  <X className="mr-1 h-3.5 w-3.5" />
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={!editText.trim()}
                  onClick={() => actions.onConfirmEdit(m.id)}
                >
                  Save & re-run
                </Button>
              </div>
            </div>
          ) : (
            <p className="whitespace-pre-wrap text-body leading-relaxed">{m.content}</p>
          ))}

        {m.role === 'assistant' && (
          <>
            {m.connection && (
              <ConnectionBanner connection={m.connection} onRetry={() => actions.onRetryConnection(m.id)} />
            )}
            {m.steps.length > 0 && (
              <StepList
                steps={m.steps}
                live={live}
                settled={settled}
                onApprove={() => actions.onApprove(m.id)}
                onContinue={(d) => actions.onContinue(m.id, d)}
                onConfirm={() => actions.onConfirm(m.id)}
                onDecline={(note) => actions.onDecline(m.id, note)}
                onAnswer={(a) => actions.onAnswer(m.id, a)}
              />
            )}
            {m.pending && m.steps.length === 0 && !m.connection && (
              <span className="inline-flex items-center gap-2 text-body text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Thinking…
              </span>
            )}
            {m.error ? (
              <p className="text-body leading-relaxed">
                {m.error.message}
                {m.error.needsKey && (
                  <>
                    {' '}
                    <Link href="/settings?tab=api-keys" className="font-medium text-accent-deep underline underline-offset-2">
                      Add an OpenRouter key in Settings.
                    </Link>
                  </>
                )}
              </p>
            ) : (
              m.content && (
                <div>
                  <Markdown content={live ? contentReveal.text : m.content} />
                  {showCaret && (
                    <span
                      aria-hidden="true"
                      className="mt-1 inline-block h-3.5 w-[3px] animate-pulse bg-accent"
                    />
                  )}
                </div>
              )
            )}
          </>
        )}
      </div>
    </motion.div>
  )
})

/* ------------------------------------------------------------------ */
/* Page                                                                 */
/* ------------------------------------------------------------------ */

export default function CopilotPage() {
  const searchParams = useSearchParams()
  const isMobile = useIsMobile()

  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [conversationsLoading, setConversationsLoading] = useState(true)
  const [conversationLoading, setConversationLoading] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [runsCollapsed, setRunsCollapsed] = useState(false)
  const [defaultModelLabel, setDefaultModelLabel] = useState(
    getModelInfo(DEFAULT_MODEL_ID)?.label ?? DEFAULT_MODEL_ID
  )
  const [composerSettings, setComposerSettings] = useState(DEFAULT_COMPOSER)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  const abortRef = useRef<AbortController | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const didInit = useRef(false)
  /** Ids of assistant turns actually streaming/resuming THIS session — see
   *  the module doc comment: only these get the typing-reveal treatment,
   *  never messages reconstructed from persisted history. */
  const liveIdsRef = useRef<Set<string>>(new Set())
  /** Mirrors state the ref-stable `actions` callbacks below need to read at
   *  call time without becoming part of any dependency array (see the
   *  LIGHTWEIGHT note atop this file) — written every render, a plain,
   *  React-sanctioned "cache the latest values in a ref" pattern. */
  const stateRef = useRef({ messages, streaming, editText })
  stateRef.current = { messages, streaming, editText }
  /** True once this component has unmounted — checked between the async
   *  gaps in `reconnect` (a multi-second, backoff-driven loop) so a stale
   *  recovery attempt never calls setState after the page is gone. The
   *  effect body resets this to false on every (re)mount, not just the
   *  cleanup setting it true: React 18 StrictMode's dev-only mount ->
   *  unmount -> remount simulation runs this cleanup once even though the
   *  component stays genuinely alive, and a set-only-true flag would then
   *  incorrectly read "unmounted" for the rest of the component's real
   *  lifetime — silently killing every reconnect attempt in development. */
  const unmountedRef = useRef(false)
  useEffect(() => {
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
    }
  }, [])
  /** Per-turn context a dropped stream's recovery needs to keep retrying —
   *  set once when a drop is first detected (see runStream/reconnect below),
   *  read by both the automatic backoff loop and a manual Retry click.
   *  Deliberately NOT component state: it changes every retry tick and drives
   *  no rendering of its own (the `connection` field on the ChatMessage does
   *  that), so it belongs in a ref, not a re-render. */
  const reconnectCtxRef = useRef<Map<string, { opts: RunTurnOpts; conversationId?: string; retriable: boolean }>>(
    new Map()
  )
  /** Same ref-indirection reason as runTurnRef below: `reconnect` recurses
   *  and is also invoked from the ref-stable `actions.onRetryConnection`, so
   *  callers must always reach the CURRENT closure, never a stale one. */
  const reconnectRef = useRef<(turnId: string, attempt: number) => void>(() => {})

  activeIdRef.current = activeId

  // Mobile: collapse both rails the FIRST time a mobile viewport is
  // detected (post-mount — matchMedia isn't available during SSR), so a
  // phone never opens onto three squeezed columns. Only fires once so it
  // never fights a manual toggle later in the same viewport class.
  const mobileInitRef = useRef(false)
  useEffect(() => {
    if (isMobile && !mobileInitRef.current) {
      mobileInitRef.current = true
      setSidebarOpen(false)
      setRunsCollapsed(true)
    }
  }, [isMobile])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      stickToBottomRef.current = distance < 96
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (!stickToBottomRef.current) return
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (didInit.current) return
    didInit.current = true

    loadConversations()

    fetch('/api/settings/model')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const id = resolveModelId(data?.model)
        setDefaultModelLabel(getModelInfo(id)?.label ?? id)
      })
      .catch(() => {
        /* best-effort — falls back to DEFAULT_MODEL_ID's label */
      })

    const cid = searchParams.get('conversationId')
    if (cid) loadConversation(cid)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadConversations() {
    setConversationsLoading(true)
    try {
      const res = await fetch('/api/copilot?list=1')
      if (res.ok) {
        const data = await res.json()
        if (Array.isArray(data.conversations)) setConversations(data.conversations)
      }
    } catch {
      /* best-effort */
    } finally {
      setConversationsLoading(false)
    }
  }

  async function loadConversation(id: string) {
    setConversationLoading(true)
    try {
      const res = await fetch(`/api/copilot?conversationId=${id}`)
      if (!res.ok) {
        toast({ title: 'Could not load conversation', variant: 'destructive' })
        return
      }
      const data = await res.json()
      const conv = data.conversation as
        | { id: string; title: string; model: string | null; enabled_agents: unknown; bypass_mode?: boolean }
        | undefined
      const rawMessages = Array.isArray(data.messages) ? data.messages : []
      const loaded: ChatMessage[] = rawMessages.map(
        (m: { id?: string; role: string; content: string; trace?: unknown; created_at?: string }) => {
          const steps = normalizeTrace(m.trace)
          const pendingAsk = steps.length > 0 ? steps[steps.length - 1] : undefined
          return {
            id: newClientId(),
            serverId: m.id,
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: typeof m.content === 'string' ? m.content : '',
            steps,
            pending: false,
            ...(pendingAsk && pendingAsk.status === 'ask' && pendingAsk.question
              ? { question: { step: pendingAsk.step, question: pendingAsk.question, options: pendingAsk.options } }
              : {}),
            createdAt: m.created_at,
          }
        }
      )
      // Fresh conversation: nothing loaded from history is "live" — reset
      // the reveal-eligibility set so a stale id from a prior chat can never
      // accidentally re-trigger a typing animation here.
      liveIdsRef.current = new Set()
      setMessages(loaded)
      setActiveId(id)

      const rawAgents = Array.isArray(conv?.enabled_agents) ? (conv!.enabled_agents as unknown[]) : []
      const agents = rawAgents.filter(isStepAgentType)
      setComposerSettings({
        enabledAgents: agents.length ? agents : [...STEP_AGENT_TYPES],
        model: conv?.model && isAllowedModel(conv.model) ? conv.model : DEFAULT_MODEL_SENTINEL,
        thinkingMode: 'auto',
        bypassMode: Boolean(conv?.bypass_mode),
      })
    } catch {
      toast({ title: 'Could not load conversation', variant: 'destructive' })
    } finally {
      setConversationLoading(false)
    }
  }

  function newChat() {
    setActiveId(null)
    setMessages([])
    liveIdsRef.current = new Set()
    setComposerSettings(DEFAULT_COMPOSER)
    setUrlConversationId(null)
  }

  function selectConversation(id: string) {
    if (id === activeId) return
    loadConversation(id)
    setUrlConversationId(id)
  }

  async function deleteConversation(id: string) {
    try {
      const res = await fetch(`/api/copilot?conversationId=${id}`, { method: 'DELETE' })
      if (!res.ok) {
        toast({ title: 'Could not delete conversation', variant: 'destructive' })
        return
      }
      setConversations((prev) => prev.filter((c) => c.id !== id))
      if (activeIdRef.current === id) newChat()
    } catch {
      toast({ title: 'Could not delete conversation', variant: 'destructive' })
    }
  }

  function patchTurn(id: string, fn: (m: ChatMessage) => ChatMessage) {
    setMessages((prev) => prev.map((m) => (m.id === id ? fn(m) : m)))
  }

  function upsertStep(id: string, step: number, patch: Partial<StepEntry>) {
    patchTurn(id, (m) => {
      const idx = m.steps.findIndex((s) => s.step === step)
      if (idx === -1) {
        return { ...m, steps: [...m.steps, { step, status: 'thinking', ...patch } as StepEntry] }
      }
      const next = [...m.steps]
      next[idx] = { ...next[idx], ...patch }
      return { ...m, steps: next }
    })
  }

  /** A planning call that goes straight from `reasoning` to `final` — no
   *  `thought`/`tool_call`/`observation` in between, a genuinely common case
   *  (the model reasons, decides it already has everything, and just
   *  answers) — otherwise leaves that step permanently in 'thinking' with a
   *  spinner that never stops, since nothing else would ever flip its
   *  status. Sweep any step still 'thinking'/'running' once the turn
   *  concludes: 'done' when it concluded in a real answer (`final`), or
   *  'skipped' when the turn was cut short (`error`, or the client Stop/
   *  network-drop paths below) so it never falsely reads as a success. */
  function settleLingeringSteps(steps: StepEntry[], status: 'done' | 'skipped'): StepEntry[] {
    return steps.map((s) => (s.status === 'thinking' || s.status === 'running' ? { ...s, status } : s))
  }

  /**
   * Performs exactly one attempt at the POST + SSE read for a turn — no
   * retrying, no reconnect decisions, just "try the network once and report
   * what happened" (see StreamResult). Split out of runTurn so the SAME
   * attempt logic serves the initial send AND a reconnect's from-scratch
   * retry (see `reconnect` below) without duplicating the SSE parsing.
   */
  async function runStream(turnId: string, body: Record<string, unknown>, controller: AbortController): Promise<StreamResult> {
    let res: Response
    try {
      res = await fetch('/api/copilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (e) {
      if (classifyStreamError(e) === 'stopped') {
        patchTurn(turnId, (m) => ({ ...m, pending: false }))
        return { kind: 'stopped' }
      }
      // Never even got a response — nothing could have reached the server
      // (no conversation created, no message persisted), so a blind resend
      // on retry is safe. See the StreamResult doc comment's `retriable`.
      return { kind: 'dropped', retriable: true }
    }

    const contentType = res.headers.get('content-type') ?? ''
    if (!res.ok || !contentType.includes('text/event-stream')) {
      let errMsg = `Request failed (${res.status})`
      let needsKey = false
      try {
        const data = await res.json()
        if (typeof data.error === 'string') errMsg = data.error
        needsKey = Boolean(data.needsKey)
      } catch {
        /* non-JSON error body */
      }
      patchTurn(turnId, (m) => ({ ...m, pending: false, error: { message: errMsg, needsKey } }))
      return { kind: 'server_error' }
    }

    if (!res.body) {
      patchTurn(turnId, (m) => ({ ...m, pending: false, error: { message: 'No response stream from server.' } }))
      return { kind: 'server_error' }
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let sawDone = false
    let conversationId: string | undefined

    try {
      outer: while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''
        for (const part of parts) {
          const line = part.trim()
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload) continue
          if (payload === '[DONE]') {
            sawDone = true
            break outer
          }

          let evt: SseEvent
          try {
            evt = JSON.parse(payload)
          } catch {
            continue
          }
          if (evt.conversationId) conversationId = evt.conversationId

          switch (evt.type) {
            case 'conversation': {
              if (evt.conversationId) {
                setActiveId(evt.conversationId)
                const cid = evt.conversationId
                const title = evt.title ?? 'New chat'
                setConversations((prev) => {
                  const others = prev.filter((c) => c.id !== cid)
                  return [{ id: cid, title, updated_at: new Date().toISOString() }, ...others]
                })
                setUrlConversationId(cid)
              }
              break
            }
            case 'reasoning':
              if (typeof evt.step === 'number') {
                upsertStep(turnId, evt.step, { reasoning: String(evt.reasoning ?? ''), status: 'thinking' })
              }
              break
            case 'thought':
              if (typeof evt.step === 'number') upsertStep(turnId, evt.step, { thought: evt.thought, status: 'thinking' })
              break
            case 'tool_call':
              if (typeof evt.step === 'number') {
                upsertStep(turnId, evt.step, { tool: evt.tool, args: evt.args, status: 'running' })
              }
              break
            case 'observation':
              if (typeof evt.step === 'number') {
                upsertStep(turnId, evt.step, {
                  observation: evt.observation,
                  status: isErrorObservation(evt.observation) ? 'error' : 'done',
                })
              }
              break
            case 'paused':
              if (typeof evt.step === 'number') {
                upsertStep(turnId, evt.step, {
                  thought: evt.thought,
                  tool: evt.tool,
                  args: evt.args,
                  status: 'paused',
                  requiresConfirmation: evt.requiresConfirmation,
                  reason: evt.reason,
                })
                patchTurn(turnId, (m) => ({
                  ...m,
                  pending: false,
                  paused: {
                    step: evt.step!,
                    thought: evt.thought ?? '',
                    tool: evt.tool ?? '',
                    args: evt.args ?? {},
                    requiresConfirmation: evt.requiresConfirmation,
                    reason: evt.reason,
                  },
                }))
              }
              break
            case 'user_message': {
              const clientId = pendingUserMsgIdRef.current
              if (clientId && typeof evt.id === 'string') {
                const serverId = evt.id
                setMessages((prev) =>
                  prev.map((m) => (m.id === clientId ? { ...m, serverId } : m))
                )
                pendingUserMsgIdRef.current = null
              }
              break
            }
            case 'question':
              // Structured form: several decisions at once. Checked first; the
              // single-question shape below still handles a plain ask.
              if (typeof evt.step === 'number' && Array.isArray(evt.questions) && evt.questions.length > 0) {
                const qs = evt.questions
                upsertStep(turnId, evt.step, { questions: qs, question: qs[0]?.question, status: 'ask' })
                patchTurn(turnId, (m) => ({
                  ...m,
                  pending: false,
                  question: { step: evt.step!, question: qs[0]?.question ?? 'A few questions', questions: qs },
                }))
                break
              }
              if (typeof evt.step === 'number' && typeof evt.question === 'string') {
                upsertStep(turnId, evt.step, { question: evt.question, options: evt.options, status: 'ask' })
                patchTurn(turnId, (m) => ({
                  ...m,
                  pending: false,
                  question: { step: evt.step!, question: evt.question!, options: evt.options },
                }))
              }
              break
            case 'final':
              patchTurn(turnId, (m) => ({
                ...m,
                content: evt.message ?? '(no answer)',
                pending: false,
                steps: settleLingeringSteps(m.steps, 'done'),
              }))
              break
            case 'error':
              patchTurn(turnId, (m) => ({
                ...m,
                pending: false,
                error: { message: evt.error ?? 'Something went wrong.', needsKey: Boolean(evt.needsKey) },
                steps: settleLingeringSteps(m.steps, 'skipped'),
              }))
              break
            default:
              break
          }
        }
      }
    } catch (e) {
      if (classifyStreamError(e) === 'stopped') return { kind: 'stopped' }
      // A real connectivity failure mid-read (network drop, reset connection,
      // browser gone offline) — the server already responded once, so a
      // blind repost risks a duplicate side effect; only a GET resync is safe.
      return { kind: 'dropped', conversationId, retriable: false }
    }

    if (!sawDone) {
      // The stream ended WITHOUT the server's own "[DONE]" sentinel — a
      // silent cutoff (a proxy timeout, a deploy, a dead connection the
      // browser never surfaced as an error). Previously this looked
      // identical to a normal finish and just... stopped, with no
      // explanation. Treat it exactly like a thrown drop.
      return { kind: 'dropped', conversationId, retriable: false }
    }
    return { kind: 'done' }
  }

  /**
   * Reconciles a dropped turn with what the server actually persisted,
   * without discarding or re-keying any OTHER message on screen (a full
   * `setMessages(loaded)` reload — fine for a deliberate conversation
   * switch — would otherwise remount every row and lose scroll position for
   * what should be a quiet background recovery). Returns false while the
   * server hasn't caught up yet (its own top-level catch persists the
   * dropped turn's outcome synchronously on abort — see route.ts — but the
   * abort signal itself can take a moment to propagate), so the caller knows
   * to keep retrying rather than show a transcript silently missing its answer.
   */
  function applyResync(turnId: string, conversationId: string, data: { messages?: unknown[] }): boolean {
    if (activeIdRef.current !== conversationId) return true // navigated away — stop, don't clobber what's on screen
    const last = findResolvedAssistantMessage(data?.messages)
    if (!last) return false

    const steps = normalizeTrace(last.trace)
    const pendingAsk = steps.length > 0 ? steps[steps.length - 1] : undefined
    patchTurn(turnId, (m) => ({
      ...m,
      serverId: typeof last.id === 'string' ? last.id : m.serverId,
      content: typeof last.content === 'string' ? last.content : m.content,
      steps,
      pending: false,
      error: undefined,
      connection: undefined,
      question:
        pendingAsk && pendingAsk.status === 'ask' && pendingAsk.question
          ? { step: pendingAsk.step, question: pendingAsk.question, options: pendingAsk.options }
          : undefined,
      createdAt: typeof last.created_at === 'string' ? last.created_at : m.createdAt,
    }))
    return true
  }

  /**
   * Bounded, backoff recovery for a turn whose stream dropped (see
   * runStream's 'dropped' outcome) — never an infinite loop (RECONNECT_MAX_ATTEMPTS
   * caps it), and NEVER entered for a genuine user Stop (classifyStreamError
   * routes that to 'stopped' before this is ever scheduled). Prefers
   * resyncing via GET once a conversationId is known (the common, tested
   * path — the server already persisted the outcome by the time this runs);
   * only retries the original POST outright when nothing ever reached the
   * server in the first place (ctx.retriable).
   */
  async function reconnect(turnId: string, attempt: number) {
    const ctx = reconnectCtxRef.current.get(turnId)
    if (!ctx || unmountedRef.current) return

    if (attempt > RECONNECT_MAX_ATTEMPTS || (!ctx.conversationId && !ctx.retriable)) {
      patchTurn(turnId, (m) => ({
        ...m,
        pending: false,
        connection: { status: 'failed', attempt: Math.min(attempt - 1, RECONNECT_MAX_ATTEMPTS), maxAttempts: RECONNECT_MAX_ATTEMPTS },
      }))
      return
    }

    patchTurn(turnId, (m) => ({
      ...m,
      pending: true,
      connection: { status: 'reconnecting', attempt, maxAttempts: RECONNECT_MAX_ATTEMPTS },
    }))
    await new Promise((resolve) => setTimeout(resolve, reconnectDelayMs(attempt)))
    if (unmountedRef.current || !reconnectCtxRef.current.has(turnId)) return
    if (ctx.conversationId && activeIdRef.current !== ctx.conversationId) return // navigated away — stop quietly

    if (ctx.conversationId) {
      try {
        const res = await fetch(`/api/copilot?conversationId=${encodeURIComponent(ctx.conversationId)}`)
        if (!res.ok) throw new Error(String(res.status))
        const data = await res.json()
        if (applyResync(turnId, ctx.conversationId, data)) {
          reconnectCtxRef.current.delete(turnId)
          return
        }
      } catch {
        /* still unreachable, or the server hasn't caught up yet — retry below */
      }
      reconnect(turnId, attempt + 1)
      return
    }

    // Nothing ever reached the server on the first attempt — safe to resend
    // the exact same request rather than resync (there's nothing to resync).
    const body = buildCopilotRequestBody(
      ctx.opts,
      composerSettings,
      STEP_AGENT_TYPES.length,
      DEFAULT_MODEL_SENTINEL,
      activeIdRef.current ?? undefined
    )
    const controller = new AbortController()
    const result = await runStream(turnId, body, controller)
    if (result.kind === 'dropped') {
      reconnectCtxRef.current.set(turnId, { ...ctx, conversationId: result.conversationId, retriable: result.retriable })
      reconnect(turnId, attempt + 1)
      return
    }
    reconnectCtxRef.current.delete(turnId)
    if (result.kind === 'stopped') return // runStream already cleared pending
    patchTurn(turnId, (m) => (m.pending ? { ...m, pending: false, steps: settleLingeringSteps(m.steps, 'skipped') } : m))
  }
  reconnectRef.current = reconnect

  async function runTurn(opts: RunTurnOpts) {
    const { message, resumeId } = opts
    const isResume = Boolean(resumeId)
    let turnId: string

    if (isResume) {
      turnId = resumeId!
      patchTurn(turnId, (m) => ({
        ...m,
        pending: true,
        paused: undefined,
        question: undefined,
        error: undefined,
        connection: undefined,
      }))
    } else {
      const userMsg: ChatMessage = { id: newClientId(), role: 'user', content: message, steps: [], pending: false }
      // Held so the `user_message` event can stamp the server id onto THIS
      // message. Editing requires a serverId, and until the server told us one
      // a freshly sent message could never be edited — only history could.
      pendingUserMsgIdRef.current = userMsg.id
      const asstMsg: ChatMessage = { id: newClientId(), role: 'assistant', content: '', steps: [], pending: true }
      turnId = asstMsg.id
      setMessages((prev) => [...prev, userMsg, asstMsg])
    }
    // This turn is genuinely streaming this session — eligible for the
    // typing-reveal treatment regardless of whether its message id was
    // freshly minted above or is a resumed/reconstructed sentinel.
    liveIdsRef.current.add(turnId)
    stickToBottomRef.current = true

    const body = buildCopilotRequestBody(
      opts,
      composerSettings,
      STEP_AGENT_TYPES.length,
      DEFAULT_MODEL_SENTINEL,
      activeIdRef.current ?? undefined
    )
    const controller = new AbortController()
    abortRef.current = controller
    setStreaming(true)

    const result = await runStream(turnId, body, controller)
    abortRef.current = null

    if (result.kind === 'dropped') {
      // Composer usable immediately — this turn keeps recovering in the
      // background (see reconnect above); never blocks new input on it.
      setStreaming(false)
      reconnectCtxRef.current.set(turnId, { opts, conversationId: result.conversationId, retriable: result.retriable })
      reconnect(turnId, 1)
      return
    }

    setStreaming(false)
    // Mirrors the old finally block for every non-'dropped' outcome ('done',
    // 'stopped' via the user's Stop button, or a 'server_error' that already
    // patched its own message) — never leaves a step frozen mid-"thinking".
    patchTurn(turnId, (m) => (m.pending ? { ...m, pending: false, steps: settleLingeringSteps(m.steps, 'skipped') } : m))
  }

  // Kept as a plain (non-memoized) ref so the stable `actions` object below
  // always calls the CURRENT closure — see runTurnRef.
  const runTurnRef = useRef(runTurn)
  runTurnRef.current = runTurn

  function handleSend(text: string) {
    if (streaming) return
    runTurn({ message: text })
  }
  function handleStop() {
    abortRef.current?.abort()
  }

  // A single, permanently-stable object (created once — see the lazy-init
  // guard) so passing it to every <MessageBubble> never itself invalidates
  // memoization. Each method reads current state via stateRef/runTurnRef
  // instead of closing over render-scoped values, so it never goes stale
  // despite never being recreated. See the LIGHTWEIGHT note atop this file.
  const pendingUserMsgIdRef = useRef<string | null>(null)
  const actionsRef = useRef<ChatActions | null>(null)
  if (!actionsRef.current) {
    actionsRef.current = {
      onApprove: (id) => runTurnRef.current({ message: '', directive: '', resumeId: id }),
      onContinue: (id, directive) => runTurnRef.current({ message: '', directive, resumeId: id }),
      onConfirm: (id) => runTurnRef.current({ message: '', directive: '', resumeId: id, confirmToolCall: true }),
      // A decline carries the user's note as the directive when they wrote
      // one, and an explicit refusal when they did not — never the model's own
      // reasoning, which is what the old prefilled-textarea branch sent back.
      onDecline: (id, note) =>
        runTurnRef.current({
          message: '',
          directive: note ?? 'The user declined this action. Do not attempt it again unless they ask.',
          resumeId: id,
        }),
      onAnswer: (id, answer) => {
        if (!answer.trim()) return
        runTurnRef.current({ message: '', directive: answer, resumeId: id })
      },
      onStartEdit: (id) => {
        if (stateRef.current.streaming) return
        const m = stateRef.current.messages.find((x) => x.id === id)
        if (!m) return
        setEditingId(id)
        setEditText(m.content)
      },
      onCancelEdit: () => {
        setEditingId(null)
        setEditText('')
      },
      onChangeEditText: (text) => setEditText(text),
      // Destructive by design (Claude Code behaviour): saving an edit
      // discards every later message in the conversation, so this always
      // asks first — never a side effect of typing.
      onConfirmEdit: (id) => {
        const { messages: msgs, editText: text, streaming: isStreaming } = stateRef.current
        const trimmed = text.trim()
        const m = msgs.find((x) => x.id === id)
        if (!trimmed || !m?.serverId || isStreaming) return
        const idx = msgs.findIndex((x) => x.id === id)
        const laterCount = idx === -1 ? 0 : msgs.length - idx - 1
        const ok = window.confirm(
          laterCount > 0
            ? `Save this edit and re-run from here? This discards ${laterCount} later message${laterCount === 1 ? '' : 's'} in this conversation.`
            : 'Save this edit and re-run from here?'
        )
        if (!ok) return
        setEditingId(null)
        setEditText('')
        setMessages((prev) => (idx === -1 ? prev : prev.slice(0, idx)))
        runTurnRef.current({ message: trimmed, editMessageId: m.serverId })
      },
      // Manual retry once bounded automatic recovery gives up (connection
      // .status === 'failed') — resets the attempt counter and tries again;
      // reconnectCtxRef still holds this turn's context (never cleared on
      // failure) so there's nothing for the user to retype.
      onRetryConnection: (id) => {
        if (!reconnectCtxRef.current.has(id)) return
        reconnectRef.current(id, 1)
      },
    }
  }
  const actions = actionsRef.current

  const empty = messages.length === 0

  return (
    <div className="flex h-[calc(100vh-9.5rem)] gap-3 md:h-[calc(100vh-5rem)]">
      <ConversationSidebar
        conversations={conversations}
        activeId={activeId}
        loading={conversationsLoading}
        onSelect={selectConversation}
        onNew={newChat}
        onDelete={deleteConversation}
        mobile={isMobile}
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              aria-label="Show conversations"
              className="shrink-0 rounded-control p-1.5 text-muted-foreground hover:bg-card md:hidden"
            >
              <History className="h-[18px] w-[18px]" />
            </button>
            <div className="min-w-0">
              <h1 className="flex items-center gap-2 font-display text-title text-foreground">
                Copilot
                {streaming && <span className="signal-dot" aria-hidden="true" />}
              </h1>
              <p className="mt-0.5 truncate text-caption text-muted-foreground">
                Ask about matches, sharpen your resume, research companies, or drive the agent harness.
              </p>
            </div>
          </div>
          {conversationLoading && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />}
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-4 scrollbar-thin">
          {empty ? (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft">
                <Sparkles className="h-5 w-5 text-accent-deep" />
              </div>
              <h2 className="font-display text-section text-foreground">How can I help your search?</h2>
              <p className="mt-1.5 max-w-sm text-caption text-muted-foreground">
                I reason step by step — reading your jobs, running the resume optimizer, researching
                companies, and kicking off agent runs — and I show every tool call live.
              </p>
              <div className="mt-5 flex max-w-lg flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => handleSend(s)}
                    className="rounded-full border border-border bg-card px-3 py-1.5 text-caption text-foreground transition-colors hover:border-accent/50 hover:bg-muted"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <AnimatePresence initial={false}>
              {messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  message={m}
                  live={liveIdsRef.current.has(m.id)}
                  isEditing={editingId === m.id}
                  editText={editingId === m.id ? editText : ''}
                  canEdit={m.role === 'user' && Boolean(m.serverId) && !streaming}
                  actions={actions}
                />
              ))}
            </AnimatePresence>
          )}
        </div>

        <Composer
          enabledAgents={composerSettings.enabledAgents}
          onAgentsChange={(ids) => setComposerSettings((s) => ({ ...s, enabledAgents: ids }))}
          model={composerSettings.model}
          onModelChange={(model) => setComposerSettings((s) => ({ ...s, model }))}
          defaultModelLabel={defaultModelLabel}
          thinkingMode={composerSettings.thinkingMode}
          onThinkingModeChange={(mode) => setComposerSettings((s) => ({ ...s, thinkingMode: mode }))}
          bypassMode={composerSettings.bypassMode}
          onBypassModeChange={(on) => setComposerSettings((s) => ({ ...s, bypassMode: on }))}
          onSend={handleSend}
          onStop={handleStop}
          streaming={streaming}
        />
      </div>

      {isMobile && runsCollapsed && (
        <button
          type="button"
          onClick={() => setRunsCollapsed(false)}
          aria-label="Show agent runs"
          className="fixed bottom-24 right-4 z-30 flex h-11 w-11 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-pop"
        >
          <Activity className="h-[18px] w-[18px]" />
        </button>
      )}

      <RunsPanel
        collapsed={runsCollapsed}
        onToggleCollapsed={() => setRunsCollapsed((v) => !v)}
        mobile={isMobile}
      />
    </div>
  )
}
