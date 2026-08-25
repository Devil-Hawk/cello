// Coach Agent specific types

import type { LLMClient } from '../analyst/llm-client'
import type { PipelineStage } from '@cello/shared'

/**
 * Configuration options for the Coach Agent
 */
export interface CoachAgentConfig {
  /** Custom LLM client (useful for testing) */
  llmClient?: LLMClient
}

/**
 * Follow-up timing configuration for each stage
 */
export interface FollowUpTiming {
  /** Minimum days before suggesting follow-up */
  minDays: number
  /** Maximum days (urgent threshold) */
  maxDays: number
  /** Suggested action */
  suggestion: string
}

/**
 * Message types the coach can generate
 */
export type MessageType = 'follow_up' | 'thank_you' | 'cold_outreach' | 'check_in'

/**
 * Context for message generation
 */
export interface MessageContext {
  /** User's full name */
  userName: string
  /** Company name */
  companyName: string
  /** Job title */
  jobTitle: string
  /** Current application stage */
  stage?: PipelineStage
  /** Days since last activity */
  daysSinceLastActivity?: number
  /** Contact name if reaching out to specific person */
  contactName?: string
  /** Contact's job title */
  contactTitle?: string
  /** How user knows this contact */
  relationship?: string
  /** Additional notes about the application */
  applicationNotes?: string
}

/**
 * Options for LLM completion in coach context
 */
export interface CoachCompletionOptions {
  maxTokens?: number
  temperature?: number
}

/**
 * Stages that support follow-up suggestions
 */
export type FollowUpStage = 'applied' | 'screen' | 'interview' | 'offer'

/**
 * Check if a stage supports follow-up
 */
export function isFollowUpStage(stage: PipelineStage): stage is FollowUpStage {
  return ['applied', 'screen', 'interview', 'offer'].includes(stage)
}
