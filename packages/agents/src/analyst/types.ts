// Analyst Agent specific types

import type { LLMClient } from './llm-client'

/**
 * Configuration options for the Analyst Agent
 */
export interface AnalystAgentConfig {
  /** Custom LLM client (useful for testing) */
  llmClient?: LLMClient
  /** Default TTL for company insights cache (in milliseconds) */
  cacheTTL?: number
}

/**
 * Input for analyzing a job
 */
export interface AnalysisInput {
  jobId: string
  jobTitle: string
  jobDescription: string
  companyId: string
  companyName: string
  companyNotes?: string | null
  resumeText: string
}

/**
 * Raw analysis output from LLM
 */
export interface AnalysisOutput {
  summary: string
  talkingPoints: string[]
  companyInsights: string[]
  interviewTips: string[]
}

/**
 * Cached company insights entry
 */
export interface CacheEntry<T> {
  value: T
  expiresAt: number
}

/**
 * Types of analysis prompts
 */
export type PromptType =
  | 'job_summary'
  | 'talking_points'
  | 'company_insights'
  | 'interview_tips'
  | 'full_analysis'

/**
 * Options for LLM completion
 */
export interface CompletionOptions {
  maxTokens?: number
  temperature?: number
  systemPrompt?: string
}
