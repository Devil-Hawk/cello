// Integration test: the copilot StateGraph driven THROUGH
// lib/graph/invoke.ts#invokeGraphForUser (and its getGraphStateForUser
// companion), across MULTIPLE SEPARATE invokeGraphForUser calls — the same
// technique invoke.langgraph.test.ts uses to prove invoke.ts's checkpointer
// wiring against a REAL @langchain/langgraph runtime (a real StateGraph, a
// real MemorySaver reused across calls to simulate cross-request checkpoint
// persistence) rather than the fully-mocked graph invoke.test.ts uses. This
// is the closest this repo's test suite gets to the spec's "SSE wire proof"
// without a real Supabase connection and a running HTTP server (see this
// file's own test report note on why that step could not run — the linked
// Supabase project has none of the 20260817xxxxxx migrations applied, so
// there is no langgraph schema / graph_threads table to point pnpm dev at).
//
// './pg' is mocked (no network, no Postgres) exactly like
// invoke.langgraph.test.ts; callLlm/loadApiKeys/dispatchTool/
// mcpToolsPromptBlock are mocked exactly like copilot.test.ts. Everything
// else — invoke.ts's ownership checks, config.configurable injection,
// resume-vs-input rules, and copilot.ts's whole node graph including its
// interrupt()/Command(resume) mechanics — is REAL.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemorySaver } from '@langchain/langgraph'
import type { AdminClient } from '../harness/types'
import type { TraceEntry } from './copilot'

const checkpointerHolder = vi.hoisted<{ saver: unknown }>(() => ({ saver: null }))
vi.mock('./pg', () => ({
  withCheckpointer: async (fn: (saver: unknown) => Promise<unknown>) => fn(checkpointerHolder.saver),
}))

const callLlmMock = vi.fn()
vi.mock('../harness/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../harness/llm')>()
  return { ...actual, callLlm: (...args: unknown[]) => callLlmMock(...args) }
})

const loadApiKeysMock = vi.fn(async (..._args: unknown[]) => ({ userId: 'user-owner' }) as never)
vi.mock('../harness/keys', async (importOriginal) => {
  // invoke.ts's own demoExpiryForFreshThread also reaches into this module
  // (readProfileForDemoGuards) — keep everything real except loadApiKeys.
  const actual = await importOriginal<typeof import('../harness/keys')>()
  return { ...actual, loadApiKeys: (...args: unknown[]) => loadApiKeysMock(...args) }
})

// copilot.ts's nodes build their OWN admin client fresh (mirrors
// lib/graph/unit.ts's philosophy — see that file's header) rather than
// receiving one through config.configurable; this test's fake admin is
// installed here so those internal calls resolve to the SAME fake table
// used everywhere else in this file.
let sharedFakeAdmin: AdminClient
vi.mock('../harness/supabase-admin', () => ({
  createAdminClient: () => sharedFakeAdmin,
}))

const dispatchToolMock = vi.fn(async (..._args: unknown[]) => ({ ok: true, result: 'done' }))
vi.mock('../harness/copilot-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../harness/copilot-tools')>()
  return {
    ...actual,
    dispatchTool: (...args: unknown[]) => dispatchToolMock(...args),
    mcpToolsPromptBlock: async () => '',
  }
})

const { invokeGraphForUser, getGraphStateForUser } = await import('./invoke')
const { copilotGraph } = await import('./copilot')
// Same cast app/api/copilot/route.ts uses — see its own comment on why a
// real compiled StateGraph's `.invoke` input type is narrower than
// CompiledGraphLike's `unknown`.
const COPILOT_GRAPH = copilotGraph as unknown as import('./invoke').CompiledGraphLike

// --- fake admin: graph_threads (invoke.ts) + profiles/copilot_conversations (copilot.ts's beginTurn) ---

interface Row extends Record<string, unknown> {}

