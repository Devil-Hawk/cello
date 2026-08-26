// POST /api/copilot — Cello Copilot, a Claude-Code-style tool-calling loop.
//
// The tool-calling loop itself (plan/dispatch/finalize, the confirm/review/
// ask pauses, the deadline-forced wrap-up) lives in lib/graph/copilot.ts as a
// LangGraph StateGraph — one thread per conversation, checkpointed in
// Postgres, resumed across HTTP requests instead of hand-rolled "pause
// sentinel" rows (docs/superpowers/specs/2026-08-16-langgraph-port-design.md,
// Stage 1's "Copilot on a StateGraph"). THIS FILE is the SSE adapter: it
// resolves the conversation/thread, decides whether to deliver `input` or a
// `resume` per the matrix below, drives the graph through
// lib/graph/invoke.ts#invokeGraphForUser, and translates whatever comes back
// into the SAME wire vocabulary this route has always spoken. Read
// lib/graph/copilot.ts's header before touching this file — most of the
// "why" for pause/ask/deadline mechanics lives there now, not here.
//
// WIRE CONTRACT (unchanged, byte-for-byte — see this file's own
// route.adapter.test.ts fixtures): this route streams
// Server-Sent Events (text/event-stream). Every event is `data: <json>\n\n`;
// the stream always ends with the literal line `data: [DONE]\n\n`. Event
// shapes:
//   {"type":"conversation","conversationId":string,"title":string}   // always first
//   {"type":"reasoning","step":number,"reasoning":string}
//   {"type":"thought","step":number,"thought":string}
//   {"type":"tool_call","step":number,"tool":string,"args":object}
//   {"type":"observation","step":number,"tool":string,"observation":string}  // truncated to 2000 chars
//   {"type":"paused","step":number,"thought":string,"tool":string,"args":object,
//    "requiresConfirmation"?:true,"reason"?:string}
//   {"type":"question","step":number,"question":string,"options"?:{"label":string,"detail"?:string}[]}
//   {"type":"question","step":number,"questions":object[]}  // structured multi-question form
//   {"type":"final","message":string}
//   {"type":"error","error":string,"needsKey"?:true}
// Errors that happen BEFORE we start streaming (bad auth, bad model) are plain
// JSON responses instead — see the early returns in POST. Once streaming has
// started we never fall back to a JSON response; everything becomes an
// `error` event so the client always gets a clean [DONE].
//
// RESUME MATRIX (spec item 2, implemented literally — see lib/graph/copilot.ts's
// CopilotResume type and dispatch/dispatchExecute for the receiving side).
// getGraphStateForUser is read on EVERY request against an existing thread,
// not only resumes — the route has to tell a genuinely mid-flight thread
// (killed before reaching any interrupt() — see invoke.ts's
// GraphStateForUser.next/pendingInterrupt doc) apart from one cleanly parked
// somewhere, BEFORE deciding what to send it:
//   - conversation has no thread_id yet -> mint one: `input:{message,turnConfig}`.
//   - thread mid-flight (a task queued to run next, nothing parked at
//     interrupt()) -> CONTINUE: neither `input` nor `resume` — see the
//     CONTINUE handling below for the recover-then-decide sequence. A
//     `resume` here has no interrupt() to attach to and would be silently
//     dropped (never done — production standard: no silently swallowed
//     input).
//   - a pending `ask`/`ask_form` interrupt, isResume -> `resume:{answer}`.
//   - a pending `confirm`/`review` interrupt, isResume:
//       confirmToolCall:true            -> `resume:{approved:true,confirmed:true}`
//       non-empty directive             -> `resume:{approved:false,directive}`
//       empty directive                 -> `resume:{approved:true}` (dispatchExecute
//                                           itself turns this into "not confirmed" when
//                                           the pause was guarded and confirmed stays false)
//   - nothing genuinely pending (a stray directive, or next_turn) while isResume,
//     OR a plain new message (isResume false, whatever is pending — including an
//     abandoned mid-turn pause) -> `resume:{kind:'message',message,turnConfig}`.
// A pending confirm pause is UNCONDITIONAL and independent of thinkingMode/
// bypassMode — an empty directive is never treated as approval when the pause
// was guarded; only confirmToolCall:true (or a matching resumed value) does.
//
// CONTINUE handling: a mid-flight thread is recovered with a plain, silent
// `invoke(null, cfg)` (no client-visible streaming — it may be settling a
// DIFFERENT, already-abandoned turn) via a single non-streaming
// invokeGraphForUser call. Where that recovery lands decides what happens to
// THIS request's own message/directive, which is never silently dropped:
//   - recovery itself throws -> the usual whole-turn safety net (below).
//   - recovery lands on a genuine new pause (confirm/review/ask/ask_form) ->
//     surface that pause normally, plus an `error` event saying plainly that
//     this request could not be applied yet.
//   - recovery lands back at next_turn (the interrupted turn resolved
//     cleanly) and this request was itself a resume -> whatever it was
//     trying to resolve no longer exists; report the recovered turn's
//     answer instead of guessing what to do with a stale directive.
//   - recovery lands back at next_turn and this request was a plain new
//     message -> chain it in immediately as an ordinary fresh turn
//     (`resume:{kind:'message',...}`), exactly as if the thread had been
//     idle when this request arrived.
//
// ASK (action:"ask"): the model can stop and ask instead of guessing when the
// answer would genuinely change what it does next — NEVER gated by
// thinkingMode/bypassMode (see lib/graph/copilot.ts#dispatchExecute, which is
// the only place thinkingMode/bypassMode are read at all).
//
// PERSISTENCE (spec item 3, Step 7's turn-assembly rework): copilot_messages
// is now the source of truth for what the model sees, not only the durable
// UI transcript — this route still writes every user turn (below, before
// invoking the graph) and every assistant turn (persistTurn, on a `final`
// outcome), and lib/graph/copilot.ts's beginTurn/assembleTurnContext reads
// the last 12 of them back out on every new turn, on top of a rolling
// summary (copilot_conversations.summary) and a MemoryStore.search — see
// that file's own header and assembleTurnContext's doc for why the
// checkpoint's `state.messages` no longer grows unboundedly across turns.
// Client input is still never trusted directly — the graph only ever reads
// what THIS route already wrote to copilot_messages, never `body.message`
// re-injected some other way. On an interrupt (paused/question) NOTHING is
// persisted as a sentinel anymore — the graph's own checkpoint holds the
// pending action; GET below keeps its read-filter hiding PRE-PORT sentinel
// rows for one release, but nothing writes new ones.
//
// EDIT + RE-RUN: POST with `editMessageId` deletes that message and
// everything after it, THEN abandons the conversation's LangGraph thread
// (nulls copilot_conversations.thread_id) so the next turn mints a fresh one
// — a rewound transcript and an untouched checkpoint history would disagree
// about what already happened.
//
// LLM: the user's saved OpenRouter key. Model is resolved as
// request.model (validated against ALLOWED_MODELS) -> the conversation's
// stored model -> callLlm's own per-user-preference/default fallback.
// Degrades gracefully with no key (never a 500).

