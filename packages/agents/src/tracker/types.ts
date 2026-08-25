// Tracker Agent specific types

import type { PipelineStage } from '@cello/shared'

/**
 * Input email to be analyzed for application status changes
 */
export interface EmailInput {
  id: string
  from: string
  subject: string
  body: string
  receivedAt: Date
}

/**
 * Parsed email with normalized text for pattern matching
 */
export interface ParsedEmail {
  id: string
  from: string
  subject: string
  body: string
  normalizedSubject: string
  normalizedBody: string
  receivedAt: Date
}

/**
 * A detected status signal from an email
 */
export interface StatusSignal {
  stage: PipelineStage
  confidence: number // 0-1 scale
  reason: string
}

/**
 * Pattern configuration for email parsing
 */
export interface EmailPattern {
  pattern: RegExp
  stage: PipelineStage
  confidence: number
  source: 'subject' | 'body' | 'both'
}

/**
 * Result of processing an email for status detection
 */
export interface EmailProcessingResult {
  applicationId: string
  previousStage: string
  newStage: string
  confidence: number
  emailSubject: string
  reason: string
}

/**
 * Ghost detection result for an application
 */
export interface GhostingResult {
  applicationId: string
  status: import('./ghost-detector').GhostStatus
  daysSinceActivity: number
  shouldFollowUp: boolean
  shouldMoveToGhosted: boolean
  message: string
}
