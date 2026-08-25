import type { Job, Company, Application, UserProfile } from '@cello/shared'

// Base agent interface
export interface Agent {
  name: string
  description: string
  execute(context: AgentContext): Promise<AgentResult>
}

// Context passed to all agents
export interface AgentContext {
  user: UserProfile
  companies?: Company[]
  jobs?: Job[]
  applications?: Application[]
  apiKeys?: AgentApiKeys
}

// API keys for AI services (provided by user)
export interface AgentApiKeys {
  openai?: string
  anthropic?: string
  /**
   * OpenRouter key. The web app stores only this provider for most users
   * (lib/harness/llm.ts routes every harness feature through OpenRouter), so
   * without it the analyst silently fell back to MockLLMClient.
   */
  openrouter?: string
}

// Standard agent result
export interface AgentResult {
  success: boolean
  data?: unknown
  error?: string
  metadata?: {
    tokensUsed?: number
    duration?: number
  }
}

// Scout Agent types
export interface ScoutResult extends AgentResult {
  data?: {
    newJobs: Job[]
    updatedJobs: Job[]
  }
}

// Matcher Agent types
export interface MatcherResult extends AgentResult {
  data?: {
    jobId: string
    score: number
    highlights: string[]
    gaps: string[]
  }
}

// Analyst Agent types
export interface AnalystResult extends AgentResult {
  data?: {
    jobId: string
    summary: string
    talkingPoints: string[]
    companyInsights: string[]
    interviewTips: string[]
  }
}

// Tracker Agent types
export interface TrackerResult extends AgentResult {
  data?: {
    applicationId: string
    previousStage: string
    newStage: string
    emailSubject?: string
  }
}

// Coach Agent types
export interface CoachResult extends AgentResult {
  data?: {
    applicationId: string
    suggestion: string
    suggestedContacts?: string[]
    draftMessage?: string
  }
}