/** Stateful fake for copilot_messages — real enough to exercise
 *  loadRecentMessages/appendMessage's own query shapes, since Step 7's
 *  turn-assembly rework makes beginTurn read cross-turn history back out of
 *  this table instead of the checkpoint's own `state.messages`. Exposed on
 *  the returned admin so a test can call `insertMessage` to simulate what
 *  app/api/copilot/route.ts's own appendMessage would have done between two
 *  invokeGraphForUser calls (this test drives the graph directly, never
 *  route.ts, so nothing else populates it). */
function makeFakeAdmin() {
  const graphThreadRows: Row[] = []
  const messageRows: Row[] = []
  let messageSeq = 0
  let seq = 0
  const insertMessage = (conversationId: string, role: 'user' | 'assistant', content: string) => {
    messageSeq += 1
    messageRows.push({
      id: `m${messageSeq}`,
      conversation_id: conversationId,
      role,
      content,
      trace: null,
      created_at: new Date(messageSeq * 1000).toISOString(),
    })
  }
  const admin = {
    insertMessage,
    from: (name: string) => {
      if (name === 'profiles') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }
      }
      if (name === 'copilot_conversations') {
        // beginTurn's idempotent thread-link write, PLUS assembleTurnContext's
        // summary read and refreshConversationSummary's own read/write — a
        // no-op/empty result is all this test needs (no real conversation row
        // backs it).
        return {
          update: () => ({ eq: () => ({ is: async () => ({ data: null, error: null }), then: (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(res) }) }),
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        }
      }
      if (name === 'copilot_messages') {
        // assembleTurnContext/refreshConversationSummary's loadRecentMessages
        // read — served from messageRows, populated by insertMessage() (see
        // this function's own header) wherever a test needs cross-turn
        // history to actually be there.
        return {
          select: () => ({
            eq: (_col: string, conversationId: string) => ({
              order: () => ({
                limit: async (n: number) => ({
                  data: messageRows
                    .filter((r) => r.conversation_id === conversationId)
                    .slice()
                    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
                    .slice(0, n),
                  error: null,
                }),
              }),
            }),
          }),
        }
      }
      if (name === 'insights') {
        // beginTurn's lib/insights/store.ts#readStandingPreferences read — no
        // insights back this test's user, so an empty result is all it needs.
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () => chain,
          then: (resolve: (v: { data: []; error: null }) => void) => resolve({ data: [], error: null }),
        }
        return chain
      }
      if (name !== 'graph_threads') throw new Error(`fake admin: unhandled table "${name}"`)
      const filters: { col: string; val: unknown }[] = []
      let mode: 'select' | 'insert' | 'update' = 'select'
      let patch: Record<string, unknown> | null = null
      let insertRow: Record<string, unknown> | null = null
      const exec = () => {
        if (mode === 'insert') {
          seq += 1
          const row: Row = { thread_id: `thread-${seq}`, expires_at: null, run_id: null, conversation_id: null, ...insertRow }
          graphThreadRows.push(row)
          return { data: row, error: null }
        }
        const matched = graphThreadRows.filter((r) => filters.every(({ col, val }) => r[col] === val))
        if (mode === 'update') {
          for (const r of matched) Object.assign(r, patch)
          return { data: matched, error: null }
        }
        return { data: matched, error: null }
      }
      const builder = {
        select: (_c?: string) => builder,
        eq: (col: string, val: unknown) => {
          filters.push({ col, val })
          return builder
        },
        insert: (row: Record<string, unknown>) => {
          mode = 'insert'
          insertRow = row
          return builder
        },
        update: (p: Record<string, unknown>) => {
          mode = 'update'
          patch = p
          return builder
        },
        maybeSingle: async () => {
          const { data, error } = exec()
          return { data: (Array.isArray(data) ? data[0] : data) ?? null, error }
        },
        single: async () => {
          const { data, error } = exec()
          return { data: (Array.isArray(data) ? data[0] : data) ?? null, error }
        },
        then: (res?: (v: unknown) => unknown, rej?: (r: unknown) => unknown) => Promise.resolve(exec()).then(res, rej),
      }
      return builder
    },
  } as unknown as AdminClient & { insertMessage: typeof insertMessage }
  return admin
}

