// POST /api/copilot — Cello Copilot, a Claude-Code-style tool-calling loop.
//
// The model plans, calls ONE tool per turn, observes the result, and iterates
// until it answers or we hit the step/time budget. It talks a tiny JSON protocol
// (no OpenAI-native tool_calls — the harness llm.ts is import-only here), and we
// keep a real turn-by-turn message history: each assistant action and each tool
// observation is appended as its own message, so the model reasons over the true
// transcript instead of one re-serialized blob.
//
// WIRE CONTRACT: this route streams Server-Sent Events (text/event-stream).
// Every event is `data: <json>\n\n`; the stream always ends with the literal
// line `data: [DONE]\n\n`. Event shapes:
//   {"type":"conversation","conversationId":string,"title":string}   // always first
//   {"type":"reasoning","step":number,"reasoning":string}
//   {"type":"thought","step":number,"thought":string}
//   {"type":"tool_call","step":number,"tool":string,"args":object}
//   {"type":"observation","step":number,"tool":string,"observation":string}  // truncated to 2000 chars
//   {"type":"paused","step":number,"thought":string,"tool":string,"args":object,
//    "requiresConfirmation"?:true,"reason"?:string}
//   {"type":"question","step":number,"question":string,"options"?:{"label":string,"detail"?:string}[]}
//   {"type":"final","message":string}
//   {"type":"error","error":string,"needsKey"?:true}
// Errors that happen BEFORE we start streaming (bad auth, bad model) are plain
// JSON responses instead — see the early returns in POST. Once streaming has
// started we never fall back to a JSON response; everything becomes an
// `error` event so the client always gets a clean [DONE].
//
// REVIEW MODE (thinkingMode: 'review'): the loop pauses immediately before
// dispatching a tool call that has cleared validity/budget gating — it emits
// `paused` instead of executing, persists an in-progress "sentinel" assistant
// message (trace ending in a `status: 'paused'` entry, empty content) so the
// pending action survives past this HTTP request, and ends the stream. The
// client resumes by POSTing again with the same conversationId and a
// `directive` (even "" counts — presence of the field is what marks this as a
// resume, per the API contract). On resume we load that sentinel, delete it
// (it's being superseded), and:
//   - directive is empty/whitespace ("approve as-is"): execute the pending
//     tool exactly as planned, append its real observation, keep looping.
//   - directive is non-empty: DROP the pending tool call and instead hand the
//     directive to the model as one extra trailing instruction (this is
//     exactly what buildMessages(convo, trace, objective, directive) already
//     supports) so it can replan with the user's course-correction in view.
// A pending tool call flagged `requiresConfirmation` (see submitOrSendReason
// below) is the ONE exception to "empty directive == approve as-is": it is
// UNCONDITIONAL and independent of thinkingMode/bypassMode — an empty
// directive on a guarded pause is never treated as approval; only
// `confirmToolCall: true` on the resume request dispatches it.
// MAX_STEPS/TIME_BUDGET_MS are scoped to a single HTTP request; a multi-request
// resumed turn effectively gets a fresh budget each time it continues.
//
// ASK (action:"ask"): the model can stop and ask instead of guessing when the
// answer would genuinely change what it does next. Handled exactly like a
// review-mode pause structurally (a sentinel assistant message ending the
// turn/request) but semantically different in two ways: (1) it is NEVER
// gated by thinkingMode/bypassMode — asking is always allowed; and (2) unlike
// a tool-pause sentinel, an ask sentinel is NOT hidden from the client's GET
// listing, so a reload shows the pending question, and once answered the
// resolved {question, options, answer} lives in the eventual final message's
// trace so reloading shows both sides of the exchange. Resume contract is the
// same `directive` field: the directive text (or '(no answer provided)' if
// empty) becomes the answer.
//
// BYPASS MODE (bypassMode: true, persisted per-conversation as
// copilot_conversations.bypass_mode): skips the review-mode pause for READ
// and ACT tool calls only (reversible, draft-producing). It can NEVER skip
// the submitOrSendReason() guard below — that check runs unconditionally,
// before thinkingMode/bypassMode are even consulted, so a client-supplied
// bypassMode:true cannot unlock a submit/send action. See submitOrSendReason.
//
// Budget discipline (maxDuration = 300s):
//   - MAX_STEPS bounds the loop.
//   - A wall-clock budget gates work: we stop planning new turns with enough
//     headroom to still summarize, and we gate heavy `run` tools (whole-DAG
//     trigger_run, capped at one per turn; live-fetch research_company, capped
//     at RESEARCH_COMPANY_MAX_PER_TURN so a goal that names several companies
//     can actually research more than one of them inline) and only start one
//     when there is time left to finish it. When time runs low we force a
//     final answer (LLM summary if possible, else a deterministic recap).
//
// GOAL-HOLDING: the loop carries the user's standing objective (see
// lastUserMessage below) through every planning call, structurally — not just
// as a line in the system prompt. buildMessages re-states it as the LAST
// message the model sees before every single decision, alongside a compact
// recap of what has already been tried this turn (see objectiveReminder), so
// each step is judged against "does this close the gap on what was asked" —
// not just "what does the last tool result suggest I do." This is what makes
// broadening a search or going to research a fact the model's own next move
// instead of a question handed back to the user.
//
// PERSISTENCE: history is loaded from the DB (last 24 messages), never trusted
// from the client. The user's message is persisted at the start of a new turn;
// the assistant's answer (or a pause/ask sentinel, or an error recap) plus the
// full tool trace is persisted at the end — see supabase/migrations/
// 20260728000003_copilot_conversations.sql,
// 20260728000006_copilot_bypass_mode.sql and lib/harness/copilot-store.ts. An
// aborted turn (client Stop, or any other mid-loop failure) is caught by the
// top-level try/catch in the stream body and persists the same way — see the
// comment on that catch block.
//
// EDIT + RE-RUN: POST with `editMessageId` set to a previously-persisted user
// message's id deletes that message and everything after it
// (copilot-store.ts deleteMessagesFrom), then runs `message` as a fresh turn
// from that point — the client's confirm step is what makes this safe, this
// route just executes it.
//
// LLM: the user's saved OpenRouter key. Model is resolved as
// request.model (validated against ALLOWED_MODELS) -> the conversation's
// stored model -> callLlm's own per-user-preference/default fallback.
// Degrades gracefully with no key (never a 500).

