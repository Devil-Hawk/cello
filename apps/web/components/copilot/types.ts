// Shared client-side types for the Copilot UI.
//
// Mirrors the SSE + REST contract served by POST/GET/DELETE /api/copilot (the
// server is rebuilt in parallel to this exact contract — see that route's doc
// comment for the wire format). A `ChatMessage` is one bubble in the thread;
// for assistant turns it accumulates `StepEntry` rows live as SSE events
// arrive (thought -> tool_call -> observation, keyed by `step`), or is
// reconstructed once from a persisted `trace` when a past conversation loads.

import type { FormQuestion } from './question-form'
import type { StepAgentType } from '@/lib/harness/copilot-tool-catalog'

export type StepStatus = 'thinking' | 'running' | 'done' | 'error' | 'skipped' | 'paused' | 'ask'

export interface AskOption {
  label: string
  detail?: string
}

export interface StepEntry {
  step: number
  thought?: string
  /** The model's extended reasoning for this step, streamed before the tool call. */
  reasoning?: string
  tool?: string
  args?: Record<string, unknown>
  /** String on the wire (observation truncated to 2000 chars per the SSE
   *  contract) but may be a plain object when reconstructed from a persisted
   *  trace — StepCard's formatter accepts either. */
  observation?: unknown
  status: StepStatus
  /** Only set on a 'paused' step: true when this pause is the unconditional
   *  submit/send confirmation guard rather than a plain review-mode pause —
   *  see the route's submitOrSendReason. Changes what the step card offers:
   *  a guarded pause needs an explicit Confirm, never a bare Approve. */
  requiresConfirmation?: boolean
  reason?: string
  /** Only set on an 'ask' step. */
  question?: string
  options?: AskOption[]
  /** A structured multi-question form, when the model asked for several
   *  decisions at once. Mutually exclusive with the single `question` +
   *  `options` shape above, which is retained so older conversations replay. */
  questions?: FormQuestion[]
  /** Only set once an 'ask' step has been answered (reconstructed from a
   *  persisted trace's resolved ask_user entry). */
  answer?: string
}

export type ConnectionStatus = 'reconnecting' | 'failed'

/**
 * Set only while this turn's own stream is being recovered after an
 * unexpected network drop (a deploy, a hot reload, a flaky connection) —
 * never for a genuine user Stop, which just ends the turn. See page.tsx's
 * runStream/reconnect. Absent once resolved (recovered, or the user
 * dismissed the failed state and retried into a fresh outcome).
 */
export interface ConnectionState {
  status: ConnectionStatus
  /** 1-indexed attempt currently in flight (or the last one tried, once failed). */
  attempt: number
  maxAttempts: number
}

export interface PausedState {
  step: number
  thought: string
  tool: string
  args: Record<string, unknown>
  requiresConfirmation?: boolean
  reason?: string
}

export interface QuestionState {
  step: number
  question: string
  options?: AskOption[]
  /** The structured multi-question form, when the model asked for several
   *  decisions at once. Carried at runtime before it was declared here, so
   *  any consumer reading it was writing against an undeclared field. */
  questions?: FormQuestion[]
}

export interface ChatMessage {
  id: string
  /** The persisted copilot_messages row id, when this turn has been saved —
   *  absent for a message still only in memory (e.g. an in-flight assistant
   *  reply). Required to edit-and-rerun a past USER message. */
  serverId?: string
  role: 'user' | 'assistant'
  content: string
  steps: StepEntry[]
  pending: boolean
  paused?: PausedState
  question?: QuestionState
  error?: { message: string; needsKey?: boolean }
  createdAt?: string
  /** See ConnectionState — only set while this turn is recovering from a drop. */
  connection?: ConnectionState
}

export interface ConversationSummary {
  id: string
  title: string
  updated_at: string
}

export interface ComposerSettings {
  /** The full STEP_AGENT_TYPES list means "all enabled" (sent as undefined). */
  enabledAgents: StepAgentType[]
  /** DEFAULT_MODEL_SENTINEL ('default') or a concrete ModelId. */
  model: string
  thinkingMode: 'auto' | 'review'
  /** Per-conversation "bypass permissions" toggle — see route.ts's doc
   *  comment for exactly what it does and does not skip. */
  bypassMode: boolean
}