import { randomUUID } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { loadApiKeys } from '@/lib/harness/keys'
import { REASONING_EFFORTS, type ReasoningEffort } from '@/lib/harness/types'
import { canRunLlm, missingOpenRouterMessage } from '@/lib/harness/llm-key-message'
import { isDemoProfile } from '@/lib/access/guardrails'
import { isStepAgentType } from '@/lib/harness/copilot-tool-catalog'
import { isAllowedModel, type ModelId } from '@/lib/models'
import {
  createConversation,
  getConversation,
  listConversations,
  appendMessage,
  loadRecentMessages,
  touchConversation,
  deleteConversation,
  deleteMessagesFrom,
  titleFromMessage,
  type ConversationRow,
} from '@/lib/harness/copilot-store'
import { invokeGraphForUser, getGraphStateForUser, type CompiledGraphLike, type GraphStateForUser } from '@/lib/graph/invoke'
import {
  copilotGraph,
  fallbackSummary,
  refreshConversationSummary,
  buildInputOrResume,
  isPausedSentinel,
  extractInterruptValue,
  translateInterruptToWireEvent,
  type TraceEntry,
  type CopilotTurnConfig,
  type WireEvent,
  type GraphInputOrResume,
  type PendingInterruptKind,
} from '@/lib/graph/copilot'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// copilotGraph (a real compiled LangGraph StateGraph) has a NARROWER
// `invoke` input type than CompiledGraphLike's own `unknown` — the same
// structural gap app/api/harness/run/route.ts already casts around for
// harnessRunGraph. invokeGraphForUser/getGraphStateForUser only ever call
// `.invoke`/`.stream`/`.getState` with the config they build themselves, so
// this is a type-only gap, not a behavioral one.
const COPILOT_GRAPH = copilotGraph as unknown as CompiledGraphLike

