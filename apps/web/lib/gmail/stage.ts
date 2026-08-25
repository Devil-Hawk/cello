// Application stage-transition policy. Replaces the old "only advance
// through a linear stageOrder" logic with explicit rules:
//  - "rejected" can happen from any non-terminal stage.
//  - "accepted" is a terminal state reachable from "offer" (or later).
//  - once in a terminal stage, further signals never silently regress it —
//    the decision is always recorded, never applied-and-forgotten.

import type { ApplicationStatus } from './types'

const STAGE_RANK: Record<string, number> = {
  discovered: 0,
  applied: 1,
  screen: 2,
  interview: 3,
  offer: 4,
  accepted: 5,
  rejected: 5,
}

const TERMINAL_STAGES = new Set(['accepted', 'rejected'])

export type StageDecisionAction = 'advanced' | 'ignored_regression' | 'ignored_terminal' | 'no_change'

export interface StageDecision {
  action: StageDecisionAction
  fromStage: string
  toStage: string
  reason: string
}

/**
 * Decide whether a newly-detected status should move an application's
 * stage forward. Never mutates anything — callers apply `toStage` only when
 * `action === 'advanced'`, and should always record the decision (e.g. on
 * the activity row) so ignored signals stay visible instead of silent.
 */
export function decideStageTransition(currentStage: string, detectedStatus: ApplicationStatus): StageDecision {
  if (detectedStatus === 'unknown') {
    return { action: 'no_change', fromStage: currentStage, toStage: currentStage, reason: 'no status detected in email' }
  }

  if (detectedStatus === 'rejected') {
    if (currentStage === 'rejected') {
      return { action: 'no_change', fromStage: currentStage, toStage: currentStage, reason: 'already rejected' }
    }
    // Rejection is allowed to override any prior stage, including "accepted"
    // (offer rescinded), but we still record it as a real transition.
    return {
      action: 'advanced',
      fromStage: currentStage,
      toStage: 'rejected',
      reason: `rejection detected, overrides prior stage "${currentStage}"`,
    }
  }

  if (TERMINAL_STAGES.has(currentStage)) {
    return {
      action: 'ignored_terminal',
      fromStage: currentStage,
      toStage: detectedStatus,
      reason: `application already in terminal stage "${currentStage}"; new signal "${detectedStatus}" was not applied`,
    }
  }

  const currentRank = STAGE_RANK[currentStage] ?? -1
  const newRank = STAGE_RANK[detectedStatus] ?? -1

  if (newRank > currentRank) {
    return { action: 'advanced', fromStage: currentStage, toStage: detectedStatus, reason: 'forward progression' }
  }

  if (newRank === currentRank && detectedStatus !== currentStage) {
    // e.g. currentStage unrecognized custom value ranked equal by fallback.
    return { action: 'advanced', fromStage: currentStage, toStage: detectedStatus, reason: 'lateral update' }
  }

  return {
    action: 'ignored_regression',
    fromStage: currentStage,
    toStage: detectedStatus,
    reason: `detected "${detectedStatus}" would regress from "${currentStage}"; not applied`,
  }
}
