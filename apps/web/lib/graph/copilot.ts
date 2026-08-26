// Copilot's StateGraph — LangGraph port of app/api/copilot/route.ts's
// tool-calling loop (docs/superpowers/specs/2026-08-16-langgraph-port-design.md,
// Stage 1's "Copilot on a StateGraph" build brief). Read that route file's
// header comment, lib/harness/copilot-tools.ts, lib/graph/invoke.ts and the
// STATEGRAPH GOTCHA in the brief before touching this file.
//
// ONE THREAD PER CONVERSATION, FOR ITS WHOLE LIFE
//   copilot_conversations.thread_id is minted once and reused by every later
//   turn (spec item 8.3). invoke.ts refuses fresh `input` on a thread that
//   already has a checkpoint (ExistingThreadCheckpointError) — so turn 2+ can
//   ONLY ever be driven by `resume`, never by input. That forces this graph
//   to never truly reach END while a conversation is alive: every turn ends
//   by parking at interrupt({kind:'next_turn'}) in loadContext (see below)
//   instead of finishing, so the NEXT HTTP request has something to resume.
//   This is the one load-bearing architectural decision this file makes that
//   the brief's 4-node list doesn't spell out byte-for-byte — the brief names
//   loadContext/plan/dispatch/finalize and says dispatch is where confirm/
//   review/ask interrupts live; it does not separately describe how turn N+1
//   re-enters the SAME thread. This is the resolution invoke.ts's own
//   RESUME SEMANTICS forces: verified empirically against a real MemorySaver
//   (development spike, not committed — a node calling interrupt() mid-loop
//   emits NO chunk of its own, then a terminal `{__interrupt__:[...]}]`
//   chunk; `.stream()` with no streamMode option defaults to 'updates', one
//   `{nodeName: partialReturn}` chunk per completed node — never a 'custom'
//   chunk from config.writer(), since invoke.ts's stream() call passes no
//   streamMode override, which is why wire events below travel as an
//   explicit `wireEvents` state field instead of config.writer()).
//
// DEADLINE HANDLING DIVERGES FROM lib/graph/runs.ts ON PURPOSE
//   runs.ts's entrypoint has no "yield control back for more input" concept
//   (a harness run is one bounded task), so a deadline mid-run has nothing to
//   route through except interrupt({kind:'deadline'}) + a later invoke(null).
//   Copilot already has exactly that yield point (the next_turn interrupt
//   above) on EVERY turn boundary, organic or forced — so plan (below)
//   composes the same forced-final message the pre-port route computed
//   in its own runToolUsed/steps-exhausted 'and it just becomes a normal
//   dispatch->finalize->loadContext turn, no second interrupt kind. This
//   still delivers "resumable next request" (spec item 4): the thread parks
//   at next_turn exactly like an organic final would, so the NEXT message
//   ("continue") is a normal fresh turn, not a lost one — matching what the
//   ORIGINAL route's own fallbackSummary text already promises the user
//   ("Ask me to continue and I will pick up from here").
//
// STATEGRAPH GOTCHA — replay safety, node by node:
//   loadContext: the interrupt() call is the FIRST thing it does whenever
//   state.awaitingTurn is true — nothing precedes it, so a re-run from the
//   top on resume just returns the resume value and falls straight into
//   beginTurn (the DB link-back write there is idempotent — `.is('thread_id',
//   null)` — and only runs AFTER interrupt() has already returned).
//   awaitingTurn=false on an ALREADY-LINKED thread is refused outright — see
//   this node's own comment. Defense-in-depth: NO_RETRY plus dispatchExecute's
//   own pending_dispatch guard (see below) are what actually keep `next`
//   correctly pointing at whichever task is genuinely still pending after a
//   crash; this refusal exists for the case that assumption is ever wrong,
//   so a stray landing here fails loudly instead of silently replanning
//   from an empty message.
//   plan: the deadline/step-budget check runs before any LLM call and before
//   any state mutation; the only interrupt-adjacent branch (the forced-final
//   composition) makes at most one more callLlm call and returns — it never
//   calls interrupt() itself (see DEADLINE HANDLING above), so plan has
//   nothing to replay-guard beyond "don't call the LLM twice for one
//   decision", which the fresh-request step/deadline reset (see plan below)
//   already prevents by construction (a resumed request always has a fresh
//   config.configurable.runId, so the SAME check never re-fires against
//   stale counters).
//   dispatch: (1) validity, (2) wall-clock/count gates for a tool call, ONE
//   node-return per outcome (final / redirected ask / a resolved legacy ask
//   or ask_form / a validated tool call handed to dispatchExecute). The
//   legacy-ask and ask_form branches are THIS node's own interrupt() call
//   sites (ask/ask_form) — nothing side-effecting precedes either one, and a
//   resumed re-run just re-enters the same branch and returns the resume
//   value. Everything else in this node is pure state-in/state-out with no
//   external effect; it never calls dispatchTool itself.
//   dispatchExecute: body order is (3) UNCONDITIONAL submitOrSendReason, (4)
//   review/bypass evaluation — (3)-(4) are the ONLY interrupt() call sites in
//   this node, and everything before them is pure. (5) dispatchTool is the
//   one real side effect in this whole graph and it sits strictly AFTER
//   every interrupt() in the node, so a resumed re-run replays (3)-(4)
//   harmlessly (same pure checks, same answer) and only reaches (5) once —
//   ON THE HAPPY PATH. A StateGraph node replays its WHOLE body on resume,
//   including everything after an already-consumed interrupt() (unlike the
//   Functional API's per-task memoization), so a crash strictly BETWEEN
//   dispatchTool resolving and this node's own return committing to the
//   checkpoint (a timeout, a serverless eviction, an OOM — proven reachable
//   in an adversarial fix-round review) would otherwise re-run (3)-(5) again
//   on the next continuation and silently re-fire an already-approved
//   guarded call. `pending_dispatch` (graph_threads,
//   20260817000005_graph_threads_pending_dispatch.sql) is the durable,
//   outside-the-checkpoint guard against exactly that: claimed right before
//   (5), cleared at the start of every new turn (beginTurn) — a claim found
//   for the SAME step on re-entry means the prior attempt's outcome is
//   unknown. Critically, that branch does NOT call interrupt() again to ask
//   — a fix-round probe against the real runtime proved a SECOND interrupt()
//   call within this same task can still be silently satisfied by the
//   ORIGINAL Command({resume}) value (LangGraph's "null resume" bookkeeping
//   is durable and is never marked consumed by a failed attempt), which
//   would defeat the guard right back. Ending the task with an honest
//   "not confirmed" trace entry instead — no interrupt, no throw — is what
//   actually closes the hole: dispatchTool can only be reached again through
//   a genuinely NEW model turn and a genuinely NEW confirm interrupt.

import { Annotation, StateGraph, START, END, interrupt } from '@langchain/langgraph'
import type { LangGraphRunnableConfig } from '@langchain/langgraph'
import { AskUserError, parseAskUserRequest, type AskQuestion } from '../harness/ask-user'
import { buildTurnContext } from '../context/assemble'
import { callLlm, parseJsonLoose } from '../harness/llm'
import type { ReasoningEffort } from '../harness/types'
import { loadApiKeys } from '../harness/keys'
import { createAdminClient } from '../harness/supabase-admin'
import { loadRecentMessages, type MessageRow } from '../harness/copilot-store'
import { getMemoryStore } from '../memory/mem0-store'
import { DemoMemoryWriteRefusedError, type MemoryItem } from '../memory/types'
import {
  dispatchTool,
  toolsPromptBlock,
  isValidTool,
  isRunTool,
  isActTool,
  isReadTool,
  isMcpToolName,
  type CopilotToolContext,
} from '../harness/copilot-tools'
import { isStepAgentType, type StepAgentType } from '../harness/copilot-tool-catalog'
import type { AdminClient } from '../harness/types'

// --- Wire-adjacent types (also imported by app/api/copilot/route.ts's adapter) ---

export type ChatMessage = { role: 'user' | 'assistant'; content: string }

export interface AskOption {
  label: string
  detail?: string
}

export interface TraceEntry {
  tool: string
  args: Record<string, unknown>
  thought?: string
  observation: unknown
  ok: boolean
  status: 'ok' | 'error' | 'skipped'
  requiresConfirmation?: boolean
}

export interface ModelAction {
  action?: string
  tool?: string
  args?: Record<string, unknown>
  thought?: string
  message?: string
  question?: string
  options?: AskOption[]
  questions?: unknown
}

/** Fully resolved per-turn choices — the route computes every fallback
 *  (conversation-stored model/enabledAgents/bypassMode vs. request override)
 *  BEFORE calling into the graph, exactly as it does today; nothing in here
 *  re-derives a default from a partial value. */
export interface CopilotTurnConfig {
  model?: string
  thinkingMode: 'auto' | 'review'
  effort: ReasoningEffort
  bypassMode: boolean
  enabledAgents?: string[]
  userEmail: string
  /**
   * The route's own already-computed demo-session verdict (isDemoProfile on
   * the profile it already reads at request time) — threaded through so
   * finalize's post-turn MemoryStore.add can refuse a demo write without
   * lib/memory/mem0-store.ts doing a second, independent profile read (see
   * that file's header). Defaults false so a caller that predates this field
   * (any test fixture using DEFAULT_TURN_CONFIG) never accidentally refuses
   * a real write.
   */
  isDemo: boolean
}

