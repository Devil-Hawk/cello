// Analyst Agent - Provides deep analysis, company research, and talking points

import type { Job, Company, UserProfile } from '@cello/shared'
import type { Agent, AgentContext, AnalystResult } from '../types'
import type { AnalystAgentConfig, AnalysisInput, AnalysisOutput } from './types'
import { createLLMClient, type LLMClient } from './llm-client'
import { JobAnalyzer, CompanyInsightsCache } from './analysis'

export * from './types'
export { createLLMClient, MockLLMClient, OpenAILLMClient, AnthropicLLMClient } from './llm-client'
export type { LLMClient } from './llm-client'
export { CompanyInsightsCache, JobAnalyzer } from './analysis'
export * from './prompts'

/**
 * Analyst Agent provides deep analysis of job opportunities.
 *
 * Responsibilities:
 * 1. Analyzes job descriptions to extract key requirements
 * 2. Generates talking points based on resume fit
 * 3. Provides company insights and interview tips
 * 4. Uses LLM API (OpenAI/Anthropic) via user's keys
 *
 * Workflow:
 * 1. Receive job and user context
 * 2. Build analysis prompt with job description and resume
 * 3. Call LLM to generate structured analysis
 * 4. Parse and validate response
 * 5. Cache company insights for reuse
 * 6. Return structured AnalystResult
 */
export class AnalystAgent implements Agent {
  name = 'Analyst'
  description = 'Provides deep job analysis, talking points, and interview preparation guidance'

  private llmClient: LLMClient | null = null
  private analyzer: JobAnalyzer | null = null
  private config: AnalystAgentConfig

  constructor(config: AnalystAgentConfig = {}) {
    this.config = config

    // Use provided LLM client if available (for testing)
    if (config.llmClient) {
      this.llmClient = config.llmClient
      this.analyzer = new JobAnalyzer(
        this.llmClient,
        new CompanyInsightsCache(config.cacheTTL)
      )
    }
  }

  /**
   * Main execution method - analyzes the first job in context
   */
  async execute(context: AgentContext): Promise<AnalystResult> {
    const startTime = Date.now()

    try {
      // Validate inputs
      if (!context.user) {
        return this.createErrorResult('No user profile provided', startTime)
      }

      if (!context.user.resumeText) {
        return this.createErrorResult(
          'No resume available. Please upload your resume to enable job analysis.',
          startTime
        )
      }

      if (!context.jobs || context.jobs.length === 0) {
        return this.createErrorResult('No jobs provided for analysis', startTime)
      }

      // Initialize LLM client if not already done (from context API keys)
      this.initializeLLMClient(context)

      // Get the first job to analyze
      const job = context.jobs[0]

      // Find the company for this job
      const company = context.companies?.find((c) => c.id === job.companyId)

      // Perform analysis
      const analysis = await this.analyzeJob(job, company, context.user)

      return {
        success: true,
        data: {
          jobId: job.id,
          summary: analysis.summary,
          talkingPoints: analysis.talkingPoints,
          companyInsights: analysis.companyInsights,
          interviewTips: analysis.interviewTips,
        },
        metadata: {
          duration: Date.now() - startTime,
        },
      }
    } catch (error) {
      return this.createErrorResult(
        error instanceof Error ? error.message : 'Unknown error occurred',
        startTime
      )
    }
  }

  /**
   * Analyze a specific job and generate preparation guidance
   */
  async analyzeJob(
    job: Job,
    company: Company | undefined,
    user: UserProfile
  ): Promise<AnalysisOutput> {
    if (!this.analyzer) {
      throw new Error('LLM client not initialized')
    }

    const input: AnalysisInput = {
      jobId: job.id,
      jobTitle: job.title,
      jobDescription: job.description,
      companyId: job.companyId,
      companyName: company?.name ?? 'Unknown Company',
      companyNotes: company?.notes,
      resumeText: user.resumeText!,
    }

    return this.analyzer.analyze(input)
  }

  /**
   * Initialize LLM client from context API keys if not already initialized
   */
  private initializeLLMClient(context: AgentContext): void {
    // Skip if already initialized (e.g., from constructor)
    if (this.llmClient && this.analyzer) {
      return
    }

    // Create client from API keys
    this.llmClient = createLLMClient(context.apiKeys ?? {})
    this.analyzer = new JobAnalyzer(
      this.llmClient,
      new CompanyInsightsCache(this.config.cacheTTL)
    )
  }

  /**
   * Create an error result with duration metadata
   */
  private createErrorResult(error: string, startTime: number): AnalystResult {
    return {
      success: false,
      error,
      metadata: {
        duration: Date.now() - startTime,
      },
    }
  }

  /**
   * Get the current LLM client (for testing/debugging)
   */
  getLLMClient(): LLMClient | null {
    return this.llmClient
  }

  /**
   * Get the job analyzer (for testing/debugging)
   */
  getAnalyzer(): JobAnalyzer | null {
    return this.analyzer
  }
}