import { AskUserError, parseAskUserRequest } from '@/lib/harness/ask-user'
import {
  formatStandingPreferences,
  readStandingPreferences,
} from '@/lib/harness/standing-preferences'
import { randomUUID } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { loadApiKeys } from '@/lib/harness/keys'
import { callLlm, parseJsonLoose } from '@/lib/harness/llm'
import { REASONING_EFFORTS, type ReasoningEffort } from '@/lib/harness/types'
import { canRunLlm, missingOpenRouterMessage } from '@/lib/harness/llm-key-message'
import {
  dispatchTool,
  toolsPromptBlock,
  isValidTool,
  isRunTool,
  isActTool,
  isReadTool,
  isMcpToolName,
  mcpToolsPromptBlock,
  type CopilotToolContext,
} from '@/lib/harness/copilot-tools'
import { isStepAgentType, type StepAgentType } from '@/lib/harness/copilot-tool-catalog'
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
  type MessageRow,
} from '@/lib/harness/copilot-store'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Bumped from 12: a goal that genuinely needs to broaden a search once or
// twice AND research a handful of companies AND score a batch — i.e. an
// ordinary compound ask like "find/rank/research N roles matching X, Y, Z" —
// easily uses 8-10 steps once the loop is actually driving toward the goal
// instead of stopping at the first empty result. Still a hard, small ceiling;
// see the wall-clock budgets below for the other axis this is bounded on.
const MAX_STEPS = 18
/** Total wall-clock budget for a single HTTP request's slice of the turn. */
const TIME_BUDGET_MS = 280_000
/** Reserve for one final summarizing LLM call before we stop planning. */
const FINAL_RESERVE_MS = 8_000
/** Minimum remaining time to START a heavy `run` tool (they can take ~55s). */
const RUN_MIN_MS = 42_000
/** Minimum remaining time to start an `act` tool (a few LLM seconds). */
const ACT_MIN_MS = 12_000
/** research_company gets its own small per-turn allowance instead of the
 *  single-shot cap shared by trigger_run — see the dispatch gating below for
 *  why. Bounded so a goal that names many companies can't turn into
 *  researching all of them inline; RUN_MIN_MS still gates each individual call
 *  by remaining wall-clock time on top of this count. */
const RESEARCH_COMPANY_MAX_PER_TURN = 4

/**
 * Company-fact signal: funding stage / visa-sponsorship language in the
 * user's own ask. When present, those facts are get_dossier's/research_company's
 * job (see the systemPrompt "ACT, DO NOT DEFER" rule) — never a question. This
 * backs a one-shot, code-level gate (see the "ask" branch below) on top of the
 * prompt instruction, because the prompt alone was observed to still let the
 * model guess a funding stage internally and then stop on a question anyway
 * (e.g. "Series B+ ... sponsor H1b" -> asked instead of calling research_company
 * even with RESEARCH_COMPANY_MAX_PER_TURN budget untouched).
 */
const COMPANY_FACT_SIGNAL = /\b(series\s*[a-e]\b|funding|funded|valuation|ipo\b|acquir\w*|sponsor\w*|visa|h-?1b|stage\b|headcount|raised)\b/i

type ChatMessage = { role: 'user' | 'assistant'; content: string }

interface AskOption {
  label: string
  detail?: string
}

interface TraceEntry {
  tool: string
  args: Record<string, unknown>
  thought?: string
  observation: unknown
  ok: boolean
  status: 'ok' | 'error' | 'skipped' | 'paused' | 'ask'
  /**
   * Only meaningful when status is 'paused'. True when this pause is the
   * unconditional submit/send confirmation guard (submitOrSendReason) rather
   * than a plain review-mode pause — resuming a guarded pause with an empty
   * directive must NEVER be treated as approval; only an explicit
   * `confirmToolCall: true` on the resume request does.
   */
  requiresConfirmation?: boolean
}