/** One SSE-shaped event a node wants the adapter to emit verbatim. */
export type WireEvent = Record<string, unknown>

// --- SSE adapter helpers -----------------------------------------------
//
// Pure translation functions app/api/copilot/route.ts's adapter uses to turn
// graph output into the wire vocabulary. They live here, not in route.ts,
// because a Next.js route module may only export the handful of names the
// App Router's route-export validation recognizes (dynamic, maxDuration,
// GET/POST/DELETE/...) — anything else fails `next build` even though a bare
// `tsc --noEmit` in a directory with no prior `.next` build never catches it
// (route.adapter.test.ts imports these from here, not from './route').

/** True when a persisted assistant message is a review-mode pause sentinel
 *  from BEFORE this route moved onto the graph (spec item 3: "GET keeps a
 *  read-filter hiding pre-port sentinel rows"). Nothing writes these anymore
 *  — the graph's own checkpoint holds a pending pause instead. */
export function isPausedSentinel(m: MessageRow): boolean {
  if (m.role !== 'assistant' || !Array.isArray(m.trace) || m.trace.length === 0) return false
  const last = m.trace[m.trace.length - 1] as { status?: string } | undefined
  return last?.status === 'paused'
}

/** Pulls the value passed to the single interrupt() the graph parked on,
 *  from invokeGraphForUser's own result — see this file's header for the
 *  empirical shape this reads (`{...values, __interrupt__: [{id,value}]}`
 *  via .invoke(), or a terminal `{__interrupt__:[...]}` chunk via .stream(),
 *  both verified against a real MemorySaver). */
export function extractInterruptValue(result: unknown): unknown | null {
  if (!result || typeof result !== 'object') return null
  const arr = (result as Record<string, unknown>).__interrupt__
  if (!Array.isArray(arr) || arr.length === 0) return null
  const last = arr[arr.length - 1] as { value?: unknown } | undefined
  return last?.value ?? null
}

/** Translates one graph interrupt() value into the wire shape this route has
 *  always sent for the equivalent pause — see dispatch/dispatchExecute above
 *  for exactly what each `kind` carries. `next_turn` (the between-turn
 *  boundary every finished turn parks at, organic or forced — see this
 *  file's header) is not client-visible at all: it isn't a pause the user
 *  needs to act on, so it returns null and the adapter just ends the
 *  stream. */
export function translateInterruptToWireEvent(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  switch (v.kind) {
    case 'confirm':
    case 'review':
      return {
        type: 'paused',
        step: v.step,
        thought: v.thought ?? '',
        tool: v.tool,
        args: v.args,
        ...(v.kind === 'confirm' ? { requiresConfirmation: true, reason: v.reason } : {}),
      }
    case 'ask':
      return {
        type: 'question',
        step: v.step,
        question: v.question,
        ...(Array.isArray(v.options) && v.options.length ? { options: v.options } : {}),
      }
    case 'ask_form':
      return { type: 'question', step: v.step, questions: v.questions }
    default:
      return null
  }
}

// --- Resume/input payload shapes -------------------------------------------

/** Fresh thread's very first turn — the only case invokeGraphForUser's
 *  `input` is ever used for (see file header). Field names match
 *  CopilotState's own channels EXACTLY (`pendingIncomingMessage`, not
 *  `message`): LangGraph merges `input` as a partial state update through
 *  the real channel reducers, so a field that doesn't match a channel name
 *  is silently dropped rather than erroring — this shape is what makes that
 *  impossible to get wrong unnoticed (see copilot.test.ts's direct
 *  `copilotGraph.invoke()` calls, which only typecheck against the real
 *  channel names, not this route-facing alias). */
export interface CopilotGraphInput {
  pendingIncomingMessage: string
  turnConfig: CopilotTurnConfig
}

/** Resume matrix (spec item 2), implemented literally: the route builds
 *  exactly one of these per resumed request. `message` covers BOTH the
 *  ordinary next-turn continuation (answering loadContext's next_turn
 *  interrupt) AND the "user sent something new instead of resolving a
 *  pending mid-turn pause" case — dispatch treats a `message` resume it
 *  wasn't expecting as an abandon-and-start-fresh signal (see dispatch
 *  below), which is the graph-native equivalent of the pre-port route
 *  simply leaving an unresolved paused sentinel behind. */
export type CopilotResume =
  | { kind: 'message'; message: string; turnConfig: CopilotTurnConfig }
  | { approved: true; confirmed?: true }
  | { approved: false; directive?: string }
  | { answer: string }

function isMessageResume(r: unknown): r is { kind: 'message'; message: string; turnConfig: CopilotTurnConfig } {
  return Boolean(r) && typeof r === 'object' && (r as { kind?: unknown }).kind === 'message'
}

/** What kind of interrupt a thread is currently parked at, per
 *  lib/graph/invoke.ts#getGraphStateForUser's pendingInterrupt.value.kind —
 *  read loosely (that file has zero imports from graph-definition modules,
 *  same reason as its other widened fields). */
export type PendingInterruptKind = 'ask' | 'ask_form' | 'confirm' | 'review' | 'next_turn' | null

export interface ResumeMatrixParams {
  /** False only for a conversation whose thread was never minted, or one
   *  editMessageId just abandoned — the one case `input` is legal. */
  hasThread: boolean
  /** True iff the request body's `directive` field is present (even ""). */
  isResume: boolean
  /** True iff the thread has a task queued to run next AND nothing is
   *  parked at interrupt() — i.e. genuinely killed mid-task (a crash,
   *  timeout, or Stop before any interrupt was reached), never cleanly
   *  parked. See lib/graph/invoke.ts#GraphStateForUser's `next`/
   *  `pendingInterrupt` doc. Always false when !hasThread — read this
   *  BEFORE isResume/pendingKind below, which only make sense once a
   *  cleanly-parked interrupt is known to exist. */
  midFlight: boolean
  pendingKind: PendingInterruptKind
  confirmToolCall: boolean
  /** Trimmed request.directive, present only when isResume. */
  resumeDirective: string | undefined
  messageIn: string
  turnConfig: CopilotTurnConfig
}

export type GraphInputOrResume =
  | { kind: 'input'; input: CopilotGraphInput }
  | { kind: 'resume'; resume: CopilotResume }
  /** Nothing to attach a value to (see `midFlight` above) — the route must
   *  drive this with neither `input` nor `resume` (lib/graph/invoke.ts's
   *  `{kind:'continue'}` / `invoke(null, cfg)`), read where that leg landed,
   *  and ONLY THEN decide what to do with whatever the caller sent
   *  alongside it — never silently drop it (production standard: no
   *  silently swallowed input). See app/api/copilot/route.ts's CONTINUE
   *  handling for the recover-then-decide sequence this drives. */
  | { kind: 'continue' }

/**
 * The resume matrix (spec item 2), as a pure decision — no I/O, directly
 * unit-testable. The route is the only caller: it resolves `hasThread`/
 * `midFlight`/`pendingKind` via getGraphStateForUser (a real DB read) and
 * hands the rest straight through from the request body.
 */
export function buildInputOrResume(p: ResumeMatrixParams): GraphInputOrResume {
  if (!p.hasThread) {
    return { kind: 'input', input: { pendingIncomingMessage: p.messageIn, turnConfig: p.turnConfig } }
  }
  if (p.midFlight) {
    return { kind: 'continue' }
  }
  if (p.isResume) {
    if (p.pendingKind === 'ask' || p.pendingKind === 'ask_form') {
      return { kind: 'resume', resume: { answer: p.resumeDirective ?? '' } }
    }
    if (p.pendingKind === 'confirm' || p.pendingKind === 'review') {
      const resume: CopilotResume = p.confirmToolCall
        ? { approved: true, confirmed: true }
        : p.resumeDirective
          ? { approved: false, directive: p.resumeDirective }
          : { approved: true }
      return { kind: 'resume', resume }
    }
    // Nothing genuinely pending (next_turn, or a defensive fallback if the
    // checkpoint somehow carries no interrupt at all) — a stray directive
    // becomes a fresh instruction, exactly like the pre-port route's own
    // "nothing pending to resume" branch.
    return { kind: 'resume', resume: { kind: 'message', message: p.resumeDirective ?? '', turnConfig: p.turnConfig } }
  }
  // Plain new message on an existing thread. Whatever is CURRENTLY pending —
  // the normal next_turn boundary, or an abandoned mid-turn pause — receives
  // this the same way; see CopilotResume's doc above.
  return { kind: 'resume', resume: { kind: 'message', message: p.messageIn, turnConfig: p.turnConfig } }
}

// --- Budgets (verbatim from the pre-port route — see its header for why
// each number is what it is) --------------------------------------------

const MAX_STEPS = 18
const TIME_BUDGET_MS = 280_000
const FINAL_RESERVE_MS = 8_000
const RUN_MIN_MS = 42_000
const ACT_MIN_MS = 12_000
const RESEARCH_COMPANY_MAX_PER_TURN = 4

