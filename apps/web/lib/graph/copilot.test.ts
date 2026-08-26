// Tests for lib/graph/copilot.ts — the copilot StateGraph.
//
// Two kinds of coverage, per the LangGraph-port build brief's Step 8.5 (a
// third, the graph-shape source assertion proving dispatchExecute calls
// submitOrSendReason unconditionally before dispatchTool, moved to
// lib/evals/graph-shape.test.ts — Step 8's consolidation of invariant 6's
// graph-shape regression tests into one file; it was a pure source scan with
// no dependency on the mocks below):
//   (b) runtime: bypassMode:true with a send/submit-shaped tool call still
//       raises interrupt({kind:'confirm'}) — dispatchTool is a spy and is
//       asserted NEVER called. Proves the SAME invariant the moved (a) block
//       proves by construction, but by actually driving the compiled graph.
//   (c) the resume matrix (lib/graph/copilot.ts#buildInputOrResume) — a pure
//       function, so every branch is a plain unit test, no mocking at all.
//
// (b) drives the REAL compiled copilotGraph directly with a MemorySaver
// (bypassing lib/graph/invoke.ts entirely — that file's own plumbing is
// covered by invoke.test.ts/invoke.langgraph.test.ts; this file only needs
// to prove the GRAPH's own node behavior). callLlm/loadApiKeys/dispatchTool/
// mcpToolsPromptBlock are mocked so this exercises copilot.ts's own control
// flow, never a real model or database.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemorySaver } from '@langchain/langgraph'

// --- mocks (declared before importing ./copilot, per vitest hoisting) -----

const callLlmMock = vi.fn()
vi.mock('../harness/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../harness/llm')>()
  return { ...actual, callLlm: (...args: unknown[]) => callLlmMock(...args) }
})

const loadApiKeysMock = vi.fn(async (..._args: unknown[]) => ({ userId: 'u1' }) as never)
vi.mock('../harness/keys', () => ({
  loadApiKeys: (...args: unknown[]) => loadApiKeysMock(...args),
}))

/** Bare-minimum fake AdminClient: only the chains beginTurn actually runs
 *  (the insights standing-preferences read, the profiles preferences read,
 *  the thread-link update). Everything else copilot.ts touches (dispatchTool,
 *  mcpToolsPromptBlock) is mocked below and never sees this admin at all. */
function makeFakeAdmin() {
  const from = vi.fn((_table: string) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      update: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: (v: { data: []; error: null }) => void) => resolve({ data: [], error: null }),
    }
    return chain
  })
  return { from } as unknown as import('../harness/types').AdminClient
}
const fakeAdmin = makeFakeAdmin()
vi.mock('../harness/supabase-admin', () => ({
  createAdminClient: () => fakeAdmin,
}))

const dispatchToolMock = vi.fn(async (..._args: unknown[]) => ({ ok: true }))
vi.mock('../harness/copilot-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../harness/copilot-tools')>()
  return {
    ...actual,
    dispatchTool: (...args: unknown[]) => dispatchToolMock(...args),
    mcpToolsPromptBlock: async () => '',
  }
})

const { copilotGraph, buildInputOrResume, systemPrompt } = await import('./copilot')
type CopilotTurnConfigT = import('./copilot').CopilotTurnConfig

// Real LangGraph internal — pinned identically to lib/graph/invoke.ts's own
// PREGEL_CHECKPOINTER_KEY (not re-exported from that file's public surface;
// see its doc comment for why this is a literal, not an import).
const PREGEL_CHECKPOINTER_KEY = '__pregel_checkpointer'

function baseTurnConfig(overrides: Partial<CopilotTurnConfigT> = {}): CopilotTurnConfigT {
  return { thinkingMode: 'auto', effort: 'high', bypassMode: false, userEmail: 'a@b.com', ...overrides } as CopilotTurnConfigT
}

function graphConfig(threadId: string, saver: MemorySaver) {
  return {
    configurable: {
      thread_id: threadId,
      threadId,
      userId: 'u1',
      runId: `run-${threadId}`,
      conversationId: 'c1',
      [PREGEL_CHECKPOINTER_KEY]: saver,
    },
  }
}

beforeEach(() => {
  callLlmMock.mockReset()
  loadApiKeysMock.mockClear()
  dispatchToolMock.mockClear()
})

function llmAction(content: unknown, reasoning?: string) {
  return { content: JSON.stringify(content), tokensUsed: 10, promptTokens: 5, completionTokens: 5, model: 'x', reasoning }
}

// ---------------------------------------------------------------------------
// (a) graph-shape source assertion + mutation check — MOVED to
// lib/evals/graph-shape.test.ts (Step 8 of the langgraph port: consolidating
// invariant 6's graph-shape regression tests into one file). It was a pure
// source-text scan with no dependency on this file's mocks; see that file's
// own header for why it sits there now instead of here. (b) below is the
// runtime half of the same proof and stays here — it needs this file's
// whole mock/compiled-graph harness.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// (b) runtime: bypassMode can never skip the submit/send guard
// ---------------------------------------------------------------------------