function llmAction(content: unknown) {
  return { content: JSON.stringify(content), tokensUsed: 10, promptTokens: 5, completionTokens: 5, model: 'x' }
}

const OWNER = 'user-owner'
const turnConfig: import('./copilot').CopilotTurnConfig = {
  thinkingMode: 'auto',
  effort: 'high',
  bypassMode: false,
  userEmail: 'a@b.com',
  isDemo: false,
}

describe('copilot graph through invokeGraphForUser, across separate requests sharing one thread (real LangGraph runtime + real MemorySaver)', () => {
  let admin: ReturnType<typeof makeFakeAdmin>

  beforeEach(() => {
    admin = makeFakeAdmin()
    sharedFakeAdmin = admin
    checkpointerHolder.saver = new MemorySaver()
    callLlmMock.mockReset()
    dispatchToolMock.mockClear()
  })

  it('mints a thread, pauses on a guarded tool call, stays paused across getGraphStateForUser, resumes and executes, then parks at next_turn — and a later plain message continues the SAME thread', async () => {
    // --- Request 1: fresh thread, model wants to submit an application. ---
    callLlmMock.mockResolvedValueOnce(
      llmAction({ action: 'tool', tool: 'trigger_run', args: { goal: 'submit application to Acme' }, thought: 'apply now' })
    )
    const r1 = await invokeGraphForUser({
      admin,
      userId: OWNER,
      surface: 'copilot',
      graph: COPILOT_GRAPH,
      input: { pendingIncomingMessage: 'apply to Acme for me', turnConfig },
      extraConfigurable: { conversationId: 'c1' },
    })
    expect(dispatchToolMock).not.toHaveBeenCalled()
    const interrupt1 = (r1.result as { __interrupt__?: { value?: { kind?: string; tool?: string } }[] }).__interrupt__
    expect(interrupt1?.[0]?.value?.kind).toBe('confirm')
    expect(interrupt1?.[0]?.value?.tool).toBe('trigger_run')
    const threadId = r1.threadId

    // --- Between requests: a fresh read confirms the SAME pause, without invoking anything. ---
    const snapPaused = await getGraphStateForUser(admin, OWNER, threadId, COPILOT_GRAPH)
    expect((snapPaused.pendingInterrupt as { kind?: string } | null)?.kind).toBe('confirm')

    // --- Request 2: the user confirms. dispatchExecute resumes, calls the
    // real tool dispatch, then loops back to plan for a follow-up answer. ---
    callLlmMock.mockResolvedValueOnce(llmAction({ action: 'final', message: 'Submitted your application to Acme.' }))
    const r2 = await invokeGraphForUser({
      admin,
      userId: OWNER,
      surface: 'copilot',
      graph: COPILOT_GRAPH,
      threadId,
      resume: { approved: true, confirmed: true },
      extraConfigurable: { conversationId: 'c1' },
    })
    expect(dispatchToolMock).toHaveBeenCalledTimes(1)
    expect(dispatchToolMock).toHaveBeenCalledWith(expect.anything(), 'trigger_run', { goal: 'submit application to Acme' })
    const interrupt2 = (r2.result as { __interrupt__?: { value?: { kind?: string } }[] }).__interrupt__
    expect(interrupt2?.[0]?.value?.kind).toBe('next_turn')

    // --- Between requests again: confirms the thread parked at next_turn, not still at confirm. ---
    const snapDone = await getGraphStateForUser(admin, OWNER, threadId, COPILOT_GRAPH)
    expect((snapDone.pendingInterrupt as { kind?: string } | null)?.kind).toBe('next_turn')

    // --- Request 3: a genuinely NEW turn on the SAME thread — invoke.ts
    // refuses fresh `input` here (ExistingThreadCheckpointError), so this
    // MUST travel as a `message` resume, exactly like the route builds it. ---
    callLlmMock.mockResolvedValueOnce(llmAction({ action: 'final', message: 'Nothing new to report.' }))
    const r3 = await invokeGraphForUser({
      admin,
      userId: OWNER,
      surface: 'copilot',
      graph: COPILOT_GRAPH,
      threadId,
      resume: { kind: 'message', message: 'anything new?', turnConfig },
      extraConfigurable: { conversationId: 'c1' },
    })
    // dispatchTool was NOT called again — this turn never called a tool.
    expect(dispatchToolMock).toHaveBeenCalledTimes(1)
    const interrupt3 = (r3.result as { __interrupt__?: { value?: { kind?: string } }[] }).__interrupt__
    expect(interrupt3?.[0]?.value?.kind).toBe('next_turn')
    // The new turn's objective made it into the model's context — this is
    // callLlmMock's THIRD call overall (request 1's tool-planning call,
    // request 2's post-tool final-answer call, then this one).
    expect(callLlmMock).toHaveBeenCalledTimes(3)
    const thirdCallArgs = callLlmMock.mock.calls[2][1] as { messages: { role: string; content: string }[] }
    expect(thirdCallArgs.messages.some((m) => m.content === 'anything new?')).toBe(true)
  })

  it('a crash strictly after dispatchTool fires but before dispatchExecute returns never silently re-fires an approved guarded call on the next continuation — every later attempt fails loudly instead', async () => {
    // --- Request 1: fresh thread, model wants to submit an application. ---
    callLlmMock.mockResolvedValueOnce(
      llmAction({ action: 'tool', tool: 'trigger_run', args: { goal: 'submit application to Acme' }, thought: 'apply now' })
    )
    const r1 = await invokeGraphForUser({
      admin,
      userId: OWNER,
      surface: 'copilot',
      graph: COPILOT_GRAPH,
      input: { pendingIncomingMessage: 'apply to Acme for me', turnConfig },
      extraConfigurable: { conversationId: 'c3' },
    })
    const threadId = r1.threadId
    expect(((r1.result as { __interrupt__?: { value?: { kind?: string } }[] }).__interrupt__)?.[0]?.value?.kind).toBe('confirm')

    // --- Request 2: user confirms. dispatchTool fires once, then the WHOLE
    // request fails (simulating a kill strictly between the real side effect
    // resolving and dispatchExecute's own return committing to the
    // checkpoint — a timeout, a serverless eviction, an OOM). No automatic
    // LangGraph task retry happens (NO_RETRY on every node — see the
    // graph's own comment): exactly one dispatchTool call, one rejection. ---
    dispatchToolMock.mockImplementationOnce(async () => {
      throw new Error('simulated crash after the real side effect fired')
    })
    await expect(
      invokeGraphForUser({
        admin,
        userId: OWNER,
        surface: 'copilot',
        graph: COPILOT_GRAPH,
        threadId,
        resume: { approved: true, confirmed: true },
        extraConfigurable: { conversationId: 'c3' },
      })
    ).rejects.toThrow('simulated crash after the real side effect fired')
    expect(dispatchToolMock).toHaveBeenCalledTimes(1)

    // --- Request 3: an ordinary continuation (invoke.ts's `{kind:'continue'}`
    // / invoke(null, cfg), no resume value at all). dispatchExecute's task
    // is still genuinely queued (next=['dispatchExecute']), so this DOES
    // re-enter it — replaying the ALREADY-CONSUMED confirm interrupt
    // harmlessly (same {approved:true,confirmed:true} value LangGraph keeps
    // durably available for it). But `pending_dispatch` shows a claim for
    // this exact step already exists — proven empirically that a SECOND
    // interrupt() call here could ALSO be silently satisfied by that same
    // stale value (LangGraph's "null resume" isn't consumed by a failed
    // attempt), so dispatchExecute deliberately never calls interrupt()
    // again: it ends the task with an honest "not confirmed" trace entry
    // instead. dispatchTool is NEVER called a second time. ---
    callLlmMock.mockResolvedValueOnce(llmAction({ action: 'final', message: 'I could not confirm the earlier submission went through, so I did not repeat it. Let me know if you want me to try again.' }))
    const r3 = await invokeGraphForUser({
      admin,
      userId: OWNER,
      surface: 'copilot',
      graph: COPILOT_GRAPH,
      threadId,
      extraConfigurable: { conversationId: 'c3' },
    })
    expect(dispatchToolMock).toHaveBeenCalledTimes(1)
    const i3 = (r3.result as { __interrupt__?: { value?: { kind?: string } }[] }).__interrupt__
    expect(i3?.[0]?.value?.kind).toBe('next_turn')
    const trace3 = (r3.result as { trace?: TraceEntry[] }).trace
    expect(trace3?.some((t) => t.tool === 'trigger_run' && t.status === 'error' && /previous attempt/i.test(String((t.observation as { error?: string }).error)))).toBe(true)

    // --- Request 4: only a genuinely FRESH, explicit user message can move
    // this thread forward from here — a stale {approved,confirmed} resume
    // has nothing left to attach to (the task completed in Request 3). ---
    callLlmMock.mockResolvedValueOnce(llmAction({ action: 'final', message: 'Understood, not resubmitting.' }))
    const r4 = await invokeGraphForUser({
      admin,
      userId: OWNER,
      surface: 'copilot',
      graph: COPILOT_GRAPH,
      threadId,
      resume: { kind: 'message', message: 'ok, leave it', turnConfig },
      extraConfigurable: { conversationId: 'c3' },
    })
    expect(dispatchToolMock).toHaveBeenCalledTimes(1)
    const i4 = (r4.result as { __interrupt__?: { value?: { kind?: string } }[] }).__interrupt__
    expect(i4?.[0]?.value?.kind).toBe('next_turn')
  })

  it("beginTurn reads turn 1's answer back from copilot_messages — the next turn's plan call sees it", async () => {
    // Step 7's turn-assembly rework moved cross-turn model memory OUT of the
    // checkpoint's own `state.messages` and into copilot_messages
    // (assembleTurnContext's loadRecentMessages read) — app/api/copilot/
    // route.ts is what populates that table (appendMessage, before/after
    // each invokeGraphForUser call); this test drives the graph directly, so
    // it has to do that populating itself, exactly where route.ts would.

    // --- Turn 1: a plain question, answered directly. ---
    admin.insertMessage('c4', 'user', 'what is the answer?')
    callLlmMock.mockResolvedValueOnce(llmAction({ action: 'final', message: 'The answer to turn 1 is 42.' }))
    const r1 = await invokeGraphForUser({
      admin,
      userId: OWNER,
      surface: 'copilot',
      graph: COPILOT_GRAPH,
      input: { pendingIncomingMessage: 'what is the answer?', turnConfig },
      extraConfigurable: { conversationId: 'c4' },
    })
    const threadId = r1.threadId
    admin.insertMessage('c4', 'assistant', 'The answer to turn 1 is 42.')

    // --- Turn 2: a genuinely new turn on the SAME thread. Its plan call
    // must see turn 1's ASSISTANT answer in context, not just the two user
    // messages — that's what assembleTurnContext's loadRecentMessages read
    // exists for. ---
    admin.insertMessage('c4', 'user', 'and after that?')
    callLlmMock.mockResolvedValueOnce(llmAction({ action: 'final', message: 'Following up.' }))
    await invokeGraphForUser({
      admin,
      userId: OWNER,
      surface: 'copilot',
      graph: COPILOT_GRAPH,
      threadId,
      resume: { kind: 'message', message: 'and after that?', turnConfig },
      extraConfigurable: { conversationId: 'c4' },
    })
    expect(callLlmMock).toHaveBeenCalledTimes(2)
    const secondCallArgs = callLlmMock.mock.calls[1][1] as { messages: { role: string; content: string }[] }
    expect(secondCallArgs.messages.some((m) => m.role === 'assistant' && m.content === 'The answer to turn 1 is 42.')).toBe(true)
  })

  it('a genuine plan() crash on a fresh next_turn tick leaves next=[\'plan\'] (task still pending, unlike the dispatchExecute case above) — the CONTINUE recovery path this makes possible is exercised by app/api/copilot/route.ts, not tested again here', async () => {
    // This is the scenario lib/graph/copilot.ts#buildInputOrResume's
    // `midFlight` branch exists for (see its doc): a task that fails on a
    // fresh attempt, never having consumed a resume itself, leaves the
    // checkpoint's `next` genuinely populated — the opposite of the
    // dispatchExecute-after-effect case above, and recoverable via a plain
    // `invoke(null, cfg)` continuation instead of a hard refusal.
    callLlmMock.mockResolvedValueOnce(llmAction({ action: 'final', message: 'turn 1 done' }))
    const r1 = await invokeGraphForUser({
      admin,
      userId: OWNER,
      surface: 'copilot',
      graph: COPILOT_GRAPH,
      input: { pendingIncomingMessage: 'hello', turnConfig },
      extraConfigurable: { conversationId: 'c9' },
    })
    const threadId = r1.threadId
    callLlmMock.mockImplementationOnce(async () => {
      throw new Error('simulated LLM outage')
    })
    await expect(
      invokeGraphForUser({
        admin,
        userId: OWNER,
        surface: 'copilot',
        graph: COPILOT_GRAPH,
        threadId,
        resume: { kind: 'message', message: 'research Beta Corp please', turnConfig },
        extraConfigurable: { conversationId: 'c9' },
      })
    ).rejects.toThrow('simulated LLM outage')
    const snap = await getGraphStateForUser(admin, OWNER, threadId, COPILOT_GRAPH)
    expect(snap.next).toEqual(['plan'])
    expect(snap.pendingInterrupt).toBeNull()

    // A bare continuation recovers it — plan() re-runs (task genuinely still
    // pending), no restart from START, no error.
    callLlmMock.mockResolvedValueOnce(llmAction({ action: 'final', message: 'recovered' }))
    const r2 = await invokeGraphForUser({
      admin,
      userId: OWNER,
      surface: 'copilot',
      graph: COPILOT_GRAPH,
      threadId,
      extraConfigurable: { conversationId: 'c9' },
    })
    const i2 = (r2.result as { __interrupt__?: { value?: { kind?: string } }[] }).__interrupt__
    expect(i2?.[0]?.value?.kind).toBe('next_turn')
  })

  it('refuses fresh input on a thread that already has a checkpoint (invoke.ts ExistingThreadCheckpointError) — proves invoke.ts really is gating copilot, not just other surfaces', async () => {
    callLlmMock.mockResolvedValueOnce(llmAction({ action: 'final', message: 'ok' }))
    const r1 = await invokeGraphForUser({
      admin,
      userId: OWNER,
      surface: 'copilot',
      graph: COPILOT_GRAPH,
      input: { pendingIncomingMessage: 'hi', turnConfig },
      extraConfigurable: { conversationId: 'c2' },
    })
    await expect(
      invokeGraphForUser({
        admin,
        userId: OWNER,
        surface: 'copilot',
        graph: COPILOT_GRAPH,
        threadId: r1.threadId,
        input: { pendingIncomingMessage: 'a second fresh message', turnConfig },
        extraConfigurable: { conversationId: 'c2' },
      })
    ).rejects.toThrow(/already has a checkpoint/)
  })
})