const COMPANY_FACT_SIGNAL =
  /\b(series\s*[a-e]\b|funding|funded|valuation|ipo\b|acquir\w*|sponsor\w*|visa|h-?1b|stage\b|headcount|raised)\b/i

// --- Pure helpers ported from the pre-port route (unchanged behavior) -----

export function observationForWire(obs: unknown): string {
  const s = typeof obs === 'string' ? obs : JSON.stringify(obs)
  return s.length > 2000 ? s.slice(0, 2000) : s
}

export function scrubJargon(text: string): string {
  return text.replace(/\bdossiers?\b/gi, (m) => (m[0] === m[0].toUpperCase() ? 'Company research' : 'company research'))
}

/**
 * The submit/send guard shared by every dispatch path — dispatchExecute
 * below (the copilot's own confirm/review interrupt) AND app/api/mcp/route.ts
 * (which has no human-confirm channel at all, so a non-null reason there is a
 * flat refusal rather than a pause — see that route's header). Exported for
 * that reuse; still called UNCONDITIONALLY, before anything else, at both
 * call sites — "it never sends/submits anything you have not read" is a
 * property of this one function, not of whichever surface happens to call it.
 */
export function submitOrSendReason(tool: string, args: Record<string, unknown>): string | null {
  const dangerPattern = /submit|apply|dispatch_application|send[-_]?(email|message|mail|outreach)|sendmail/i
  if (dangerPattern.test(tool)) {
    return `"${tool}" looks like it would submit an application or send a message to a real person — that always needs your explicit go-ahead.`
  }
  if (tool === 'trigger_run') {
    const goal = typeof args.goal === 'string' ? args.goal : ''
    if (/\b(submit(?:ting|ted)?|apply|applying|applies|applied|send(?:ing)?|sent)\b/i.test(goal)) {
      return `This run's goal ("${goal.slice(0, 160)}") reads as submitting an application or sending outreach — that always needs your explicit go-ahead.`
    }
  }
  return null
}

export function systemPrompt(
  enabledAgents: ReadonlySet<StepAgentType> | undefined,
  mcpBlock: string,
  standingBlock: string,
  goalsBlock: string,
  summaryBlock: string,
  memoryBlock: string,
  kbBlock: string,
  entityBlock: string
): string {
  return `You are Cello Copilot, an assistant embedded in a job-search product. You help the
user understand their job matches, sharpen their resume, research companies, prep for
interviews, and drive the multi-agent harness (sourcing, matching, tailoring, applying via
official ATS APIs only).

You work like a coding agent: think, call ONE tool, read its result, then decide the next
step. Reply with a SINGLE JSON object and nothing else. Exactly three shapes:

  {"action":"tool","tool":"<name>","args":{...},"thought":"the decision and its trigger, one short sentence"}
  {"action":"ask","question":"<one direct question>","options":[{"label":"<short choice>","detail":"<optional context>"}],"thought":"why this needs the user, one short sentence"}
  {"action":"final","message":"<markdown answer for the user>"}

Available tools:
${toolsPromptBlock(enabledAgents)}
${mcpBlock ? `\n${mcpBlock}\n` : ''}${standingBlock ? `\n${standingBlock}\n` : ''}${goalsBlock ? `\n${goalsBlock}\n` : ''}${summaryBlock ? `\n${summaryBlock}\n` : ''}${memoryBlock ? `\n${memoryBlock}\n` : ''}${entityBlock ? `\n${entityBlock}\n` : ''}${kbBlock ? `\n[Relevant excerpts from your knowledge base for this message]\n${kbBlock}\n` : ''}
BEFORE you pick an action, actually deliberate. This deliberation is the "reasoning" the UI
shows the user above your one-line "thought" — it is meant to be read, so make it worth
reading, not a restatement of the goal you were given:
- What do you already know — from this conversation and from observations already in the
  trace? Name the concrete facts you have in hand (ids, scores, counts, what a prior tool
  call actually returned), not just the topic.
- What's missing that you need before you can act well? Say specifically what, and which
  tool would get it.
- Which tool(s) could plausibly go next, and why does the one you pick beat the runner-up?
  If there is really only one reasonable option, say briefly why the obvious alternatives
  don't fit here rather than skipping straight to the pick.
- What could go wrong, or what are you genuinely uncertain about (a stale score, an
  ambiguous target, a tool that might come back empty, a goal that could mean two different
  things)? Naming the risk is more useful than hiding it.
Then the "thought" field must be ONLY the decision and its trigger (e.g. "Score is 11 days
old and the user asked to recheck fit -> re-run explain_match"), never a repeat of the
reasoning that precedes it — the two render stacked in the UI, so if your thought and your
reasoning would read as the same sentence twice, cut the thought down to just the verb and
the target.

Operating rules:
- Start with cheap read tools (list_jobs, list_runs, explain_match, get_application,
  list_contacts, get_dossier) to gather ids and facts before acting.
- Never invent a jobId, companyId, or contactId. If you need one, call list_jobs /
  list_contacts first, or use "ask" if the user's message doesn't disambiguate it.
- FAN OUT WITH A BATCH TOOL INSTEAD OF LOOPING ONE PER TURN. You still call exactly ONE tool
  per turn — that protocol never changes — but when an ask needs the SAME tool run against
  SEVERAL similar items (research N companies, check sponsorship for a list of names), reach
  for the batch form when one exists (research_companies takes companyIds:string[];
  check_sponsorship already takes companyNames:string[]) instead of calling the singular tool
  once per item across N separate turns. This is exactly how a coding agent fans out a batch of
  parallel subtasks in one call: the batch tool runs its items with bounded concurrency
  internally and gives you back one result per item, so nothing about per-item detail is lost —
  only the number of turns it costs you. Looping a singular tool one item per turn is how a
  compound ask ("research these 6 companies") burns through your step budget before it
  finishes; the batch tool is how it doesn't. Only fall back to the singular tool for a single
  item, or once the batch's own cap is smaller than what's left to do (its result says so).
- DO THE WORK YOURSELF, ONE TOOL AT A TIME, RIGHT HERE — the way you'd work in a coding
  session, not by handing off to a separate run the user has to go watch elsewhere. You have
  direct tools for the things people actually ask for: source_jobs to pull fresh postings,
  score_jobs to rank a batch against the resume, optimize_resume / tailor_cv /
  draft_outreach / prep_interview to act on one job. Call one, read what it found, decide the
  next step. A request like "find fresh roles and score them" is TWO ordinary tool calls
  (source_jobs then score_jobs) in this conversation — not a reason to hand off.
- HOLD THE GOAL, DON'T JUST REACT TO THE LAST RESULT. Every planning call ends with a
  restatement of your standing objective for this turn (see "[standing objective]" at the
  bottom of your context) — judge your next move against THAT, not against the shape of the
  last observation alone. A compound ask ("N roles, filtered by A, B and C") is not done when
  one tool has run once; it's done when you can honestly account for each filter against the
  jobs you're about to report.
- ACT, DO NOT DEFER — this is the most important rule here. Ending your turn with "ask" is a
  last resort, not a default, and only for a genuine decision: spending real money beyond
  normal tool budgets, an irreversible action, or a target that stays ambiguous between two or
  more concrete named alternatives after you've looked. If a fact is discoverable with a tool
  you already have, go get it — do not ask the user to tell you something you can find out.
  Concretely, in this product: whether a company sponsors visas or its funding stage is
  get_dossier's (read the stored dossier) or research_company's/research_companies' (build one,
  or several at once — see FAN OUT above) job, not a question. Which of the user's tracked jobs
  best fit their resume is score_jobs' job, not a question — score them and report the ranking.
  Never end a turn on a question you could have answered yourself with a tool already in your
  list above. If you catch yourself about to
  offer "research X first" as one of several options in a question, that is the tell that you
  should just call research_company on X right now instead of asking — an offer to do the work
  is not the work; do it, then report what you found.
- BROADEN ON EMPTY. A tool coming back with nothing usable (source_jobs inserted 0, score_jobs
  had nothing scoreable, search_kb found no hits, or a filter you applied leaves zero results)
  is not a stopping point — it's a signal to relax the narrowest constraint and try again, the
  way a good recruiter would: an exact title -> an adjacent one (e.g. "AI Engineer" ->
  "ML Engineer" / "Applied Scientist" / "Applied AI Engineer"), a tight location -> remote or
  nearby, a strict freshness window -> a wider one. Try a genuinely different angle two or
  three times before you conclude the well is dry. Never silently drop a constraint the user
  actually gave you — when you broaden, SAY what you relaxed and why, in the final answer.
- PARTIAL SUCCESS IS STILL SUCCESS. If the user asked for 10 and, after actually working the
  problem (searching, broadening, scoring), you can honestly stand behind 6, deliver the 6
  with a one-line reason for the gap — do not deliver nothing while you ask permission to keep
  trying. Report what you verified, what you could not confirm and why, and what you'd need to
  go further, rather than stalling on a question.
- trigger_run is NOT the default escape hatch for anything multi-step. It plans and executes
  a whole DAG in the background, on a separate surface — reserve it for something genuinely
  bigger than a handful of tool calls: an explicit unattended or repeating campaign the user
  asked for (e.g. "keep sourcing and drafting applications for anything above 90 while I'm
  away") or a plan with many interdependent stages you can't reasonably narrate step by step
  here. If the only reason you're reaching for it is that the ask involves more than one
  tool, use the direct tools instead. research_company/research_companies are the other "run"
  tools — slow because they fetch live pages, so use them deliberately, but each is still one
  call, not a handoff.
- score_jobs and research_companies cost the user real money per item — both batch sizes are
  already capped small; don't raise a limit past what's needed, and don't call either
  repeatedly in one turn to route around its cap.
- When a tool result contains an error or a "note" telling you something is missing (no
  match yet, no resume, no key), adapt: either fix course with another tool or explain it
  in your final answer. Do not loop on the same failing tool.
- Use "ask" ONLY when the answer would genuinely change what you do next AND you cannot find
  it out yourself — see ACT, DO NOT DEFER above. Never ask to fish for approval you already
  have (the user's message IS the approval), and never ask more than once before making real
  progress. "options" are suggestions the user can pick OR ignore in favor of their own
  free-text answer — never a closed set, so keep each label short and phrase the question
  itself so a free-text answer works too.
- Keep final answers concise, skimmable markdown. Cite concrete numbers/titles from tool
  results. Never fabricate data a tool did not return.
- NEVER LEAK INTERNAL MACHINERY INTO USER-FACING TEXT. Tool/table names like "dossier" (say
  "company research" or name the fact directly — funding stage, visa sponsorship, culture
  notes), "trace", "DAG", "harness", or any other internal identifier are implementation
  details for you, not vocabulary for the user. This applies to every word you write for the
  user to read — your deliberation/reasoning, "thought", "ask" questions, and "final" messages
  alike, not just the last one. If a tool result's own note/error text uses an internal term,
  translate it before you repeat it back rather than quoting it verbatim.`
}

