import type { PipelineStage } from '@cello/shared'
import { PIPELINE_STAGES } from '@cello/shared'
import type { StatusSignal } from './types'

/**
 * Default minimum confidence threshold for accepting a status signal
 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.5

/**
 * Stage order for determining if a transition is forward or backward
 * Lower index = earlier in the pipeline
 */
const STAGE_ORDER: Record<PipelineStage, number> = {
  discovered: 0,
  applied: 1,
  screen: 2,
  interview: 3,
  offer: 4,
  closed: 5,
  ghosted: 5,
  rejected: 5,
}

/**
 * Detect the most likely status from a list of signals
 * Returns the highest confidence signal that meets the threshold
 */
export function detectStatus(
  signals: StatusSignal[],
  confidenceThreshold: number = DEFAULT_CONFIDENCE_THRESHOLD
): StatusSignal | null {
  if (signals.length === 0) {
    return null
  }

  // Sort by confidence descending (should already be sorted, but ensure)
  const sorted = [...signals].sort((a, b) => b.confidence - a.confidence)

  // Return the highest confidence signal that meets the threshold
  for (const signal of sorted) {
    if (signal.confidence >= confidenceThreshold) {
      return signal
    }
  }

  return null
}

/**
 * Map a status signal to its pipeline stage
 */
export function mapSignalToStage(signal: StatusSignal): PipelineStage {
  return signal.stage
}

/**
 * Check if a stage transition is valid (forward movement or terminal states)
 *
 * Rules:
 * - Cannot go backward in the pipeline (e.g., interview -> applied)
 * - Exception: rejection and ghosted can happen from any stage
 * - Exception: offer can come from any non-terminal stage
 */
export function isValidTransition(
  currentStage: PipelineStage,
  newStage: PipelineStage
): boolean {
  // Same stage is not a valid transition
  if (currentStage === newStage) {
    return false
  }

  // Terminal states - cannot transition from these
  const terminalStates: PipelineStage[] = ['closed', 'ghosted', 'rejected']
  if (terminalStates.includes(currentStage)) {
    return false
  }

  // Rejection can happen from any non-terminal stage
  if (newStage === 'rejected') {
    return true
  }

  // Ghosted can happen from any active stage
  if (newStage === 'ghosted') {
    return true
  }

  // Offer can happen from screen or interview
  if (newStage === 'offer') {
    return ['screen', 'interview'].includes(currentStage)
  }

  // Normal forward progression
  const currentOrder = STAGE_ORDER[currentStage]
  const newOrder = STAGE_ORDER[newStage]

  return newOrder > currentOrder
}

/**
 * Get the stage order index (for comparison)
 */
export function getStageOrder(stage: PipelineStage): number {
  return STAGE_ORDER[stage]
}

/**
 * Determine if a stage is a terminal state
 */
export function isTerminalStage(stage: PipelineStage): boolean {
  return ['closed', 'ghosted', 'rejected', 'offer'].includes(stage)
}

/**
 * Get all valid next stages from the current stage
 */
export function getValidNextStages(currentStage: PipelineStage): PipelineStage[] {
  const validStages: PipelineStage[] = []

  for (const stage of PIPELINE_STAGES) {
    if (isValidTransition(currentStage, stage)) {
      validStages.push(stage)
    }
  }

  return validStages
}