interface ModelAction {
  action?: string
  tool?: string
  args?: Record<string, unknown>
  thought?: string
  message?: string
  /** action:"ask" */
  question?: string
  options?: AskOption[]
}

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

/** The observation as sent over the wire: a string, truncated to 2000 chars. */
function observationForWire(obs: unknown): string {
  const s = typeof obs === 'string' ? obs : JSON.stringify(obs)
  return s.length > 2000 ? s.slice(0, 2000) : s
}

/**
 * Backstop for the model's own free-text ("ask" questions, "final" answers):
 * the systemPrompt "NEVER LEAK INTERNAL MACHINERY" rule is the primary fix,
 * but a prompt instruction alone is not a guarantee — the model's context is
 * saturated with the word "dossier" via the tool catalog (get_dossier, table
 * name, etc.), and this is the literal, confirmed defect from a real
 * transcript (user asked about funding stages, got told a "dossier came back
 * partial" and replied "wdym dossier?"). Mirrors
 * components/copilot/observation-view.tsx's humanize() for the structured
 * step-card view; this is the equivalent guard for the model's own prose
 * before it ever reaches the client.
 */
function scrubJargon(text: string): string {
  return text.replace(/\bdossiers?\b/gi, (m) => (m[0] === m[0].toUpperCase() ? 'Company research' : 'company research'))
}

/** True when a persisted assistant message is a review-mode pause sentinel
 *  (a tool call that never ran — plain pause or a guarded confirmation). */
function isPausedSentinel(m: MessageRow): boolean {
  if (m.role !== 'assistant' || !Array.isArray(m.trace) || m.trace.length === 0) return false
  const last = m.trace[m.trace.length - 1] as Partial<TraceEntry> | undefined
  return last?.status === 'paused'
}

/** True when a persisted assistant message is a pending, unanswered question
 *  (action:"ask"). Unlike isPausedSentinel this is deliberately NOT excluded
 *  from the client's GET listing — a pending question should still be
 *  visible on reload so the user can answer it. */
function isAskSentinel(m: MessageRow): boolean {
  if (m.role !== 'assistant' || !Array.isArray(m.trace) || m.trace.length === 0) return false
  const last = m.trace[m.trace.length - 1] as Partial<TraceEntry> | undefined
  return last?.status === 'ask'
}

/**
 * The one place this route hard-enforces the bypass-mode boundary: a tool
 * call that looks like it would submit a job application to an employer or
 * send a message to a real person ALWAYS needs an explicit confirmation
 * round-trip (confirmToolCall: true on the resume request), regardless of
 * thinkingMode or bypassMode — both are read AFTER this check, never before,
 * so neither can short-circuit it. Returns a human-readable reason when
 * flagged, else null.
 *
 * The copilot's own built-in tool catalog has no direct "submit"/"send" tool
 * today (an application draft still needs a separate human approval via
 * /api/drafts/approve; draft_outreach only ever returns a preview) — so in
 * practice this guards two things: (1) any MCP tool (user-configured, name
 * and behavior both untrusted) whose name reads as a send/submit action, and
 * (2) trigger_run when the goal text itself explicitly asks to submit/apply/
 * send, since that is the one built-in path that can walk toward those DAG
 * stages (its own applier stage lands in application_drafts as
 * pending_review — never a live submission by itself — but the goal can
 * still ask for one, and this route never trusts the DAG's own gate as a
 * substitute for its own). Matching is deliberately broad on WORDS, not
 * exact phrases — a live test against this exact function caught a real
 * miss: a model-written goal of "apply via official ATS API to LightSight's
 * ... role" did not contain the literal phrase "apply to" the original
 * pattern required, only the standalone word "apply". False positives here
 * just cost one extra confirmation click; a false negative is a real-world,
 * irreversible side effect, so the asymmetry favors over-triggering.
 */
