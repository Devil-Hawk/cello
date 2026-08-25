import type { AgentResult } from '../types'

// Priority levels for job processing
export type Priority = 'urgent' | 'high' | 'medium' | 'low'

// Recommended actions for a job
export type RecommendedAction = 'notify' | 'analyze' | 'match' | 'skip'

// Data structure for orchestrator decisions
export interface OrchestratorData {
  jobId: string
  priority: Priority
  score: number
  reasons: string[]
  recommendedActions: RecommendedAction[]
}

// Extended result from orchestrator agent
export interface OrchestratorResult extends AgentResult {
  data?: OrchestratorData
}

// Input for priority calculation
export interface PriorityInput {
  matchScore: number
  isDreamCompany: boolean
  hoursAgo: number // Hours since job was posted
}

// Result from priority calculation
export interface PriorityResult {
  priority: Priority | 'skip'
  reasons: string[]
  recommendedActions: RecommendedAction[]
}
