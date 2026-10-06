// groupOf: which of the five groups of the Applications page an application belongs to (4.8).
// One function, so every row lands in exactly one group. A role that was only saved has no state and
// no stage past Saved; it is not an application yet and belongs to none (it lives on Roles).

import type { ApplicationGroup, ApplicationState, ClosedReason, Stage } from './types'

/** What the search says comes next, computed once by lib/pipeline/next-step.ts (K20). */
export type NextStepKind = 'reply' | 'offer_due' | 'follow_up_due' | 'gone_quiet'

export interface GroupInput {
  state: ApplicationState | null
  stage: Stage | string
  found_state?: 'to_confirm' | 'confirmed' | null
  closed_reason?: ClosedReason | null
}

const CLOSED_STAGES = new Set(['rejected', 'withdrawn', 'ghosted'])
const INTERVIEW_STAGES = new Set(['screen', 'interview', 'offer', 'accepted'])

export function groupOf(a: GroupInput, next: { kind: NextStepKind } | null): ApplicationGroup | null {
  if (a.closed_reason || CLOSED_STAGES.has(a.stage) || a.state === 'skipped') return 'closed'
  // found in email and waiting for the person's Confirm
  if (a.found_state === 'to_confirm') return 'needs_you'
  if (a.state === 'needs_you' || a.state === 'ready' || a.state === 'not_sent') return 'needs_you'
  if (a.state === 'preparing' || a.state === 'scheduled' || a.state === 'applying' || a.state === 'paused') return 'preparing'
  if (next) return 'needs_you'
  if (INTERVIEW_STAGES.has(a.stage)) return 'interview'
  if (a.state === 'sent' || a.state === 'confirmed' || a.stage === 'applied') return 'waiting'
  return null
}