function submitOrSendReason(tool: string, args: Record<string, unknown>): string | null {
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

/**
 * `mcpBlock` is a pre-fetched (once per turn, see POST below) live listing of
 * the user's enabled MCP servers' tools, already framed with its own
 * untrusted-data safety preface by lib/mcp/registry.ts buildMcpPromptContext.
 * '' when the user has none configured/reachable — degrades silently to the
 * built-in-only prompt below.
 */
function systemPrompt(
  enabledAgents?: ReadonlySet<StepAgentType>,
  mcpBlock?: string,
  standingBlock?: string
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
${mcpBlock ? `\n${mcpBlock}\n` : ''}${standingBlock ? `\n${standingBlock}\n` : ''}
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

/** Find the most recent real user turn in the loaded/assembled chat history —
 *  this is what "the user's standing objective" resolves to structurally (see
 *  the GOAL-HOLDING note atop this file). `convo` never contains pause/ask
 *  sentinels (both are filtered before this is called), so the last user-role
 *  entry is always either the message that started this turn or the message
 *  that led into whatever pause/question this request is resuming — exactly
 *  the objective that must survive across every tool call in between. */
function lastUserMessage(convo: ChatMessage[]): string | undefined {
  for (let i = convo.length - 1; i >= 0; i--) {
    if (convo[i].role === 'user') return convo[i].content
  }
  return undefined
}

/**
 * The standing-objective reminder, re-derived fresh on every planning call
 * (never a static prompt line) and appended as the LAST message the model
 * sees before it decides. This is the structural half of GOAL-HOLDING: it
 * forces each step to be graded against the original ask plus what has
 * actually been tried so far, not just the shape of the most recent
 * observation — which is exactly the failure mode from the transcript this
 * loop was rebuilt to fix (one empty-ish tool result -> straight to asking).
 */
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

/** Build the running message history the model reasons over. `objective` is
 *  this turn's standing goal (see lastUserMessage) — re-stated as the final
 *  message every call so the model always decides against the goal, not just
 *  the last observation. See the GOAL-HOLDING note atop this file. */
function buildMessages(convo: ChatMessage[], trace: TraceEntry[], objective: string, directive?: string): ChatMessage[] {
  const messages: ChatMessage[] = [...convo]
  for (const t of trace) {
    if (t.status === 'paused' || t.status === 'ask') continue // never actually ran / not yet answered — nothing to replay
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

/**
 * Deterministic recap when we cannot afford another LLM call.
 *
 * This used to print `- \`tool\` -> ok` per step and end with "Ask me to
 * continue", which told the user nothing they could act on and handed the work
 * back to them. It now reports what each step actually FOUND, and — crucially —
 * distinguishes work that continues on its own (a triggered agent run keeps
 * executing and resumes if it hits a deadline) from work that genuinely needs
 * the user. Asking someone to re-prompt for something already running is the
 * product wasting their time.
 */
function fallbackSummary(trace: TraceEntry[]): string {
  if (trace.length === 0) {
    return "I ran out of time before I could do anything useful. Narrowing the request — one company, one role, or one job at a time — will get further."
  }

  const asRecord = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === 'object' ? (v as Record<string, unknown>) : null

  const lines: string[] = []
  const backgroundRuns: string[] = []

  for (const t of trace) {
    const obs = asRecord(t.observation)
    if (obs && typeof obs.error === 'string') {
      lines.push(`- ${t.tool}: failed — ${obs.error}`)
      continue
    }
    // Report the result, not the fact that a function was called.
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

      const startedAt = Date.now()
      const remaining = () => TIME_BUDGET_MS - (Date.now() - startedAt)

      // --- Resolve the conversation (create or load, ownership-checked). ---
      // Persistence is best-effort: a DB hiccup (or the copilot_conversations
      // migration not being applied yet) must not take down the whole chat —
      // the loop below can still plan/call tools/answer with a synthetic,
      // never-persisted conversation. Only an explicit conversationId that
      // genuinely does not belong to this user is a hard error (getConversation
      // returns null both for "not found" and for a query failure, so this
      // branch is deliberately permissive rather than risk masking real infra
      // errors as silent 404s).
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
      const effectiveAgents: ReadonlySet<StepAgentType> | undefined =
        effectiveAgentsList && effectiveAgentsList.length > 0 ? new Set(effectiveAgentsList) : undefined
      // Read-then-decide, never write: bypassMode only ever relaxes the
      // review-mode pause for READ/ACT tools below — see submitOrSendReason
      // for the one thing it can never touch.
      const effectiveBypassMode: boolean = bypassModeIn ?? Boolean(conversation.bypass_mode)

      // A single best-effort persistence helper for every terminal state below.
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
        } catch {
          // Best-effort — never throw out of an error/terminal path.
        }
      }

      // --- Edit-and-rerun: discard the edited message and everything after
      // it BEFORE loading history, so this turn runs from a clean cut point.
      // Destructive and explicit by construction — this route only ever sees
      // editMessageId when the client's own confirmed edit action sent it.
      if (editMessageId && persistenceHealthy) {
        try {
          await deleteMessagesFrom(admin, conversation.id, editMessageId)
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
          // The user's message was already persisted below once we start the
          // turn proper; for the no-key path we persist it here directly since
          // we return before reaching that step.
          try {
            {
              const savedUser = await appendMessage(admin, {
                conversationId: conversation.id,
                userId: user.id,
                role: 'user',
                content: messageIn,
              })
              send({ type: 'user_message', id: savedUser.id })
            }
          } catch {
            // best-effort
          }
        }
        await persistTurn(needsKeyMessage, [])
        return finish()
      }

      // --- Prepare history + this turn's starting trace. ---
      // Best-effort like everything else here: if the read fails we simply
      // start from empty history instead of aborting the turn.
      let trace: TraceEntry[] = []
      let convo: ChatMessage[] = []
      let pendingDirective: string | undefined

      // Whole-turn safety net starts here: an aborted fetch (the Stop button,
      // which aborts request.signal and turns the in-flight callLlm/
      // dispatchTool call below into an AbortError) or any other exception
      // mid-loop is caught at the bottom of this function and persists
      // whatever `trace` we built so far as a partial assistant message,
      // instead of vanishing or leaving the user's message dangling with no
      // reply. `trace` is declared above this try (not inside it) specifically
      // so the catch block can still read it.
      try {
      try {
        const history = persistenceHealthy ? await loadRecentMessages(admin, conversation.id, 24) : []
        // Both sentinel kinds are turn-scoped bookkeeping, not a real
        // completed exchange yet — excluded from the model's context. (The
        // GET handler below uses a DIFFERENT filter: an ask sentinel stays
        // visible there so a reload shows the pending question.)
        convo = history
          .filter((m) => !isPausedSentinel(m) && !isAskSentinel(m))
          .map((m) => ({ role: m.role, content: m.content }))

        if (isResume) {
          const last = history.length > 0 ? history[history.length - 1] : null
          if (last && isPausedSentinel(last)) {
            const rows = (last.trace as TraceEntry[]) ?? []
            trace = rows.slice(0, -1)
            const pending = rows[rows.length - 1] as TraceEntry | undefined
            await admin.from('copilot_messages').delete().eq('id', last.id) // superseded by this resume
            const guarded = Boolean(pending?.requiresConfirmation)
            const confirmed = guarded && confirmToolCall
            if (pending && guarded && !confirmed) {
              // Irreversible action, not confirmed: an empty directive is NEVER
              // treated as approval here (unlike a plain review pause below) —
              // only confirmToolCall:true dispatches it. Record what happened
              // so the transcript is honest, and let the model replan.
              trace.push({
                tool: pending.tool,
                args: pending.args,
                thought: pending.thought,
                observation: { error: 'Not confirmed by the user — this action was not performed.' },
                ok: false,
                status: 'error',
              })
              if (resumeDirective) pendingDirective = resumeDirective
            } else if (pending && (!resumeDirective || confirmed)) {
              // Approve as-is: a normal review approval, or a guarded action
              // the user just explicitly confirmed.
              const toolCtx: CopilotToolContext = {
                admin,
                userId: user.id,
                userEmail: user.email ?? '',
                apiKeys,
                signal: request.signal,
                enabledAgents: effectiveAgents,
              }
              send({ type: 'tool_call', step: trace.length, tool: pending.tool, args: pending.args })
              const observation = await dispatchTool(toolCtx, pending.tool, pending.args)
              const isError = Boolean(observation && typeof observation === 'object' && 'error' in (observation as Record<string, unknown>))
              trace.push({ tool: pending.tool, args: pending.args, thought: pending.thought, observation, ok: !isError, status: isError ? 'error' : 'ok' })
              send({ type: 'observation', step: trace.length - 1, tool: pending.tool, observation: observationForWire(observation) })
            } else if (pending) {
              // Non-empty directive: drop the pending call, replan with the
              // user's note as one trailing instruction for the next planning call.
              pendingDirective = resumeDirective
            }
          } else if (last && isAskSentinel(last)) {
            // Answering a question: fold {question, options, answer} into one
            // resolved trace entry (status 'ok') so buildMessages replays it
            // as a normal tool-call/result pair, and delete the sentinel — the
            // resolution lives on in whatever message eventually persists
            // this trace (the final answer, or the next pause/question).
            const rows = (last.trace as TraceEntry[]) ?? []
            trace = rows.slice(0, -1)
            const pending = rows[rows.length - 1] as TraceEntry | undefined
            const answer = resumeDirective && resumeDirective.length > 0 ? resumeDirective : '(no answer provided)'
            await admin.from('copilot_messages').delete().eq('id', last.id) // superseded by this resume
            trace.push({
              tool: 'ask_user',
              args: pending?.args ?? {},
              thought: pending?.thought,
              observation: { answer },
              ok: true,
              status: 'ok',
            })
          } else if (resumeDirective) {
            // Nothing pending to resume — fall back to treating the directive
            // as a fresh instruction so the turn still makes progress.
            convo.push({ role: 'user', content: resumeDirective })
          }
        } else {
          if (persistenceHealthy) {
            try {
              {
              const savedUser = await appendMessage(admin, {
                conversationId: conversation.id,
                userId: user.id,
                role: 'user',
                content: messageIn,
              })
              send({ type: 'user_message', id: savedUser.id })
            }
            } catch {
              // Best-effort — the turn still proceeds in-memory below.
            }
          }
          convo.push({ role: 'user', content: messageIn })
        }
      } catch (e) {
        send({ type: 'error', error: `Failed to prepare conversation: ${errMsg(e)}` })
        return finish()
      }

      // GOAL-HOLDING: the standing objective for every planning call this
      // request makes. `convo` at this point already reflects whichever
      // branch above ran (fresh message pushed, resumed directive pushed as a
      // fresh instruction, or untouched history from a plain tool-pause/ask
      // resume) — so its last real user turn IS the goal that must survive
      // across every tool call below. See buildMessages/objectiveReminder.
      const objective = lastUserMessage(convo) ?? resumeDirective ?? messageIn.trim()

      const toolCtx: CopilotToolContext = {
        admin,
        userId: user.id,
        userEmail: user.email ?? '',
        apiKeys,
        signal: request.signal,
        enabledAgents: effectiveAgents,
      }
      // Live-list the user's MCP servers once per turn (failure-isolated per
      // server, '' if none configured/reachable — see lib/mcp/registry.ts).
      // A dead/misconfigured server therefore degrades this to the built-in
      // tools only, never breaks the turn.
      const mcpBlock = await mcpToolsPromptBlock(admin, user.id)
      // Standing preferences — what this user has told Cello they want, in
      // earlier conversations. Loaded once per turn and injected into every
      // planning call, so "Series A+ only" survives the conversation it was
      // said in instead of dying with it. Read-only here; the
      // remember_preference tool is what writes.
      const { data: prefRow } = await admin
        .from('profiles')
        .select('preferences')
        .eq('id', user.id)
        .maybeSingle()
      const standingBlock = formatStandingPreferences(
        readStandingPreferences(prefRow?.preferences ?? null)
      )
      const sys = systemPrompt(effectiveAgents, mcpBlock, standingBlock)
      let runToolUsed = false
      let researchCompanyCount = 0
      // One-shot budget for the ask-redirect gate below — deliberately tiny
      // (not per research_company call) so this can only delay a genuine ask
      // by a single extra planning step this turn, never loop.
      let askRedirectUsed = false
      const baseStep = trace.length

      for (let i = 0; i < MAX_STEPS; i++) {
        const step = baseStep + i
        // Stop planning new turns if we can't afford to also summarize afterward.
        if (remaining() < FINAL_RESERVE_MS) break

        let action: ModelAction
        try {
          const res = await callLlm(
            apiKeys,
            {
              system: sys,
              messages: buildMessages(convo, trace, objective, pendingDirective),
              model: effectiveModel,
              json: true,
              // Reasoning shares this budget, so it needs real headroom beyond
              // the ~400 tokens the action JSON itself costs.
              maxTokens: 4000,
              temperature: 0.2,
              // Deciding which tool to run next, with what arguments, is the
              // judgement call of the whole loop — and surfacing that reasoning
              // is what makes the copilot legible rather than a black box.
              reasoning: { effort: reasoningEffort },
            },
            request.signal
          )
          pendingDirective = undefined
          // Stream the real chain of thought before the step's own one-line
          // summary, so the user sees HOW the tool was chosen. This is raw
          // model prose composed with a context full of internal tool names
          // (the tool catalog literally says "dossier" repeatedly) — scrub it
          // the same as the final/ask text below rather than trusting the
          // prompt instruction alone.
          if (res.reasoning) {
            send({ type: 'reasoning', step, reasoning: scrubJargon(res.reasoning) })
          }
          action = parseJsonLoose<ModelAction>(res.content)
        } catch (e) {
          // Planning failed OR the user hit Stop (request.signal aborts the
          // fetch inside callLlm) — summarize what we have rather than
          // erroring mid-trace. Persist BEFORE trying to notify the client:
          // if the client already disconnected (the Stop case), send() below
          // is a no-op, but the transcript must still end up saved rather
          // than vanishing. `request.signal.aborted` (not the thrown error's
          // `.name`) is the reliable abort signal here — the OpenRouter path
          // goes through the openai SDK, whose APIUserAbortError never sets
          // `.name` to 'AbortError' (it inherits plain 'Error'), so checking
          // the error shape alone would misclassify a real Stop as a generic
          // failure; request.signal is the one source of truth we control.
          const aborted = request.signal.aborted || (e instanceof Error && e.name === 'AbortError')
          const message =
            trace.length > 0 ? fallbackSummary(trace) : aborted ? 'Stopped.' : `Copilot LLM error: ${errMsg(e)}`
          await persistTurn(message, trace)
          const asFinal = trace.length > 0 || aborted
          send({ type: asFinal ? 'final' : 'error', ...(asFinal ? { message } : { error: message }) })
          return finish()
        }

        const thought = typeof action.thought === 'string' ? scrubJargon(action.thought) : undefined

        // Final answer.
        if (action.action === 'final' || (!action.tool && !action.question && typeof action.message === 'string')) {
          const message = scrubJargon(action.message ?? '(no answer)')
          send({ type: 'final', message })
          await persistTurn(message, trace)
          return finish()
        }

        // Ask-redirect gate: the objective itself names a company fact
        // (funding stage / visa sponsorship) that research_company or
        // get_dossier resolves, the model has not touched either tool at all
        // this turn, and there is still research budget left — reject the
        // ask ONCE and send it back to actually look the fact up instead of
        // asking or (worse) silently guessing it in "reasoning" and asking
        // anyway. This is a hard backstop for the "ACT, DO NOT DEFER" prompt
        // rule, not a replacement for it: a real, tool-unanswerable
        // disambiguation still gets through on the next attempt.
        if (
          action.action === 'ask' &&
          typeof action.question === 'string' &&
          action.question.trim() &&
          !askRedirectUsed &&
          researchCompanyCount < RESEARCH_COMPANY_MAX_PER_TURN &&
          COMPANY_FACT_SIGNAL.test(objective) &&
          !trace.some((t) => t.tool === 'research_company' || t.tool === 'research_companies' || t.tool === 'get_dossier')
        ) {
          askRedirectUsed = true
          trace.push({
            tool: 'ask',
            args: { question: action.question.trim() },
            thought,
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
          })
          continue
        }

        // Ask: stop and get the user's input instead of guessing. Structurally
        // like a review pause (a sentinel that ends this request) but NEVER
        // gated by thinkingMode/bypassMode, and — unlike a tool pause —
        // deliberately visible on reload (see isAskSentinel).
        // Structured multi-question form: several decisions at once, each
        // single- or multi-select, with a free-text note. Validated by
        // lib/harness/ask-user.ts so a malformed form returns an actionable
        // error to the model rather than rendering something incoherent.
        // Deliberately checked BEFORE the legacy single-question branch, and
        // the legacy shape is retained: conversations persisted before this
        // existed still replay, and a model that asks one plain question
        // should not be forced through a form.
        if (action.action === 'ask' && Array.isArray((action as { questions?: unknown }).questions)) {
          try {
            const parsed = parseAskUserRequest(action as unknown)
            const questions = parsed.questions.map((q) => ({
              header: scrubJargon(q.header),
              question: scrubJargon(q.question),
              multiSelect: q.multiSelect,
              options: q.options.map((o) => ({
                label: scrubJargon(o.label),
                ...(o.description ? { detail: scrubJargon(o.description) } : {}),
              })),
            }))
            send({ type: 'question', step, questions })
            trace.push({ tool: 'ask_user', args: { questions }, thought, observation: null, ok: true, status: 'ask' })
            // Persist the first question as the turn's visible text so a
            // reloaded conversation still shows what was asked.
            await persistTurn(questions[0].question, trace)
            return finish()
          } catch (err) {
            const message = err instanceof AskUserError ? err.message : 'The question form was invalid.'
            trace.push({
              tool: 'ask_user',
              args: action as Record<string, unknown>,
              thought,
              observation: { error: message },
              ok: false,
              status: 'error',
            })
            continue
          }
        }

        if (action.action === 'ask' && typeof action.question === 'string' && action.question.trim()) {
          const question = scrubJargon(action.question.trim())
          const rawOptions = Array.isArray(action.options) ? action.options : []
          const options = rawOptions
            .filter((o): o is AskOption => Boolean(o) && typeof o === 'object' && typeof o.label === 'string' && o.label.trim().length > 0)
            .slice(0, 6)
            .map((o) => ({
              label: scrubJargon(o.label.trim()),
              ...(typeof o.detail === 'string' && o.detail.trim() ? { detail: scrubJargon(o.detail.trim()) } : {}),
            }))
          send({ type: 'question', step, question, ...(options.length ? { options } : {}) })
          trace.push({ tool: 'ask_user', args: { question, options }, thought, observation: null, ok: true, status: 'ask' })
          await persistTurn(question, trace)
          return finish()
        }

        // Tool call.
        if (action.action === 'tool' && typeof action.tool === 'string') {
          const tool = action.tool
          const args = (action.args ?? {}) as Record<string, unknown>
          if (thought) send({ type: 'thought', step, thought })

          if (!isValidTool(tool) && !isMcpToolName(tool)) {
            trace.push({ tool, args, thought, observation: { error: `Unknown tool "${tool}"` }, ok: false, status: 'error' })
            continue
          }

          // Gate heavy tools by wall-clock budget. trigger_run (whole-DAG,
          // background) stays capped at one per turn — starting a second
          // background DAG mid-turn is rarely what's wanted and the first one
          // keeps running regardless. research_company gets its OWN bounded
          // allowance instead of sharing that single-shot cap: a goal like
          // "which of these companies sponsor H1B" genuinely needs to research
          // several companies inline to answer honestly (see ACT, DO NOT
          // DEFER above) — one research_company call would only ever answer
          // for one company, forcing every other one back into a question.
          // Each call is still individually gated by remaining wall-clock time
          // (RUN_MIN_MS), so this can't blow the request budget either.
          if (tool === 'research_company') {
            if (researchCompanyCount >= RESEARCH_COMPANY_MAX_PER_TURN) {
              trace.push({
                tool,
                args,
                thought,
                observation: {
                  error: `skipped: already researched ${RESEARCH_COMPANY_MAX_PER_TURN} companies this turn — enough to answer with. Report what you found instead of researching more.`,
                  skipped: true,
                },
                ok: false,
                status: 'skipped',
              })
              continue
            }
            if (remaining() < RUN_MIN_MS) {
              trace.push({
                tool,
                args,
                thought,
                observation: { error: 'skipped: not enough time left this turn to research another company. Give a final answer now with what you have.', skipped: true },
                ok: false,
                status: 'skipped',
              })
              continue
            }
            researchCompanyCount++
          } else if (isRunTool(tool)) {
            if (runToolUsed) {
              trace.push({
                tool,
                args,
                thought,
                observation: { error: 'skipped: only one background run per turn. Summarize what you have or ask the user to run this next.', skipped: true },
                ok: false,
                status: 'skipped',
              })
              continue
            }
            if (remaining() < RUN_MIN_MS) {
              trace.push({
                tool,
                args,
                thought,
                observation: { error: 'skipped: not enough time left this turn to run a long task. Give a final answer now; the user can ask again to run it.', skipped: true },
                ok: false,
                status: 'skipped',
              })
              continue
            }
            runToolUsed = true
          } else if ((isActTool(tool) || isMcpToolName(tool)) && remaining() < ACT_MIN_MS) {
            trace.push({
              tool,
              args,
              thought,
              observation: { error: 'skipped: low on time. Provide a final answer with what you have.', skipped: true },
              ok: false,
              status: 'skipped',
            })
            continue
          }

          // The submit/send confirmation guard is UNCONDITIONAL: computed
          // before thinkingMode/bypassMode are consulted at all, so neither —
          // nor any client-supplied flag — can unlock it. See
          // submitOrSendReason's doc comment for exactly what it covers.
          const submitReason = submitOrSendReason(tool, args)
          // bypassMode only ever relaxes the review-mode pause below, and only
          // for reversible READ/ACT tools, and never when the guard above has
          // already flagged this specific call.
          const bypassSkipsReview = effectiveBypassMode && !submitReason && (isReadTool(tool) || isActTool(tool))

          // Pause before actually executing, and end this request: either the
          // unconditional guard tripped, or plain review mode wants a look
          // (and bypass mode didn't just waive it for this tool kind).
          if (submitReason || (thinkingMode === 'review' && !bypassSkipsReview)) {
            send({
              type: 'paused',
              step,
              thought: thought ?? '',
              tool,
              args,
              ...(submitReason ? { requiresConfirmation: true, reason: submitReason } : {}),
            })
            trace.push({
              tool,
              args,
              thought,
              observation: null,
              ok: false,
              status: 'paused',
              ...(submitReason ? { requiresConfirmation: true } : {}),
            })
            await persistTurn('', trace)
            return finish()
          }

          send({ type: 'tool_call', step, tool, args })
          const observation = await dispatchTool(toolCtx, tool, args)
          const isError = Boolean(observation && typeof observation === 'object' && 'error' in (observation as Record<string, unknown>))
          trace.push({ tool, args, thought, observation, ok: !isError, status: isError ? 'error' : 'ok' })
          send({ type: 'observation', step, tool, observation: observationForWire(observation) })
          continue
        }

        // Unparseable / empty action — surface any text, else record + retry once.
        if (typeof action.message === 'string') {
          const message = scrubJargon(action.message)
          send({ type: 'final', message })
          await persistTurn(message, trace)
          return finish()
        }
        trace.push({ tool: '(none)', args: {}, observation: { error: 'model returned no valid action' }, ok: false, status: 'error' })
      }

      // Budget/steps exhausted — force a final answer. Prefer an LLM summary if we
      // still have a little time; else recap the trace deterministically.
      if (remaining() > 2_000) {
        try {
          const res = await callLlm(
            apiKeys,
            {
              system: sys,
              messages: buildMessages(
                convo,
                trace,
                objective,
                'You are out of tool budget for this turn. Respond NOW with {"action":"final","message":"..."} summarizing what you found and any next step for the user. Do not call another tool.'
              ),
              model: effectiveModel,
              json: true,
              maxTokens: 1200,
              temperature: 0.2,
            },
            request.signal
          )
          const parsed = parseJsonLoose<ModelAction>(res.content)
          if (typeof parsed.message === 'string' && parsed.message.trim()) {
            const message = scrubJargon(parsed.message)
            send({ type: 'final', message })
            await persistTurn(message, trace)
            return finish()
          }
        } catch {
          // fall through to deterministic recap
        }
      }

      const message = fallbackSummary(trace)
      send({ type: 'final', message })
      await persistTurn(message, trace)
      return finish()
      } catch (e) {
        // Whole-turn safety net (see the comment where this try opens, right
        // after `trace` is declared): an aborted fetch (Stop) or any other
        // exception mid-loop lands here instead of crashing the stream
        // silently. Persist BEFORE trying to notify the client, since a Stop
        // means the client is very likely already gone and send() is a no-op.
        // See the callLlm catch above for why request.signal.aborted, not the
        // thrown error's `.name`, is the reliable abort check.
        const aborted = request.signal.aborted || (e instanceof Error && e.name === 'AbortError')
        const message = trace.length > 0 ? fallbackSummary(trace) : aborted ? 'Stopped.' : `Copilot error: ${errMsg(e)}`
        await persistTurn(message, trace)
        const asFinal = trace.length > 0 || aborted
        send({ type: asFinal ? 'final' : 'error', ...(asFinal ? { message } : { error: message }) })
        finish()
      }
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
        // Only the plain review-mode pause sentinel is hidden — an ask
        // sentinel (pending OR resolved-into-a-later-message) stays visible
        // so a reload shows both the question and, once given, the answer.
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