function objectiveReminder(objective: string, trace: TraceEntry[]): string {
  const acted = trace.filter((t) => t.status === 'ok' || t.status === 'error' || t.status === 'skipped')
  const recap = acted.length > 0 ? acted.map((t) => `${t.tool}(${t.status})`).join(', ') : 'nothing yet this turn'
  return (
    `[standing objective] "${objective}"\n` +
    `Steps taken so far this turn: ${recap}.\n` +
    'Decide your NEXT action by checking it against that objective, not just the last tool ' +
    "result: which part is still unmet, and which tool closes the gap? If a step came back " +
    'empty or thin, broaden and retry (adjacent titles, wider location/freshness) before you ' +
    'consider anything else. If a fact is missing but a tool could find it (visa sponsorship, ' +
    'funding stage, which jobs fit the resume), go get it — do not ask for it. If you can only ' +
    'partially satisfy the objective after genuinely trying, deliver that partial result with a ' +
    'one-line reason instead of stopping to ask.'
  )
}

function buildMessages(convo: ChatMessage[], trace: TraceEntry[], objective: string, directive?: string): ChatMessage[] {
  const messages: ChatMessage[] = [...convo]
  for (const t of trace) {
    messages.push({
      role: 'assistant',
      content: JSON.stringify({
        action: 'tool',
        tool: t.tool,
        args: t.args,
        ...(t.thought ? { thought: t.thought } : {}),
      }),
    })
    messages.push({
      role: 'user',
      content: `TOOL RESULT [${t.tool}] (${t.status}):\n${JSON.stringify(t.observation).slice(0, 6000)}`,
    })
  }
  if (directive) messages.push({ role: 'user', content: directive })
  if (objective) messages.push({ role: 'user', content: objectiveReminder(objective, trace) })
  return messages
}

/** Deterministic recap when no more LLM calls can be afforded — verbatim
 *  from the pre-port route (see its header for the "report what was FOUND,
 *  not what ran" rationale). */
export function fallbackSummary(trace: TraceEntry[]): string {
  if (trace.length === 0) {
    return "I ran out of time before I could do anything useful. Narrowing the request — one company, one role, or one job at a time — will get further."
  }

  const asRecord = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null)

  const lines: string[] = []
  const backgroundRuns: string[] = []

  for (const t of trace) {
    const obs = asRecord(t.observation)
    if (obs && typeof obs.error === 'string') {
      lines.push(`- ${t.tool}: failed — ${obs.error}`)
      continue
    }
    if (obs && Array.isArray(obs.jobs)) {
      lines.push(`- found ${(obs.count as number) ?? obs.jobs.length} matching job(s)`)
    } else if (obs && typeof obs.runId === 'string') {
      backgroundRuns.push(String(obs.runId))
      lines.push(`- started a full agent run (${String(obs.status ?? 'running')})`)
    } else if (obs && typeof obs.atsScore === 'number') {
      const after = asRecord(obs.rescore)?.atsScore
      lines.push(`- scored the resume ${obs.atsScore}${typeof after === 'number' ? ` and rewrote it to ${after}` : ''}`)
    } else if (obs && Array.isArray(obs.contacts)) {
      lines.push(`- found ${obs.contacts.length} contact(s)`)
    } else if (t.status === 'ok') {
      lines.push(`- ${t.tool}: done`)
    } else {
      lines.push(`- ${t.tool}: ${t.status}`)
    }
  }

  const parts = [`I hit my time limit for this turn. Here is what happened:`, '', lines.join('\n')]

  if (backgroundRuns.length > 0) {
    parts.push(
      '',
      backgroundRuns.length === 1
        ? "The agent run is still going — it keeps working after this message and picks up automatically if it stops on a time limit. Watch it in the runs panel; you do not need to ask me to continue."
        : "Those agent runs are still going — they keep working after this message and pick up automatically if they stop on a time limit. Watch them in the runs panel."
    )
  } else {
    parts.push('', 'Nothing is still running. Ask me to continue and I will pick up from here.')
  }

  return parts.join('\n')
}

/** Cheap model for the rolling-summary refresh below — same reasoning as
 *  lib/memory/mem0-store.ts's MEM0_INTERNAL_MODEL: this is a compression
 *  task over the conversation's own text, not user-facing generation. */
const SUMMARY_REFRESH_MODEL = 'anthropic/claude-haiku-4.5'
/** Refresh fires once the unsummarized tail reaches this many messages. */
const SUMMARY_REFRESH_THRESHOLD = 12
/** ponytail: loadRecentMessages' own ceiling — the unsummarized tail this
 *  reads is bounded to the newest 200 messages. A refresh fires every ~12
 *  messages in normal use, so the tail this actually sees is almost always
 *  far smaller; only a conversation that somehow accumulated 200+ messages
 *  since its last refresh would ever hit this ceiling. Upgrade path: page
 *  through copilot_messages by created_at if that ever proves false. */
const SUMMARY_SOURCE_CEILING = 200

/**
 * Post-turn rolling-summary refresh (Step 7's turn-assembly composition item
 * (a)) — called from app/api/copilot/route.ts's persistTurn, AFTER the SSE
 * `final` event already reached the client, so this never adds perceived
 * latency to a turn even though it's awaited rather than fired-and-forgotten
 * (a genuinely detached promise has no guaranteed lifetime once a serverless
 * response finishes). Never throws: a failed refresh just leaves next
 * turn's context one refresh cycle staler, never fails the request that
 * triggered it.
 */
export async function refreshConversationSummary(admin: AdminClient, userId: string, conversationId: string): Promise<void> {
  try {
    const { data: convoRow } = await admin
      .from('copilot_conversations')
      .select('summary, summary_through_message_id')
      .eq('id', conversationId)
      .maybeSingle()
    const row = convoRow as { summary?: string | null; summary_through_message_id?: string | null } | null
    const priorSummary = row?.summary ?? null
    const throughId = row?.summary_through_message_id ?? null

    const recent = await loadRecentMessages(admin, conversationId, SUMMARY_SOURCE_CEILING)
    const throughIndex = throughId ? recent.findIndex((m) => m.id === throughId) : -1
    const unsummarized = throughIndex >= 0 ? recent.slice(throughIndex + 1) : recent
    if (unsummarized.length < SUMMARY_REFRESH_THRESHOLD) return

    const apiKeys = await loadApiKeys(admin, userId)
    const transcript = unsummarized.map((m) => `${m.role}: ${m.content}`).join('\n')
    const res = await callLlm(apiKeys, {
      system:
        'You maintain a rolling summary of an ongoing job-search assistant conversation. Fold the new messages into the ' +
        'existing summary, keeping concrete facts (job/company names, decisions made, numbers, preferences stated) and ' +
        'dropping small talk. Output ONLY the updated summary text, no preamble, under 300 words.',
      prompt: `${priorSummary ? `Existing summary:\n${priorSummary}\n\n` : ''}New messages:\n${transcript}`,
      model: SUMMARY_REFRESH_MODEL,
      maxTokens: 500,
      temperature: 0.2,
    })
    const newSummary = res.content.trim()
    if (!newSummary) return

    const lastId = unsummarized[unsummarized.length - 1]!.id
    await admin.from('copilot_conversations').update({ summary: newSummary, summary_through_message_id: lastId }).eq('id', conversationId)
  } catch (e) {
    console.error(`[graph] copilot: summary refresh failed for conversation ${conversationId}, continuing without it: ${(e as Error).message}`)
  }
}

