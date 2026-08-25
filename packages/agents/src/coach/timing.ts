// Follow-up timing logic for Coach Agent

import type { PipelineStage } from '@cello/shared'
import type { FollowUpTiming, FollowUpStage } from './types'
import { isFollowUpStage } from './types'

/**
 * Follow-up timing configuration by stage
 * Based on best practices for job application follow-ups
 */
const FOLLOW_UP_TIMINGS: Record<FollowUpStage, FollowUpTiming> = {
  applied: {
    minDays: 5,
    maxDays: 7,
    suggestion: 'Check on application status with a brief, professional inquiry',
  },
  screen: {
    minDays: 3,
    maxDays: 5,
    suggestion: 'Send thank you note and reiterate your interest in the role',
  },
  interview: {
    minDays: 1,
    maxDays: 2,
    suggestion: 'Send thank you note and ask about next steps in the process',
  },
  offer: {
    minDays: 2,
    maxDays: 3,
    suggestion: 'Follow up with questions about the offer or negotiation points',
  },
}

/**
 * Get follow-up timing for a given stage
 * Returns null for stages that don't require follow-up
 */
export function getFollowUpTiming(stage: PipelineStage): FollowUpTiming | null {
  if (!isFollowUpStage(stage)) {
    return null
  }
  return FOLLOW_UP_TIMINGS[stage]
}

/**
 * Calculate days since a given date
 */
export function daysSince(date: Date | null): number {
  if (!date) return 0
  const now = new Date()
  const diffTime = Math.abs(now.getTime() - date.getTime())
  return Math.floor(diffTime / (1000 * 60 * 60 * 24))
}

/**
 * Determine if we should suggest a follow-up based on stage and timing
 */
export function shouldSuggestFollowUp(
  stage: PipelineStage,
  lastActivityDate: Date | null
): boolean {
  if (!lastActivityDate) {
    return false
  }

  const timing = getFollowUpTiming(stage)
  if (!timing) {
    return false
  }

  const days = daysSince(lastActivityDate)
  return days >= timing.minDays
}

/**
 * Get urgency level based on how overdue the follow-up is
 */
export function getFollowUpUrgency(
  stage: PipelineStage,
  lastActivityDate: Date | null
): 'none' | 'suggested' | 'urgent' | 'overdue' {
  if (!lastActivityDate) {
    return 'none'
  }

  const timing = getFollowUpTiming(stage)
  if (!timing) {
    return 'none'
  }

  const days = daysSince(lastActivityDate)

  if (days < timing.minDays) {
    return 'none'
  } else if (days <= timing.maxDays) {
    return 'suggested'
  } else if (days <= timing.maxDays + 3) {
    return 'urgent'
  } else {
    return 'overdue'
  }
}

/**
 * Generate a human-readable suggestion based on stage and timing
 */
export function getTimingSuggestion(stage: PipelineStage, daysSinceActivity: number): string {
  const timing = getFollowUpTiming(stage)

  if (!timing) {
    return 'No follow-up needed for this stage.'
  }

  const urgency = daysSinceActivity < timing.minDays ? 'none' :
                  daysSinceActivity <= timing.maxDays ? 'suggested' :
                  daysSinceActivity <= timing.maxDays + 3 ? 'urgent' : 'overdue'

  switch (stage) {
    case 'applied':
      if (urgency === 'none') {
        return `It's only been ${daysSinceActivity} days since you applied. Wait until day ${timing.minDays} to follow up.`
      }
      return `It's been ${daysSinceActivity} days since you applied. Consider sending a brief follow up to check on your application status.`

    case 'screen':
      if (urgency === 'none') {
        return `It's been ${daysSinceActivity} days since your screen. Wait a bit longer before following up.`
      }
      return `It's been ${daysSinceActivity} days since your screen. Send a thank you note and reiterate your interest.`

    case 'interview':
      if (urgency === 'none') {
        return `It's been ${daysSinceActivity} days since your interview. Consider sending a thank you note soon.`
      }
      return `It's been ${daysSinceActivity} days since your interview. Send a thank you note and ask about next steps.`

    case 'offer':
      if (urgency === 'none') {
        return `It's been ${daysSinceActivity} days since receiving the offer. Take time to review it carefully.`
      }
      return `It's been ${daysSinceActivity} days since receiving the offer. Follow up with any questions about the offer or negotiation.`

    default:
      return timing.suggestion
  }
}

/**
 * Get the last relevant activity date for an application
 * Uses updatedAt as proxy for last activity
 */
export function getLastActivityDate(application: {
  appliedAt: Date | null
  updatedAt: Date
}): Date | null {
  // Use appliedAt as the baseline activity date
  // In a more complete implementation, we'd track actual email/interview dates
  return application.appliedAt
}