interface RequestBody {
  conversationId?: string
  message?: string
  enabledAgents?: string[]
  model?: string
  thinkingMode?: 'auto' | 'review'
  /** Reasoning depth for this turn; see REASONING_EFFORTS. */
  effort?: ReasoningEffort
  directive?: string
  /** Per-conversation "bypass permissions" toggle — see the route doc comment. */
  bypassMode?: boolean
  /** Explicit go-ahead for a pending `requiresConfirmation` paused tool call. */
  confirmToolCall?: boolean
  /** Edit-and-rerun: delete this message (and everything after it) before running `message`. */
  editMessageId?: string
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder()

  // --- Auth: 401 before streaming starts. ---
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // --- Parse + validate the body: bad model -> 400, before streaming starts. ---
  let body: RequestBody
  try {
    body = (await request.json()) as RequestBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const conversationIdIn =
    typeof body.conversationId === 'string' && body.conversationId.trim() ? body.conversationId.trim() : undefined
  const messageIn = typeof body.message === 'string' ? body.message : ''
  const isResume = typeof body.directive === 'string'
  const resumeDirective = isResume ? body.directive!.trim() : undefined
  const thinkingMode: 'auto' | 'review' = body.thinkingMode === 'review' ? 'review' : 'auto'
  // 'high' by default: a copilot turn's whole value is the visible reasoning
  // trace, and a request-supplied effort (below) always wins over this.
  const reasoningEffort: ReasoningEffort =
    body.effort && REASONING_EFFORTS.includes(body.effort) ? body.effort : 'high'
  const bypassModeIn = typeof body.bypassMode === 'boolean' ? body.bypassMode : undefined
  const confirmToolCall = body.confirmToolCall === true
  const editMessageId =
    typeof body.editMessageId === 'string' && body.editMessageId.trim() ? body.editMessageId.trim() : undefined

  let modelOverride: ModelId | undefined
  if (body.model !== undefined) {
    if (!isAllowedModel(body.model)) {
      return NextResponse.json({ error: `Unknown model "${body.model}"` }, { status: 400 })
    }
    modelOverride = body.model
  }

  const enabledAgentsIn = Array.isArray(body.enabledAgents) ? body.enabledAgents.filter(isStepAgentType) : undefined

  if (!isResume && !messageIn.trim()) {
    return NextResponse.json({ error: 'message is required' }, { status: 400 })
  }
  if (isResume && !conversationIdIn) {
    return NextResponse.json({ error: 'conversationId is required to resume' }, { status: 400 })
  }
  if (editMessageId && (!conversationIdIn || isResume)) {
    return NextResponse.json(
      { error: 'editMessageId requires conversationId and is not a resume (do not also send directive)' },
      { status: 400 }
    )
  }

  const admin = createAdminClient()

  // MemoryStore.add's own demo-write refusal (lib/memory/types.ts's header)
  // takes this as the caller's already-computed guard result rather than
  // re-reading profiles itself — same is_demo/demo_expires_at columns every
  // other demo chokepoint in this codebase reads directly (see
  // lib/access/demo-chokepoints.test.ts).
  const { data: demoProfileRow } = await admin.from('profiles').select('is_demo, demo_expires_at').eq('id', user.id).maybeSingle()
  const isDemo = isDemoProfile(demoProfileRow)

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const send = (event: Record<string, unknown>) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        } catch {
          // Client disconnected (e.g. hit Stop, or a genuine network drop) —
          // stop trying to write to a dead stream, but let the caller keep
          // going: persisting the partial turn below must still happen.
          closed = true
        }
      }
      const finish = () => {
        if (closed) return
        closed = true
        try {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        } catch {
          // Client already gone — nothing to close.
        }
      }

      // --- Resolve the conversation (create or load, ownership-checked). ---
      // Persistence is best-effort: a DB hiccup must not take down the whole
      // chat — the graph can still plan/call tools/answer with a synthetic,
      // never-persisted conversation (thread-linking inside the graph is a
      // no-op against a conversationId that doesn't exist, which is fine —
      // see lib/graph/copilot.ts#beginTurn's `.is('thread_id', null)` guard).
      let conversation: ConversationRow
      let persistenceHealthy = true
      if (conversationIdIn) {
        let found: ConversationRow | null = null
        try {
          found = await getConversation(admin, user.id, conversationIdIn)
        } catch (e) {
          send({ type: 'error', error: `Failed to load conversation: ${errMsg(e)}` })
          return finish()
        }
        if (!found) {
          send({ type: 'error', error: 'Conversation not found' })
          return finish()
        }
        conversation = found
      } else {
        const title = titleFromMessage(messageIn)
        try {
          conversation = await createConversation(admin, user.id, {
            title,
            model: modelOverride ?? null,
            enabledAgents: enabledAgentsIn ?? null,
            ...(bypassModeIn !== undefined ? { bypassMode: bypassModeIn } : {}),
          })
        } catch (e) {
          console.error('copilot: failed to persist new conversation, continuing without persistence', errMsg(e))
          persistenceHealthy = false
          const now = new Date().toISOString()
          conversation = {
            id: randomUUID(),
            user_id: user.id,
            title,
            model: modelOverride ?? null,
            enabled_agents: enabledAgentsIn ?? null,
            bypass_mode: bypassModeIn ?? false,
            thread_id: null,
            created_at: now,
            updated_at: now,
          }
        }
      }

      send({ type: 'conversation', conversationId: conversation.id, title: conversation.title })

      // Persist explicit overrides onto an existing conversation so future
      // requests that omit them keep using this conversation's choice.
      if (
        persistenceHealthy &&
        conversationIdIn &&
        (modelOverride !== undefined || enabledAgentsIn !== undefined || bypassModeIn !== undefined)
      ) {
        try {
          await touchConversation(admin, conversation.id, {
            ...(modelOverride !== undefined ? { model: modelOverride } : {}),
            ...(enabledAgentsIn !== undefined ? { enabledAgents: enabledAgentsIn } : {}),
            ...(bypassModeIn !== undefined ? { bypassMode: bypassModeIn } : {}),
          })
        } catch {
          // Non-fatal — the request still proceeds with the resolved values below.
        }
      }

      const effectiveModel: string | undefined =
        modelOverride ?? (conversation.model && isAllowedModel(conversation.model) ? conversation.model : undefined)
      const storedAgents = Array.isArray(conversation.enabled_agents)
        ? conversation.enabled_agents.filter(isStepAgentType)
        : undefined
      const effectiveAgentsList = enabledAgentsIn ?? storedAgents
      // Read-then-decide, never write: bypassMode only ever relaxes the
      // review-mode pause for READ/ACT tools — see lib/graph/copilot.ts's
      // dispatchExecute for the one thing it can never touch.
      const effectiveBypassMode: boolean = bypassModeIn ?? Boolean(conversation.bypass_mode)

      const turnConfig: CopilotTurnConfig = {
        model: effectiveModel,
        thinkingMode,
        effort: reasoningEffort,
        bypassMode: effectiveBypassMode,
        enabledAgents: effectiveAgentsList,
        userEmail: user.email ?? '',
        isDemo,
      }

      // A single best-effort persistence helper for the terminal state below.
      // Never throws — a persistence failure degrades the feature (no history
      // next turn) rather than the response the user is actively waiting on.
      const persistTurn = async (content: string, trace: TraceEntry[]) => {
        if (!persistenceHealthy) return
        try {
          await appendMessage(admin, {
            conversationId: conversation.id,
            userId: user.id,
            role: 'assistant',
            content,
            trace: trace.length ? trace : null,
          })
          await touchConversation(admin, conversation.id, {})
          // `send()` enqueues straight onto the SSE stream (no buffering),
          // so whatever this turn needed to tell the client is already on
          // the wire by the time persistTurn runs at every call site below —
          // awaiting this here adds no PERCEIVED latency, only serverless
          // execution time after the response the user cares about. Never
          // throws: the function's own try/catch swallows everything.
          await refreshConversationSummary(admin, user.id, conversation.id)
        } catch {
          // Best-effort — never throw out of an error/terminal path.
        }
      }

      // --- Edit-and-rerun: discard the edited message and everything after
      // it, THEN abandon the old graph thread (see this file's header for
      // why a rewound transcript can't share a checkpoint history with the
      // turns that came after the cut).
      if (editMessageId && persistenceHealthy) {
        try {
          await deleteMessagesFrom(admin, conversation.id, editMessageId)
          if (conversation.thread_id) {
            await admin.from('copilot_conversations').update({ thread_id: null }).eq('id', conversation.id)
            conversation = { ...conversation, thread_id: null }
          }
        } catch (e) {
          send({ type: 'error', error: `Failed to edit message: ${errMsg(e)}` })
          return finish()
        }
      }

      // --- No usable key: degrade gracefully, never 500. canRunLlm is the
      // single definition of "usable key" (lib/harness/llm-key-message.ts) —
      // matches /api/settings/status, /api/agents/match, /api/resume/optimize.
      const apiKeys = await loadApiKeys(admin, user.id)
      if (!canRunLlm(apiKeys)) {
        const needsKeyMessage = missingOpenRouterMessage(apiKeys)
        send({ type: 'error', error: needsKeyMessage, needsKey: true })
        if (!isResume && persistenceHealthy) {
          try {
            const savedUser = await appendMessage(admin, {
              conversationId: conversation.id,
              userId: user.id,
              role: 'user',
              content: messageIn,
            })
            send({ type: 'user_message', id: savedUser.id })
          } catch {
            // best-effort
          }
        }
        await persistTurn(needsKeyMessage, [])
        return finish()
      }

      // --- Build this request's `input` or `resume` — the RESUME MATRIX
      // documented atop this file, as the pure decision in
      // lib/graph/copilot.ts#buildInputOrResume (unit-tested there for every
      // branch, including CONTINUE). threadIdForInvoke stays undefined only
      // on a conversation whose thread was never minted (or was just
      // abandoned by editMessageId above), which is the one case `input` is
      // legal. getGraphStateForUser runs whenever a thread exists, not only
      // on isResume — see the header comment above for why.
      const threadIdForInvoke = conversation.thread_id ?? undefined
      let decision: GraphInputOrResume
      try {
        const threadState: GraphStateForUser | null = threadIdForInvoke
          ? await getGraphStateForUser(admin, user.id, threadIdForInvoke, COPILOT_GRAPH)
          : null
        const pendingKind = (threadState?.pendingInterrupt as { kind?: PendingInterruptKind } | null)?.kind ?? null
        const midFlight = Boolean(threadState) && threadState!.next.length > 0 && threadState!.pendingInterrupt === null
        decision = buildInputOrResume({
          hasThread: Boolean(threadIdForInvoke),
          isResume,
          midFlight,
          pendingKind,
          confirmToolCall,
          resumeDirective,
          messageIn,
          turnConfig,
        })
      } catch (e) {
        send({ type: 'error', error: `Failed to prepare conversation: ${errMsg(e)}` })
        return finish()
      }
      const graphInput = decision.kind === 'input' ? decision.input : undefined
      let graphResume = decision.kind === 'resume' ? decision.resume : undefined

      if (!isResume && persistenceHealthy) {
        try {
          const savedUser = await appendMessage(admin, {
            conversationId: conversation.id,
            userId: user.id,
            role: 'user',
            content: messageIn,
          })
          send({ type: 'user_message', id: savedUser.id })
        } catch {
          // Best-effort — the turn still proceeds; the graph's own
          // beginTurn appends the message to in-memory state regardless.
        }
      }

      // --- CONTINUE: the thread was killed mid-task — see the CONTINUE
      // handling paragraph in this file's header for the full decision tree.
      // The recovery leg never streams to the client (it may be settling a
      // DIFFERENT, already-abandoned turn) — a plain non-streaming `invoke`
      // returns the full settled state in one shot (finalMessage/trace/
      // __interrupt__), which is all this needs.
      if (decision.kind === 'continue') {
        let recoveredResult: unknown
        try {
          recoveredResult = (
            await invokeGraphForUser({
              admin,
              userId: user.id,
              surface: 'copilot',
              graph: COPILOT_GRAPH,
              threadId: threadIdForInvoke,
              signal: request.signal,
              extraConfigurable: { conversationId: conversation.id },
            })
          ).result
        } catch (e) {
          const aborted = request.signal.aborted || (e instanceof Error && e.name === 'AbortError')
          const message = aborted ? 'Stopped.' : `Copilot error recovering an interrupted turn: ${errMsg(e)}`
          await persistTurn(message, [])
          send({ type: aborted ? 'final' : 'error', ...(aborted ? { message } : { error: message }) })
          return finish()
        }

        const values = recoveredResult && typeof recoveredResult === 'object' ? (recoveredResult as Record<string, unknown>) : {}
        const recoveredFinal = typeof values.finalMessage === 'string' ? values.finalMessage : null
        const recoveredTrace = Array.isArray(values.trace) ? (values.trace as TraceEntry[]) : []
        const recoveredInterrupt = extractInterruptValue(recoveredResult)
        const recoveredKind = (recoveredInterrupt as { kind?: string } | null)?.kind ?? null

        if (recoveredFinal) await persistTurn(recoveredFinal, recoveredTrace)

        if (recoveredKind && recoveredKind !== 'next_turn') {
          // The recovered turn itself landed on a genuine new pause —
          // surface it exactly like an ordinary pause, and say plainly that
          // THIS request could not be applied this round (nothing was
          // silently dropped: it has nowhere safe to attach yet).
          const wireEvent = translateInterruptToWireEvent(recoveredInterrupt)
          if (wireEvent) send(wireEvent)
          send({
            type: 'error',
            error:
              'Your previous request was interrupted before it finished; I just recovered it and it is waiting on the pause above. Resolve that, then send your last message again.',
          })
          return finish()
        }

        if (isResume) {
          // Whatever this request was trying to resolve belonged to the
          // interrupted turn, not the one just recovered — there is nothing
          // safe to chain it onto. Report what recovery produced instead of
          // guessing what a stale directive should now apply to.
          const message = recoveredFinal ?? 'Recovered from an interruption. Please try your last action again.'
          send({ type: 'final', message })
          if (!recoveredFinal) await persistTurn(message, [])
          return finish()
        }

        // Plain new message, recovery landed cleanly at next_turn — chain
        // THIS request's message in as an ordinary fresh turn, exactly as if
        // the thread had been idle when this request arrived.
        graphResume = { kind: 'message', message: messageIn, turnConfig }
      }

      // --- Drive the graph, translating its stream into the wire vocabulary
      // above in real time. wireEvents (reasoning/thought/tool_call/
      // observation) come off each node's own chunk; `finalMessage` off
      // finalize's chunk is captured for persistence once the run settles;
      // an interrupt (paused/question) is read from invokeGraphForUser's own
      // return value — see extractInterruptValue's doc for why.
      let capturedFinal: { message: string; trace: TraceEntry[] } | null = null
      const streamHandler = (chunk: unknown) => {
        if (!chunk || typeof chunk !== 'object' || '__interrupt__' in (chunk as Record<string, unknown>)) return
        for (const update of Object.values(chunk as Record<string, unknown>)) {
          if (!update || typeof update !== 'object') continue
          const u = update as Record<string, unknown>
          if (Array.isArray(u.wireEvents)) {
            for (const ev of u.wireEvents as WireEvent[]) send(ev)
          }
          if (typeof u.finalMessage === 'string') {
            capturedFinal = { message: u.finalMessage, trace: Array.isArray(u.trace) ? (u.trace as TraceEntry[]) : [] }
          }
        }
      }

      // Whole-turn safety net: an aborted fetch (the Stop button, which
      // aborts request.signal — threaded into the graph via invokeGraphForUser's
      // own `signal`, reaching every in-flight callLlm/dispatchTool call) or
      // any other exception mid-run rejects invokeGraphForUser's promise
      // instead of resolving it. The checkpoint still holds whatever trace
      // the last COMPLETED node wrote (a thrown node's own update never
      // lands — see lib/graph/copilot.ts's file header), so this recovers it
      // the same way the pre-port route's catch block read its in-memory
      // `trace` variable.
      let invokeResult: Awaited<ReturnType<typeof invokeGraphForUser>>
      try {
        invokeResult = await invokeGraphForUser({
          admin,
          userId: user.id,
          surface: 'copilot',
          graph: COPILOT_GRAPH,
          threadId: threadIdForInvoke,
          input: graphInput,
          resume: graphResume,
          streamHandler,
          signal: request.signal,
          extraConfigurable: { conversationId: conversation.id },
        })
      } catch (e) {
        const aborted = request.signal.aborted || (e instanceof Error && e.name === 'AbortError')
        let trace: TraceEntry[] = []
        try {
          const tid = threadIdForInvoke ?? conversation.thread_id
          if (tid) {
            const snap = await getGraphStateForUser(admin, user.id, tid, COPILOT_GRAPH)
            const snapTrace = (snap.values as Record<string, unknown>).trace
            trace = Array.isArray(snapTrace) ? (snapTrace as TraceEntry[]) : []
          }
        } catch {
          // Best-effort recovery only — an unreadable checkpoint still falls
          // through to the deterministic/aborted message below.
        }
        const message = trace.length > 0 ? fallbackSummary(trace) : aborted ? 'Stopped.' : `Copilot error: ${errMsg(e)}`
        await persistTurn(message, trace)
        const asFinal = trace.length > 0 || aborted
        send({ type: asFinal ? 'final' : 'error', ...(asFinal ? { message } : { error: message }) })
        return finish()
      }

      if (capturedFinal) {
        const final = capturedFinal as { message: string; trace: TraceEntry[] }
        send({ type: 'final', message: final.message })
        await persistTurn(final.message, final.trace)
        return finish()
      }

      // The run ended on an interrupt (paused/question) instead of a final
      // answer — translate it and stop. Spec item 3: persist NOTHING as a
      // sentinel; the checkpoint already holds the pending action.
      const interruptValue = extractInterruptValue(invokeResult.result)
      const wireEvent = translateInterruptToWireEvent(interruptValue)
      if (wireEvent) send(wireEvent)
      return finish()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const { searchParams } = new URL(request.url)

  try {
    if (searchParams.get('list') === '1') {
      const conversations = await listConversations(admin, user.id)
      return NextResponse.json({ conversations })
    }

    const conversationId = searchParams.get('conversationId')
    if (conversationId) {
      const conversation = await getConversation(admin, user.id, conversationId)
      if (!conversation) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
      const messages = await loadRecentMessages(admin, conversationId, 200)
      return NextResponse.json({
        conversation: {
          id: conversation.id,
          title: conversation.title,
          model: conversation.model,
          enabled_agents: conversation.enabled_agents,
          bypass_mode: Boolean(conversation.bypass_mode),
        },
        // Only PRE-PORT paused-tool sentinel rows are hidden here (nothing
        // writes new ones — see this file's header); an ask sentinel from
        // that era stays visible so a reload shows both the question and,
        // once given, the answer.
        messages: messages
          .filter((m) => !isPausedSentinel(m))
          .map((m) => ({ role: m.role, content: m.content, trace: m.trace, created_at: m.created_at, id: m.id })),
      })
    }

    return NextResponse.json({ error: 'list=1 or conversationId is required' }, { status: 400 })
  } catch (e) {
    return NextResponse.json({ error: errMsg(e) }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const { searchParams } = new URL(request.url)
  const conversationId = searchParams.get('conversationId')
  if (!conversationId) return NextResponse.json({ error: 'conversationId is required' }, { status: 400 })

  try {
    await deleteConversation(admin, user.id, conversationId)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: errMsg(e) }, { status: 500 })
  }
}