describe('bypassMode never skips the unconditional submit/send guard (runtime)', () => {
  it('a send/submit-shaped tool call raises interrupt({kind:"confirm"}) even with bypassMode:true, and dispatchTool is never called', async () => {
    callLlmMock.mockResolvedValueOnce(
      llmAction({ action: 'tool', tool: 'trigger_run', args: { goal: 'submit application to Acme' }, thought: 'go do it' })
    )

    const saver = new MemorySaver()
    const config = graphConfig('thread-bypass-1', saver)
    const result = await copilotGraph.invoke(
      { pendingIncomingMessage: 'apply to Acme for me', turnConfig: baseTurnConfig({ bypassMode: true }) },
      config
    )

    expect(dispatchToolMock).not.toHaveBeenCalled()
    const r = result as { __interrupt__?: { value?: { kind?: string; tool?: string } }[] }
    expect(r.__interrupt__).toBeTruthy()
    expect(r.__interrupt__?.[0]?.value?.kind).toBe('confirm')
    expect(r.__interrupt__?.[0]?.value?.tool).toBe('trigger_run')
  })

  it('the same tool call WITHOUT a submit-shaped goal, with bypassMode:true, skips straight to dispatchTool (no confirm/review pause)', async () => {
    // Two planning calls: the tool call itself, then the model's follow-up
    // final answer — dispatchExecute always loops back to plan after a real
    // dispatchTool call, exactly like the pre-port route's loop did.
    callLlmMock
      .mockResolvedValueOnce(llmAction({ action: 'tool', tool: 'list_jobs', args: {}, thought: 'look up jobs' }))
      .mockResolvedValueOnce(llmAction({ action: 'final', message: 'here are your jobs' }))
    const saver = new MemorySaver()
    const config = graphConfig('thread-bypass-2', saver)
    const result = await copilotGraph.invoke(
      { pendingIncomingMessage: 'what jobs do I have', turnConfig: baseTurnConfig({ bypassMode: true }) },
      config
    )
    // The turn ends organically at the between-turn next_turn interrupt
    // (see lib/graph/copilot.ts's file header) — that is NOT a confirm/
    // review pause, so it must never carry {kind:'confirm'|'review'}.
    const r = result as { __interrupt__?: { value?: { kind?: string } }[] }
    expect(r.__interrupt__?.[0]?.value?.kind).toBe('next_turn')
    expect(dispatchToolMock).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// (c) resume matrix — pure function, every branch
// ---------------------------------------------------------------------------

describe('buildInputOrResume — the resume matrix (spec item 2)', () => {
  const turnConfig = baseTurnConfig()

  it('no thread yet -> fresh input, regardless of isResume', () => {
    const r = buildInputOrResume({ hasThread: false, isResume: false, midFlight: false, pendingKind: null, confirmToolCall: false, resumeDirective: undefined, messageIn: 'hello', turnConfig })
    expect(r).toEqual({ kind: 'input', input: { pendingIncomingMessage: 'hello', turnConfig } })
  })

  it('mid-flight (killed before any interrupt) -> {kind:"continue"}, regardless of isResume — nothing to attach a resume value to', () => {
    const resuming = buildInputOrResume({ hasThread: true, isResume: true, midFlight: true, pendingKind: null, confirmToolCall: true, resumeDirective: '', messageIn: '', turnConfig })
    expect(resuming).toEqual({ kind: 'continue' })
    const plain = buildInputOrResume({ hasThread: true, isResume: false, midFlight: true, pendingKind: null, confirmToolCall: false, resumeDirective: undefined, messageIn: 'hi again', turnConfig })
    expect(plain).toEqual({ kind: 'continue' })
  })

  it('pending confirm/review, empty directive -> {approved:true} (dispatchExecute itself turns this into "not confirmed" when guarded)', () => {
    const r = buildInputOrResume({ hasThread: true, isResume: true, midFlight: false, pendingKind: 'confirm', confirmToolCall: false, resumeDirective: '', messageIn: '', turnConfig })
    expect(r).toEqual({ kind: 'resume', resume: { approved: true } })
  })

  it('pending confirm/review, confirmToolCall:true -> {approved:true,confirmed:true}', () => {
    const r = buildInputOrResume({ hasThread: true, isResume: true, midFlight: false, pendingKind: 'confirm', confirmToolCall: true, resumeDirective: '', messageIn: '', turnConfig })
    expect(r).toEqual({ kind: 'resume', resume: { approved: true, confirmed: true } })
  })

  it('pending confirm/review, non-empty directive -> {approved:false,directive} (drop the call, replan)', () => {
    const r = buildInputOrResume({ hasThread: true, isResume: true, midFlight: false, pendingKind: 'review', confirmToolCall: false, resumeDirective: 'do X instead', messageIn: '', turnConfig })
    expect(r).toEqual({ kind: 'resume', resume: { approved: false, directive: 'do X instead' } })
  })

  it('pending ask/ask_form -> {answer}', () => {
    const r = buildInputOrResume({ hasThread: true, isResume: true, midFlight: false, pendingKind: 'ask', confirmToolCall: false, resumeDirective: 'the blue one', messageIn: '', turnConfig })
    expect(r).toEqual({ kind: 'resume', resume: { answer: 'the blue one' } })
  })

  it('pending ask_form -> {answer} too, empty directive becomes ""', () => {
    const r = buildInputOrResume({ hasThread: true, isResume: true, midFlight: false, pendingKind: 'ask_form', confirmToolCall: false, resumeDirective: '', messageIn: '', turnConfig })
    expect(r).toEqual({ kind: 'resume', resume: { answer: '' } })
  })

  it('isResume with nothing genuinely pending (next_turn) -> stray directive folded in as a message', () => {
    const r = buildInputOrResume({ hasThread: true, isResume: true, midFlight: false, pendingKind: 'next_turn', confirmToolCall: false, resumeDirective: 'continue please', messageIn: '', turnConfig })
    expect(r).toEqual({ kind: 'resume', resume: { kind: 'message', message: 'continue please', turnConfig } })
  })

  it('plain new message (not resuming) on an existing thread -> {kind:"message"}, covers both the ordinary next-turn case and abandoning a pending pause', () => {
    const r = buildInputOrResume({ hasThread: true, isResume: false, midFlight: false, pendingKind: 'confirm', confirmToolCall: false, resumeDirective: undefined, messageIn: 'never mind, do Y', turnConfig })
    expect(r).toEqual({ kind: 'resume', resume: { kind: 'message', message: 'never mind, do Y', turnConfig } })
  })
})

// ---------------------------------------------------------------------------
// (e) systemPrompt — parity for the surviving blocks + the two new ones
//     (langgraph port step 9: buildTurnContext replaced the ad-hoc
//     mcpToolsPromptBlock/readStandingPreferences/formatActiveGoalBlock(
//     readGoals(...)) trio with one call, adding kbBlock/entityBlock)
// ---------------------------------------------------------------------------

describe('systemPrompt — every block renders when present, none when blank', () => {
  it('every surviving block (mcp/standing/goals/summary/memory) plus the two new ones (kb/entity) appear verbatim', () => {
    const sys = systemPrompt(
      undefined,
      'MCP_BLOCK_MARKER',
      'STANDING_BLOCK_MARKER',
      'GOALS_BLOCK_MARKER',
      'SUMMARY_BLOCK_MARKER',
      'MEMORY_BLOCK_MARKER',
      'KB_BLOCK_MARKER',
      'ENTITY_BLOCK_MARKER'
    )
    expect(sys).toContain('MCP_BLOCK_MARKER')
    expect(sys).toContain('STANDING_BLOCK_MARKER')
    expect(sys).toContain('GOALS_BLOCK_MARKER')
    expect(sys).toContain('SUMMARY_BLOCK_MARKER')
    expect(sys).toContain('MEMORY_BLOCK_MARKER')
    expect(sys).toContain('KB_BLOCK_MARKER')
    expect(sys).toContain('ENTITY_BLOCK_MARKER')
  })

  it('an empty block contributes nothing — no stray marker text for a block nobody had anything to say', () => {
    const sys = systemPrompt(undefined, '', '', '', '', '', '', '')
    expect(sys).not.toContain('undefined')
    expect(sys).not.toContain('null')
  })
})

// ---------------------------------------------------------------------------
// (d) ask_form wire field is `detail`, not the parsed `description`
// ---------------------------------------------------------------------------

describe('dispatch: ask_form maps option.description to wire field "detail"', () => {
  it('an option with a description surfaces as {label, detail} in the interrupt value, never {label, description}', async () => {
    callLlmMock.mockResolvedValueOnce(
      llmAction({
        action: 'ask',
        thought: 'need to disambiguate',
        questions: [
          {
            header: 'Roles',
            question: 'Which roles?',
            multiSelect: true,
            options: [
              { label: 'Backend', description: 'server-side roles' },
              { label: 'Infra' },
            ],
          },
        ],
      })
    )
    const saver = new MemorySaver()
    const config = graphConfig('thread-ask-form-1', saver)
    const result = await copilotGraph.invoke({ pendingIncomingMessage: 'help me pick roles', turnConfig: baseTurnConfig() }, config)
    const r = result as { __interrupt__?: { value?: { kind?: string; questions?: { options?: { label: string; detail?: string; description?: string }[] }[] } }[] }
    expect(r.__interrupt__?.[0]?.value?.kind).toBe('ask_form')
    const option = r.__interrupt__?.[0]?.value?.questions?.[0]?.options?.[0]
    expect(option).toEqual({ label: 'Backend', detail: 'server-side roles' })
    expect(option).not.toHaveProperty('description')
  })
})