// --- State -------------------------------------------------------------

const DEFAULT_TURN_CONFIG: CopilotTurnConfig = { thinkingMode: 'auto', effort: 'high', bypassMode: false, userEmail: '', isDemo: false }

const CopilotState = Annotation.Root({
  messages: Annotation<ChatMessage[]>({ reducer: (_l, r) => r, default: () => [] }),
  trace: Annotation<TraceEntry[]>({ reducer: (_l, r) => r, default: () => [] }),
  objective: Annotation<string>({ reducer: (_l, r) => r, default: () => '' }),
  pendingDirective: Annotation<string | undefined>({ reducer: (_l, r) => r, default: () => undefined }),
  pendingAction: Annotation<ModelAction | undefined>({ reducer: (_l, r) => r, default: () => undefined }),
  lastRunId: Annotation<string | undefined>({ reducer: (_l, r) => r, default: () => undefined }),
  stepsThisRunAttempt: Annotation<number>({ reducer: (_l, r) => r, default: () => 0 }),
  deadlineAt: Annotation<number>({ reducer: (_l, r) => r, default: () => 0 }),
  runToolUsed: Annotation<boolean>({ reducer: (_l, r) => r, default: () => false }),
  researchCompanyCount: Annotation<number>({ reducer: (_l, r) => r, default: () => 0 }),
  askRedirectUsed: Annotation<boolean>({ reducer: (_l, r) => r, default: () => false }),
  awaitingTurn: Annotation<boolean>({ reducer: (_l, r) => r, default: () => false }),
  threadLinked: Annotation<boolean>({ reducer: (_l, r) => r, default: () => false }),
  turnConfig: Annotation<CopilotTurnConfig>({ reducer: (_l, r) => r, default: () => DEFAULT_TURN_CONFIG }),
  sys: Annotation<string>({ reducer: (_l, r) => r, default: () => '' }),
  finalMessage: Annotation<string | undefined>({ reducer: (_l, r) => r, default: () => undefined }),
  /** Seeded by CopilotGraphInput on a brand-new thread's very first turn
   *  only; consumed and cleared by loadContext. Every later turn arrives via
   *  a `message` resume instead (see the file header). */
  pendingIncomingMessage: Annotation<string | undefined>({ reducer: (_l, r) => r, default: () => undefined }),
  wireEvents: Annotation<WireEvent[]>({ reducer: (_l, r) => r, default: () => [] }),
})

type CopilotStateType = typeof CopilotState.State

interface CopilotConfigurable {
  userId: string
  runId: string
  threadId: string
  conversationId: string
}

function configurableOf(config: LangGraphRunnableConfig): CopilotConfigurable {
  const c = config.configurable as Partial<CopilotConfigurable> | undefined
  if (!c?.userId || !c.runId || !c.threadId || !c.conversationId) {
    throw new Error(
      'copilot graph: config.configurable is missing userId/runId/threadId/conversationId — invokeGraphForUser must inject the first three and the route must pass conversationId via extraConfigurable.'
    )
  }
  return c as CopilotConfigurable
}

function enabledAgentsSet(turnConfig: CopilotTurnConfig): ReadonlySet<StepAgentType> | undefined {
  if (!turnConfig.enabledAgents || turnConfig.enabledAgents.length === 0) return undefined
  return new Set(turnConfig.enabledAgents.filter(isStepAgentType))
}

/** Last verbatim messages a turn gets, on top of the rolling summary and
 *  memory search below — see this file's header PERSISTENCE note for why
 *  the cap exists at all (an unbounded checkpoint `messages` array). */
const RECENT_MESSAGE_WINDOW = 12
/** How many past-session memories MemoryStore.search returns into a turn's
 *  system prompt. */
const MEMORY_SEARCH_LIMIT = 6
/** Post-turn MemoryStore.add's own "capped input" — mem0 runs an LLM fact-
 *  extraction pass over whatever this caps to, so an unbounded final answer
 *  (a long research writeup) never turns one turn into an oversized,
 *  wasteful extraction call. */
const MEMORY_ADD_CHAR_CAP = 4000

function formatSummaryBlock(summary: string | null | undefined): string {
  if (!summary || !summary.trim()) return ''
  return `[Summary of earlier messages in this conversation, not shown verbatim below]\n${summary.trim()}`
}

function formatMemoryBlock(items: MemoryItem[]): string {
  if (items.length === 0) return ''
  return `[Relevant memories from past conversations with this user]\n${items.map((m) => `- ${m.memory}`).join('\n')}`
}

/**
 * The bounded turn-assembly composition (Step 7 of the memory build): a
 * rolling summary + the last RECENT_MESSAGE_WINDOW messages verbatim +
 * MemoryStore.search results, replacing what used to be an unboundedly
 * growing `state.messages` checkpoint array. Both the summary read and the
 * memory search are best-effort — a DB hiccup or a mem0 hiccup degrades this
 * turn's context, it must never fail the turn outright the way a missing
 * key or a budget cap legitimately does.
 */
export async function assembleTurnContext(
  admin: AdminClient,
  cfg: CopilotConfigurable,
  currentMessage: string
): Promise<{ summaryBlock: string; memoryBlock: string; recentMessages: ChatMessage[] }> {
  const { data: convoRow } = await admin
    .from('copilot_conversations')
    .select('summary')
    .eq('id', cfg.conversationId)
    .maybeSingle()
  const summaryBlock = formatSummaryBlock((convoRow as { summary?: string | null } | null)?.summary)

  // route.ts appends the incoming user message to copilot_messages BEFORE
  // invoking the graph (see this file's header PERSISTENCE note) on every
  // path that reaches beginTurn, so the freshly loaded window normally
  // already ends with `currentMessage` — appending it again would duplicate
  // it. The one case that doesn't hold (a persistence failure, or a
  // synthetic never-persisted conversation) is handled by checking rather
  // than assuming.
  const recentRows = await loadRecentMessages(admin, cfg.conversationId, RECENT_MESSAGE_WINDOW)
  const last = recentRows[recentRows.length - 1]
  const alreadyIncludesCurrent = last?.role === 'user' && last.content === currentMessage
  const recentMessages: ChatMessage[] = recentRows.map((m) => ({ role: m.role, content: m.content }))
  if (!alreadyIncludesCurrent) recentMessages.push({ role: 'user', content: currentMessage })

  let memoryBlock = ''
  if (currentMessage.trim()) {
    try {
      const memories = await getMemoryStore().search(cfg.userId, currentMessage, { limit: MEMORY_SEARCH_LIMIT })
      memoryBlock = formatMemoryBlock(memories)
    } catch (e) {
      console.error(`[graph] copilot: memory search failed for thread ${cfg.threadId}, continuing without it: ${(e as Error).message}`)
    }
  }

  return { summaryBlock, memoryBlock, recentMessages }
}

/**
 * Reset-for-a-new-turn, shared by loadContext (the normal path, after its
 * next_turn interrupt resolves) and dispatch (the abandon-a-pending-pause
 * path — see CopilotResume's doc). Only ever called AFTER whatever interrupt
 * led here has already returned a real value — never precedes one.
 */
async function beginTurn(
  admin: AdminClient,
  cfg: CopilotConfigurable,
  state: CopilotStateType,
  incoming: { message: string; turnConfig: CopilotTurnConfig }
): Promise<Partial<CopilotStateType>> {
  if (!state.threadLinked) {
    // Idempotent — mirrors journal.ts#markRunRunning's threadId-stamping
    // precedent (see this file's header): safe to repeat on any replay.
    await admin.from('copilot_conversations').update({ thread_id: cfg.threadId }).eq('id', cfg.conversationId).is('thread_id', null)
  }
  // Every new turn (organic next_turn, or an abandoned mid-turn pause —
  // see the doc above) starts step numbering over at 0 (trace resets
  // below). Clear any dispatch claim left over from whatever turn came
  // before, so a leftover claim from a DIFFERENT turn is never mistaken for
  // an in-flight duplicate of THIS turn's first dispatch — see
  // dispatchExecute's replay-safety comment for what this column protects.
  // Best-effort: worst case on a write failure is one unnecessary
  // reconfirm prompt later, never a silent double-dispatch.
  const { error: clearClaimError } = await admin.from('graph_threads').update({ pending_dispatch: null }).eq('thread_id', cfg.threadId)
  if (clearClaimError) console.error(`[graph] copilot: failed to clear pending_dispatch for thread ${cfg.threadId}: ${clearClaimError.message}`)
  // lib/context/assemble.ts: mcpBlock + standingBlock + goalsBlock (the old
  // ad-hoc mcpToolsPromptBlock/readStandingPreferences/formatActiveGoalBlock(
  // readGoals(...)) trio, now behind one door) + kbBlock/entityBlock (new —
  // see that file's buildTurnContext doc for why memories stay out of this
  // call and come from assembleTurnContext below instead).
  const turnCtx = await buildTurnContext(admin, cfg.userId, incoming.message)
  const { summaryBlock, memoryBlock, recentMessages } = await assembleTurnContext(admin, cfg, incoming.message)
  const sys = systemPrompt(
    enabledAgentsSet(incoming.turnConfig),
    turnCtx.mcpBlock,
    turnCtx.standingBlock,
    turnCtx.goalsBlock,
    summaryBlock,
    memoryBlock,
    turnCtx.kbBlock,
    turnCtx.entityBlock
  )

  return {
    messages: recentMessages,
    objective: incoming.message,
    trace: [],
    pendingDirective: undefined,
    pendingAction: undefined,
    runToolUsed: false,
    researchCompanyCount: 0,
    askRedirectUsed: false,
    awaitingTurn: false,
    finalMessage: undefined,
    turnConfig: incoming.turnConfig,
    sys,
    threadLinked: true,
    pendingIncomingMessage: undefined,
    wireEvents: [],
  }
}

