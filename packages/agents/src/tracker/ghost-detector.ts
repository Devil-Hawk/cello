import type { Application, PipelineStage } from '@cello/shared'
import { GHOST_THRESHOLDS } from '@cello/shared'
import type { GhostingResult } from './types'

/**
 * Ghost status levels based on days since last activity
 */
export enum GhostStatus {
  NONE = 'none',
  WARNING = 'warning',
  FOLLOW_UP = 'follow_up',
  GHOSTED = 'ghosted',
}

/**
 * Stages that should not be checked for ghosting
 * (already in a terminal or resolved state)
 */
const EXEMPT_STAGES: PipelineStage[] = ['closed', 'ghosted', 'rejected', 'offer']

/**
 * Calculate the number of days between two dates
 */
export function daysBetween(date1: Date, date2: Date): number {
  const msPerDay = 1000 * 60 * 60 * 24
  const diff = Math.abs(date2.getTime() - date1.getTime())
  return Math.floor(diff / msPerDay)
}

/**
 * Get the ghost status based on days since last activity
 */
export function getGhostStatus(
  lastActivityDate: Date,
  now: Date = new Date()
): GhostStatus {
  const days = daysBetween(lastActivityDate, now)

  if (days >= GHOST_THRESHOLDS.GHOSTED) {
    return GhostStatus.GHOSTED
  }

  if (days >= GHOST_THRESHOLDS.FOLLOW_UP) {
    return GhostStatus.FOLLOW_UP
  }

  if (days >= GHOST_THRESHOLDS.WARNING) {
    return GhostStatus.WARNING
  }

  return GhostStatus.NONE
}

/**
 * Get a human-readable message for the ghost status
 */
export function getGhostMessage(status: GhostStatus, days: number): string {
  switch (status) {
    case GhostStatus.GHOSTED:
      return `No response in ${days} days. This application may have been ghosted.`
    case GhostStatus.FOLLOW_UP:
      return `No response in ${days} days. Consider sending a follow-up message.`
    case GhostStatus.WARNING:
      return `No response in ${days} days. Keep an eye on this application.`
    case GhostStatus.NONE:
      return 'Recent activity detected.'
  }
}

/**
 * Detect ghosting for an application based on its last activity
 *
 * Uses the application's updatedAt field as the last activity indicator.
 * Applications in terminal stages (closed, ghosted, rejected, offer) are exempt.
 */
export function detectGhosting(
  application: Application,
  now: Date = new Date()
): GhostingResult {
  const applicationId = application.id

  // Check if application is in an exempt stage
  if (EXEMPT_STAGES.includes(application.stage)) {
    return {
      applicationId,
      status: GhostStatus.NONE,
      daysSinceActivity: 0,
      shouldFollowUp: false,
      shouldMoveToGhosted: false,
      message: 'Application is in a resolved state.',
    }
  }

  // Use updatedAt as the last activity indicator
  const lastActivity = application.updatedAt
  const daysSinceActivity = daysBetween(lastActivity, now)
  const status = getGhostStatus(lastActivity, now)

  return {
    applicationId,
    status,
    daysSinceActivity,
    shouldFollowUp: status === GhostStatus.FOLLOW_UP,
    shouldMoveToGhosted: status === GhostStatus.GHOSTED,
    message: getGhostMessage(status, daysSinceActivity),
  }
}

/**
 * Check multiple applications for ghosting
 */
export function detectGhostingBatch(
  applications: Application[],
  now: Date = new Date()
): GhostingResult[] {
  return applications.map((app) => detectGhosting(app, now))
}

/**
 * Filter applications that should be moved to ghosted stage
 */
export function getGhostedApplications(
  applications: Application[],
  now: Date = new Date()
): Application[] {
  return applications.filter((app) => {
    const result = detectGhosting(app, now)
    return result.shouldMoveToGhosted
  })
}

/**
 * Filter applications that need follow-up
 */
export function getFollowUpApplications(
  applications: Application[],
  now: Date = new Date()
): Application[] {
  return applications.filter((app) => {
    const result = detectGhosting(app, now)
    return result.shouldFollowUp
  })
}
