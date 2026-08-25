import { MATCH_THRESHOLDS } from '@cello/shared'
import type { PriorityInput, PriorityResult, RecommendedAction } from './types'

// Freshness threshold in hours
const FRESH_HOURS_THRESHOLD = 2

/**
 * Calculate priority and recommended actions for a job based on match score,
 * dream company status, and freshness.
 *
 * Priority Logic:
 * - URGENT: Match >=85% AND (dreamCompany OR posted <2 hours ago)
 * - HIGH: Match >=85% OR (Match >=70% AND dreamCompany)
 * - MEDIUM: Match >=70% OR (Match >=50% AND dreamCompany)
 * - LOW: Match >=50%
 * - SKIP: Match <50%
 */
export function calculatePriority(input: PriorityInput): PriorityResult {
  const { matchScore, isDreamCompany, hoursAgo } = input
  const reasons: string[] = []
  let recommendedActions: RecommendedAction[] = []

  // Build reasons based on score
  if (matchScore >= MATCH_THRESHOLDS.EXCELLENT) {
    reasons.push(`Excellent match (${matchScore}%)`)
  } else if (matchScore >= MATCH_THRESHOLDS.GOOD) {
    reasons.push(`Good match (${matchScore}%)`)
  } else if (matchScore >= MATCH_THRESHOLDS.FAIR) {
    reasons.push(`Fair match (${matchScore}%)`)
  } else {
    reasons.push(`Low match score (${matchScore}%)`)
  }

  // Add dream company reason
  if (isDreamCompany) {
    reasons.push('Dream company')
  }

  // Check freshness
  const isFresh = hoursAgo < FRESH_HOURS_THRESHOLD
  if (isFresh) {
    reasons.push(`Fresh posting (${hoursAgo} hours ago)`)
  }

  // Determine priority based on rules
  // SKIP: Match <50%
  if (matchScore < MATCH_THRESHOLDS.FAIR) {
    return {
      priority: 'skip',
      reasons,
      recommendedActions: ['skip'],
    }
  }

  // URGENT: Match >=85% AND (dreamCompany OR fresh)
  if (matchScore >= MATCH_THRESHOLDS.EXCELLENT && (isDreamCompany || isFresh)) {
    recommendedActions = ['notify', 'analyze']
    return {
      priority: 'urgent',
      reasons,
      recommendedActions,
    }
  }

  // HIGH: Match >=85% OR (Match >=70% AND dreamCompany)
  if (
    matchScore >= MATCH_THRESHOLDS.EXCELLENT ||
    (matchScore >= MATCH_THRESHOLDS.GOOD && isDreamCompany)
  ) {
    recommendedActions = ['notify', 'match']
    return {
      priority: 'high',
      reasons,
      recommendedActions,
    }
  }

  // MEDIUM: Match >=70% OR (Match >=50% AND dreamCompany)
  if (
    matchScore >= MATCH_THRESHOLDS.GOOD ||
    (matchScore >= MATCH_THRESHOLDS.FAIR && isDreamCompany)
  ) {
    recommendedActions = ['match']
    return {
      priority: 'medium',
      reasons,
      recommendedActions,
    }
  }

  // LOW: Match >=50% (we've already checked for <50% above)
  recommendedActions = ['match']
  return {
    priority: 'low',
    reasons,
    recommendedActions,
  }
}