// --- Nodes ---------------------------------------------------------------

async function loadContext(state: CopilotStateType, config: LangGraphRunnableConfig): Promise<Partial<CopilotStateType>> {
  const cfg = configurableOf(config)
  const admin = createAdminClient()

  let incoming: { message: string; turnConfig: CopilotTurnConfig }
  if (state.awaitingTurn) {
    // Nothing precedes this call — see the STATEGRAPH GOTCHA note atop this
    // file. `resume` is always a `message` payload here: dispatch is what
    // handles confirm/review/ask resumes, never this node.
    const resumed = interrupt({ kind: 'next_turn' }) as { message: string; turnConfig: CopilotTurnConfig }
    incoming = resumed
  } else if (!state.threadLinked) {
    // Genuinely the very first turn of a brand-new thread — the only
    // legitimate reason to be here with awaitingTurn still false.
    incoming = { message: state.pendingIncomingMessage ?? '', turnConfig: state.turnConfig }
  } else {
    // Defense-in-depth, not the normal path (NO_RETRY plus this graph's own
    // per-node design keeps `next` correctly pointing at whichever task is
    // genuinely still pending — see the pending_dispatch/reconfirm comment
    // in dispatchExecute for the specific hazard that drove that decision).
    // But if this thread's checkpoint EVER does land here — already linked,
    // awaitingTurn still false, no genuine next_turn interrupt in play —
    // silently falling into beginTurn would wipe this turn's whole
    // accumulated state (trace/objective/messages) and replan from an EMPTY
    // message, or risk attaching a resume to whatever the model happens to
    // be mid-way through with no new confirmation. Refusing outright,
    // loudly, is the safe choice: the route's existing whole-turn catch
    // surfaces this as a typed error/final event (never silently swallowed)
    // instead of guessing. ponytail: a fresh conversation (or this route's
    // existing editMessageId abandon-and-restart path) is the upgrade path
    // for a thread that actually lands here — a graph-level "reattach"
    // recovery is out of scope for this fix.
    throw new Error(
      `copilot graph: thread ${cfg.threadId} reached START with no genuine next_turn to resume and no other task queued — refusing to silently replan from an empty message or replay an unconfirmed action.`
    )
  }
  return beginTurn(admin, cfg, state, incoming)
}

async function plan(state: CopilotStateType, config: LangGraphRunnableConfig): Promise<Partial<CopilotStateType>> {
  const cfg = configurableOf(config)
  const admin = createAdminClient()
  const apiKeys = await loadApiKeys(admin, cfg.userId)

  // Fresh per-HTTP-request budget (spec item 4 + the pre-port route's own
  // "a multi-request resumed turn effectively gets a fresh budget each time
  // it continues"): config.configurable.runId is minted fresh by
  // invokeGraphForUser on every call, so comparing it against the last runId
  // this node saw is how a NEW request is told apart from another planning
  // iteration within the SAME request, with no extra plumbing.
  const freshRequest = cfg.runId !== state.lastRunId
  const stepsThisRunAttempt = freshRequest ? 0 : state.stepsThisRunAttempt
  const deadlineAt = freshRequest ? Date.now() + TIME_BUDGET_MS : state.deadlineAt
  const remaining = () => deadlineAt - Date.now()

  if (stepsThisRunAttempt >= MAX_STEPS || remaining() < FINAL_RESERVE_MS) {
    // Budget exhausted: compose the SAME forced-final text the pre-port
    // route computed after its loop (one more LLM summary if there's a
    // little time, else the deterministic recap) and route through the
    // normal dispatch->finalize->loadContext turn boundary — see DEADLINE
    // HANDLING at the top of this file for why this deliberately does not
    // call interrupt() itself.
    let message: string | undefined
    if (remaining() > 2_000) {
      try {
        const res = await callLlm(
          apiKeys,
          {
            system: state.sys,
            messages: buildMessages(
              state.messages,
              state.trace,
              state.objective,
              'You are out of tool budget for this turn. Respond NOW with {"action":"final","message":"..."} summarizing what you found and any next step for the user. Do not call another tool.'
            ),
            model: state.turnConfig.model,
            json: true,
            maxTokens: 1200,
            temperature: 0.2,
          },
          config.signal
        )
        const parsed = parseJsonLoose<ModelAction>(res.content)
        if (typeof parsed.message === 'string' && parsed.message.trim()) message = scrubJargon(parsed.message)
      } catch {
        // fall through to the deterministic recap
      }
    }
    return {
      pendingAction: { action: 'final', message: message ?? fallbackSummary(state.trace) },
      lastRunId: cfg.runId,
      stepsThisRunAttempt,
      deadlineAt,
      wireEvents: [],
    }
  }

  const wireEvents: WireEvent[] = []
  let action: ModelAction
  try {
    const res = await callLlm(
      apiKeys,
      {
        system: state.sys,
        messages: buildMessages(state.messages, state.trace, state.objective, state.pendingDirective),
        model: state.turnConfig.model,
        json: true,
        maxTokens: 4000,
        temperature: 0.2,
        reasoning: { effort: state.turnConfig.effort },
      },
      config.signal
    )
    if (res.reasoning) wireEvents.push({ type: 'reasoning', step: state.trace.length, reasoning: scrubJargon(res.reasoning) })
    action = parseJsonLoose<ModelAction>(res.content)
  } catch (e) {
    // Planning failed OR the user hit Stop — let it propagate. The adapter's
    // catch block (see app/api/copilot/route.ts) recovers state.trace via
    // getGraphStateForUser to build the SAME fallback the pre-port route's
    // own catch block did; nothing here can safely turn this into a state
    // update (a thrown node produces no checkpointed update — see the file
    // header's empirical note on real error/throw behavior).
    throw e
  }

  const thought = typeof action.thought === 'string' ? scrubJargon(action.thought) : undefined
  return {
    pendingAction: { ...action, thought },
    pendingDirective: undefined,
    lastRunId: cfg.runId,
    stepsThisRunAttempt: stepsThisRunAttempt + 1,
    deadlineAt,
    wireEvents,
  }
}

