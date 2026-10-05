// What every agent, tool and workflow in lib/agents knows about the request it
// is serving. Built once per request (the stream route, the continue endpoint,
// the MCP route) and passed down, so no tool ever reaches for a user id on its own.

import type { AdminClient, DecryptedApiKeys } from '@/lib/harness/types'

/** How much a scheduled task may do without asking. */
export type Autonomy = 'ask' | 'draft' | 'act'

/** What an "act within my rules" task may auto-approve. Stored on the task. */
export interface AutonomyRules {
  allow_send_email?: boolean
  allow_submit?: boolean
}

export interface AgentContext {
  admin: AdminClient
  userId: string
  userEmail: string
  apiKeys: DecryptedApiKeys
  isDemo: boolean
  threadId: string
  conversationId: string | null
  scheduledTaskId?: string | null
  /** The root task row for this request, parent of every branch row. */
  rootTaskId?: string | null
  autonomy: Autonomy
  rules?: AutonomyRules
  /** One Langfuse trace per request or scheduled occurrence. */
  traceId: string
  signal?: AbortSignal
  /** Epoch ms after which no new work starts and the request hands over to a continuation. */
  deadlineAt: number
}

/** The slice length: no new branches after this long into a request (Vercel Hobby allows 300 s). */
export const SLICE_MS = 240_000

export function newDeadline(now: number = Date.now()): number {
  return now + SLICE_MS
}