async function dispatch(state: CopilotStateType, config: LangGraphRunnableConfig): Promise<Partial<CopilotStateType>> {
  const cfg = configurableOf(config)
  const action = state.pendingAction
  const step = state.trace.length
  const remaining = () => state.deadlineAt - Date.now()

  if (!action) {
    // Defensive only — plan always sets pendingAction before routing here.
    return { pendingAction: undefined, wireEvents: [] }
  }

  // --- final --------------------------------------------------------------
  if (action.action === 'final' || (!action.tool && !action.question && typeof action.message === 'string')) {
    return { finalMessage: scrubJargon(action.message ?? '(no answer)'), trace: state.trace, wireEvents: [] }
  }

  // --- structured multi-question ask form ----------------------------------
  if (action.action === 'ask' && Array.isArray(action.questions)) {
    // parseAskUserRequest is the only part of this branch that can throw a
    // real validation error (AskUserError) — it stays in its own try/catch,
    // strictly BEFORE and OUTSIDE the interrupt() call below. LangGraph's
    // own interrupt() doc is explicit: it propagates by THROWING a special
    // GraphInterrupt, so a try/catch wrapped around the call (as this branch
    // used to have) silently swallows the pause itself, turning every
    // ask_form into a fake "invalid question form" error instead of ever
    // reaching the user — caught by this fix round's own regression test.
    let questions: AskQuestion[]
    try {
      const parsed = parseAskUserRequest(action as unknown)
      questions = parsed.questions.map((q) => ({
        header: scrubJargon(q.header),
        question: scrubJargon(q.question),
        multiSelect: q.multiSelect,
        // Wire field is `detail`, not the parsed AskQuestion's own
        // `description` — see AskOption above and question-form.tsx's
        // FormQuestion type, which reads `.detail`. Losing this rename was
        // a fix-round-caught wire contract break.
        options: q.options.map((o) => ({ label: scrubJargon(o.label), ...(o.description ? { detail: scrubJargon(o.description) } : {}) })),
      }))
    } catch (err) {
      const message = err instanceof AskUserError ? err.message : 'The question form was invalid.'
      return {
        trace: [...state.trace, { tool: 'ask_user', args: action as Record<string, unknown>, thought: action.thought, observation: { error: message }, ok: false, status: 'error' }],
        pendingAction: undefined,
        wireEvents: [],
      }
    }
    const resume = interrupt({ kind: 'ask_form', step, questions }) as CopilotResume
    if (isMessageResume(resume)) return beginTurn(createAdminClient(), cfg, state, resume)
    const answer = 'answer' in resume && typeof resume.answer === 'string' && resume.answer ? resume.answer : '(no answer provided)'
    return {
      trace: [...state.trace, { tool: 'ask_user', args: { questions }, thought: action.thought, observation: { answer }, ok: true, status: 'ok' }],
      pendingAction: undefined,
      wireEvents: [],
    }
  }

  // --- legacy single-question ask -------------------------------------------
  if (action.action === 'ask' && typeof action.question === 'string' && action.question.trim()) {
    // Ask-redirect gate: reject the ask ONCE and send it back to actually
    // look up a discoverable company fact instead of guessing/asking — see
    // the pre-port route's identical comment for the full rationale.
    if (
      !state.askRedirectUsed &&
      state.researchCompanyCount < RESEARCH_COMPANY_MAX_PER_TURN &&
      COMPANY_FACT_SIGNAL.test(state.objective) &&
      !state.trace.some((t) => t.tool === 'research_company' || t.tool === 'research_companies' || t.tool === 'get_dossier')
    ) {
      return {
        askRedirectUsed: true,
        pendingAction: undefined,
        trace: [
          ...state.trace,
          {
            tool: 'ask',
            args: { question: action.question.trim() },
            thought: action.thought,
            observation: {
              redirected: true,
              reason:
                'Not yet — the objective names a funding-stage/visa fact and you have not called ' +
                'research_company, research_companies, or get_dossier this turn, with research budget ' +
                'still available. Look it up for the specific companies still in play (use the companyId ' +
                'values already returned by source_jobs/list_jobs — research_companies takes several at ' +
                'once) instead of asking or guessing, then decide with what you find. Only ask again if ' +
                'something genuinely stays ambiguous after that.',
            },
            ok: false,
            status: 'skipped',
          },
        ],
        wireEvents: [],
      }
    }

    const question = scrubJargon(action.question.trim())
    const rawOptions = Array.isArray(action.options) ? action.options : []
    const options = rawOptions
      .filter((o): o is AskOption => Boolean(o) && typeof o === 'object' && typeof o.label === 'string' && o.label.trim().length > 0)
      .slice(0, 6)
      .map((o) => ({ label: scrubJargon(o.label.trim()), ...(o.detail && o.detail.trim() ? { detail: scrubJargon(o.detail.trim()) } : {}) }))
    const resume = interrupt({ kind: 'ask', step, question, ...(options.length ? { options } : {}) }) as CopilotResume
    if (isMessageResume(resume)) return beginTurn(createAdminClient(), cfg, state, resume)
    const answer = 'answer' in resume && typeof resume.answer === 'string' && resume.answer ? resume.answer : '(no answer provided)'
    return {
      trace: [...state.trace, { tool: 'ask_user', args: { question, options }, thought: action.thought, observation: { answer }, ok: true, status: 'ok' }],
      pendingAction: undefined,
      wireEvents: [],
    }
  }

  // --- tool call: (1) validity, (2) wall-clock/count gates only. ------------
  //
  // Split from the actual interrupt-and-execute step (dispatchExecute below)
  // for one reason: the pre-port route sends a 'thought' wire event for
  // EVERY tool call, including ones that go on to pause — and a value
  // computed before interrupt() throws is NEVER checkpointed (a thrown node
  // produces no state update at all — see the file header's empirical note).
  // So 'thought' has to be returned from a node that completes normally,
  // strictly before whichever node might interrupt. Nothing below has any
  // external effect — this node ends by ROUTING to dispatchExecute rather
  // than calling it, never falling through into it.
  if (action.action === 'tool' && typeof action.tool === 'string') {
    const tool = action.tool
    const args = (action.args ?? {}) as Record<string, unknown>
    const thought = action.thought
    const wireEvents: WireEvent[] = thought ? [{ type: 'thought', step, thought }] : []

    if (!isValidTool(tool) && !isMcpToolName(tool)) {
      return {
        trace: [...state.trace, { tool, args, thought, observation: { error: `Unknown tool "${tool}"` }, ok: false, status: 'error' }],
        pendingAction: undefined,
        wireEvents,
      }
    }

    if (tool === 'research_company') {
      if (state.researchCompanyCount >= RESEARCH_COMPANY_MAX_PER_TURN) {
        return {
          trace: [
            ...state.trace,
            {
              tool,
              args,
              thought,
              observation: { error: `skipped: already researched ${RESEARCH_COMPANY_MAX_PER_TURN} companies this turn — enough to answer with. Report what you found instead of researching more.`, skipped: true },
              ok: false,
              status: 'skipped',
            },
          ],
          pendingAction: undefined,
          wireEvents,
        }
      }
      if (remaining() < RUN_MIN_MS) {
        return {
          trace: [...state.trace, { tool, args, thought, observation: { error: 'skipped: not enough time left this turn to research another company. Give a final answer now with what you have.', skipped: true }, ok: false, status: 'skipped' }],
          pendingAction: undefined,
          wireEvents,
        }
      }
    } else if (isRunTool(tool)) {
      if (state.runToolUsed) {
        return {
          trace: [...state.trace, { tool, args, thought, observation: { error: 'skipped: only one background run per turn. Summarize what you have or ask the user to run this next.', skipped: true }, ok: false, status: 'skipped' }],
          pendingAction: undefined,
          wireEvents,
        }
      }
      if (remaining() < RUN_MIN_MS) {
        return {
          trace: [...state.trace, { tool, args, thought, observation: { error: 'skipped: not enough time left this turn to run a long task. Give a final answer now; the user can ask again to run it.', skipped: true }, ok: false, status: 'skipped' }],
          pendingAction: undefined,
          wireEvents,
        }
      }
    } else if ((isActTool(tool) || isMcpToolName(tool)) && remaining() < ACT_MIN_MS) {
      return {
        trace: [...state.trace, { tool, args, thought, observation: { error: 'skipped: low on time. Provide a final answer with what you have.', skipped: true }, ok: false, status: 'skipped' }],
        pendingAction: undefined,
        wireEvents,
      }
    }

    // Validated and budget-cleared — hand off to dispatchExecute for (3)-(5).
    return { pendingAction: { ...action, tool, args, thought }, wireEvents }
  }

  // --- unparseable / empty action ---------------------------------------------
  if (typeof action.message === 'string') {
    return { finalMessage: scrubJargon(action.message), trace: state.trace, wireEvents: [] }
  }
  return {
    trace: [...state.trace, { tool: '(none)', args: {}, observation: { error: 'model returned no valid action' }, ok: false, status: 'error' }],
    pendingAction: undefined,
    wireEvents: [],
  }
}

/**
 * Durable, outside-the-checkpoint claim for one (thread, step, tool)
 * dispatch — see this file's header and the pending_dispatch migration for
 * why this exists. Returns true when THIS call won the claim (safe to call
 * dispatchTool), false when a claim for the SAME step already exists (an
 * earlier attempt got at least this far and its outcome is unknown — never
 * guessed at; see dispatchExecute's `!claimedNow` branch for why that case
 * ends the task outright rather than trying to claim again). DB errors
 * throw (fail closed) — this guards an approved, possibly irreversible
 * call, so a failure here must never be silently treated as "safe to
 * proceed".
 */
async function claimDispatch(admin: AdminClient, threadId: string, step: number, tool: string): Promise<boolean> {
  const { data, error } = await admin.from('graph_threads').select('pending_dispatch').eq('thread_id', threadId).maybeSingle()
  if (error) throw new Error(`graph_threads pending_dispatch read failed for thread ${threadId}: ${error.message}`)
  const existing = (data as { pending_dispatch: { step: number; tool: string } | null } | null)?.pending_dispatch ?? null
  if (existing && existing.step === step) return false
  const { error: writeError } = await admin.from('graph_threads').update({ pending_dispatch: { step, tool } }).eq('thread_id', threadId)
  if (writeError) throw new Error(`graph_threads pending_dispatch claim failed for thread ${threadId}: ${writeError.message}`)
  return true
}

/**
 * (3) UNCONDITIONAL submit/send guard, (4) review/bypass, (5) the one real
 * side effect in this whole graph — see this file's header for the replay-
 * safety argument (everything above the interrupt() calls below is pure).
 * Only reached via dispatch's "validated and budget-cleared" return, so
 * `state.pendingAction` here is always a well-formed {tool,args} pair.
 */
async function dispatchExecute(state: CopilotStateType, config: LangGraphRunnableConfig): Promise<Partial<CopilotStateType>> {
  const cfg = configurableOf(config)
  const action = state.pendingAction as ModelAction & { tool: string; args: Record<string, unknown> }
  const tool = action.tool
  const args = action.args
  const thought = action.thought
  const step = state.trace.length
  const admin = createAdminClient()

  const submitReason = submitOrSendReason(tool, args)
  const bypassSkipsReview = state.turnConfig.bypassMode && !submitReason && (isReadTool(tool) || isActTool(tool))
  if (submitReason || (state.turnConfig.thinkingMode === 'review' && !bypassSkipsReview)) {
    const resumed = interrupt({
      kind: submitReason ? 'confirm' : 'review',
      step,
      tool,
      args,
      thought: thought ?? '',
      ...(submitReason ? { reason: submitReason } : {}),
    }) as CopilotResume
    if (isMessageResume(resumed)) return beginTurn(admin, cfg, state, resumed)

    const guarded = Boolean(submitReason)
    const approved = 'approved' in resumed && resumed.approved === true
    const confirmed = guarded && approved && 'confirmed' in resumed && resumed.confirmed === true
    const directive = 'approved' in resumed && resumed.approved === false ? resumed.directive : undefined

    if (guarded && !confirmed) {
      // Irreversible action, not confirmed — record it honestly and let
      // plan replan, folding in a directive if one was sent alongside.
      return {
        trace: [...state.trace, { tool, args, thought, observation: { error: 'Not confirmed by the user — this action was not performed.' }, ok: false, status: 'error' }],
        pendingDirective: directive || undefined,
        pendingAction: undefined,
        wireEvents: [],
      }
    }
    if (!guarded && directive) {
      // Non-empty directive on a plain review pause: drop the pending call,
      // replan with the directive as a trailing instruction.
      return { pendingDirective: directive, pendingAction: undefined, wireEvents: [] }
    }
    // Approved (empty directive on a plain pause, or an explicitly
    // confirmed guarded pause) — before the one real side effect in this
    // graph, durably claim this exact dispatch. A StateGraph node replays
    // its WHOLE body on resume, including everything after an
    // already-consumed interrupt() (see this file's header): without this,
    // a crash strictly between dispatchTool resolving and this node's own
    // return committing to the checkpoint would silently re-fire an
    // already-approved call on the next continuation, with no new
    // confirmation. Finding no claim means this is the first attempt —
    // proceed. Finding one for the SAME step means an earlier attempt
    // already got at least this far and its outcome is unknown — see the
    // `!claimedNow` branch below for why this ends the task honestly
    // instead of trying to ask again in-place.
    const claimedNow = await claimDispatch(admin, cfg.threadId, step, tool)
    if (!claimedNow) {
      // Do NOT call interrupt() again here — verified empirically (a
      // fix-round probe against the real runtime) that a SECOND interrupt()
      // call within this same task can still be silently satisfied by the
      // ORIGINAL Command({resume}) value: LangGraph's "null resume"
      // bookkeeping is durable and is never marked consumed by a failed
      // attempt, so it stays available to whichever interrupt() call site
      // is reached next — including a brand-new one that was never meant to
      // answer it. A second interrupt() here would silently re-approve
      // itself with the SAME stale value, defeating this guard entirely.
      // Ending the task normally (no interrupt, no throw) is what actually
      // closes the hole: this commits a real "not confirmed" trace entry
      // and routes to plan, which can only reach dispatchTool again through
      // a genuinely NEW model turn and a genuinely NEW confirm interrupt.
      return {
        trace: [
          ...state.trace,
          {
            tool,
            args,
            thought,
            observation: {
              error: `A previous attempt to run "${tool}" was interrupted before its outcome was known — it was NOT repeated. Ask the user to explicitly confirm again if this should still happen.`,
            },
            ok: false,
            status: 'error',
          },
        ],
        pendingDirective: undefined,
        pendingAction: undefined,
        wireEvents: [],
      }
    }
  }

  const apiKeys = await loadApiKeys(admin, cfg.userId)
  const toolCtx: CopilotToolContext = {
    admin,
    userId: cfg.userId,
    userEmail: state.turnConfig.userEmail,
    apiKeys,
    signal: config.signal,
    enabledAgents: enabledAgentsSet(state.turnConfig),
  }
  const wireEvents: WireEvent[] = [{ type: 'tool_call', step, tool, args }]
  const observation = await dispatchTool(toolCtx, tool, args)
  const isError = Boolean(observation && typeof observation === 'object' && 'error' in (observation as Record<string, unknown>))
  wireEvents.push({ type: 'observation', step, tool, observation: observationForWire(observation) })

  return {
    trace: [...state.trace, { tool, args, thought, observation, ok: !isError, status: isError ? 'error' : 'ok' }],
    pendingAction: undefined,
    runToolUsed: isRunTool(tool) ? true : state.runToolUsed,
    researchCompanyCount: tool === 'research_company' ? state.researchCompanyCount + 1 : state.researchCompanyCount,
    wireEvents,
  }
}

function routeAfterDispatch(state: CopilotStateType): 'plan' | 'finalize' | 'dispatchExecute' {
  if (typeof state.finalMessage === 'string') return 'finalize'
  // dispatch hands off a validated tool call by leaving pendingAction set
  // (with `tool` present); every other dispatch outcome clears it.
  if (state.pendingAction && typeof state.pendingAction.tool === 'string') return 'dispatchExecute'
  return 'plan'
}

async function finalize(state: CopilotStateType, config: LangGraphRunnableConfig): Promise<Partial<CopilotStateType>> {
  // Persistence (copilot_messages, copilot_conversations.updated_at) is the
  // ADAPTER's job (app/api/copilot/route.ts), reading `finalMessage`/`trace`
  // off this node's own chunk in real time — see spec item 3. `trace` is
  // passed through explicitly (unchanged) because 'updates' streamMode only
  // ships what a node's return object actually contains.
  //
  // `messages` gets the assistant's own answer appended here so THIS turn's
  // own remaining plan calls (there are none after finalize, but a resumed
  // continuation of the SAME checkpoint before the next beginTurn would see
  // it) never see a dangling final user turn with no reply. beginTurn
  // rebuilds `messages` fresh from copilot_messages + the rolling summary +
  // memory search every new turn (see assembleTurnContext) — it does NOT
  // keep growing this array across turns, so this append's lifetime is only
  // "until the next beginTurn runs".
  const messages = state.finalMessage ? [...state.messages, { role: 'assistant' as const, content: state.finalMessage }] : state.messages

  if (state.finalMessage) await addTurnToMemory(state, config)

  return { finalMessage: state.finalMessage, trace: state.trace, awaitingTurn: true, messages, wireEvents: [] }
}

/**
 * Post-turn MemoryStore.add on the user+assistant pair (Step 7 of the
 * memory build) — cheap model, capped input (MEMORY_ADD_CHAR_CAP), metered
 * through loadApiKeys same as every other MemoryStore call. Best-effort:
 * mem0/DB trouble here must not turn a successfully answered turn into a
 * failed one — the user already has their answer by the time this runs.
 */
async function addTurnToMemory(state: CopilotStateType, config: LangGraphRunnableConfig): Promise<void> {
  const cfg = configurableOf(config)
  try {
    await getMemoryStore().add(cfg.userId, {
      messages: [
        { role: 'user', content: state.objective.slice(0, MEMORY_ADD_CHAR_CAP) },
        { role: 'assistant', content: (state.finalMessage ?? '').slice(0, MEMORY_ADD_CHAR_CAP) },
      ],
      scope: 'copilot',
      isDemo: state.turnConfig.isDemo,
    })
  } catch (e) {
    if (e instanceof DemoMemoryWriteRefusedError) return
    console.error(`[graph] copilot: memory add failed for thread ${cfg.threadId}, continuing without it: ${(e as Error).message}`)
  }
}

// --- Graph -----------------------------------------------------------------

// NO AUTOMATIC RETRIES — LangGraph's own default (`retryPolicy.maxAttempts`
// defaults to 3 when unset, `@langchain/langgraph/dist/pregel/retry.js`)
// silently re-runs a failing task's WHOLE BODY up to twice more, WITHIN the
// same invoke()/stream() call, before ever surfacing the error. Verified
// empirically (a fix-round probe against the real runtime) that this is
// actively dangerous here: a retried dispatchExecute attempt can consume the
// SAME already-delivered Command({resume}) value a SECOND time — not just
// for the interrupt() call it originally answered, but for a LATER,
// different interrupt() call reached later in that same retried attempt
// (LangGraph's "null resume" bookkeeping isn't consumed at the source across
// attempts) — silently re-approving an already-answered guarded confirm
// with no new user input at all. `maxAttempts: 1` on every node makes a
// thrown (non-interrupt) error propagate on the FIRST attempt, always —
// the only replay-safe setting for a graph where a node's tail is a real,
// possibly-irreversible side effect.
const NO_RETRY = { retryPolicy: { maxAttempts: 1 } }

export const copilotGraph = new StateGraph(CopilotState)
  .addNode('loadContext', loadContext, NO_RETRY)
  .addNode('plan', plan, NO_RETRY)
  .addNode('dispatch', dispatch, NO_RETRY)
  .addNode('dispatchExecute', dispatchExecute, NO_RETRY)
  .addNode('finalize', finalize, NO_RETRY)
  .addEdge(START, 'loadContext')
  .addEdge('loadContext', 'plan')
  .addEdge('plan', 'dispatch')
  .addConditionalEdges('dispatch', routeAfterDispatch, { plan: 'plan', finalize: 'finalize', dispatchExecute: 'dispatchExecute' })
  .addEdge('dispatchExecute', 'plan')
  .addEdge('finalize', 'loadContext')
  .compile({ checkpointer: true })
