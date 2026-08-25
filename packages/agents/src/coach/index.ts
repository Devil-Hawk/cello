// Coach Agent - Suggests follow-ups and drafts outreach messages

import type { Application, Job, Company, Contact } from '@cello/shared'
import type { Agent, AgentContext, CoachResult } from '../types'
import type { CoachAgentConfig, MessageContext, MessageType } from './types'
import { createLLMClient, type LLMClient } from '../analyst/llm-client'
import {
  shouldSuggestFollowUp,
  getFollowUpTiming,
  getTimingSuggestion,
  daysSince,
  getLastActivityDate,
} from './timing'
import { generateMessageByType, getFallbackMessage } from './message-generator'

export * from './types'
export * from './timing'
export * from './message-generator'
export * from './templates'

/**
 * Extended agent context that includes contacts
 */
interface ExtendedAgentContext extends AgentContext {
  contacts?: Contact[]
}

/**
 * Coach Agent provides follow-up suggestions and drafts outreach messages.
 *
 * Responsibilities:
 * 1. Determines when and how to follow up based on application stage and timing
 * 2. Drafts personalized outreach messages (follow-ups, cold intros, thank-yous)
 * 3. Suggests contacts to reach out to based on company
 * 4. Uses LLM API for message generation
 *
 * Workflow:
 * 1. Receive applications and context
 * 2. Check timing for each application to determine if follow-up is needed
 * 3. Identify relevant contacts at the company
 * 4. Generate appropriate message using LLM
 * 5. Return structured CoachResult with suggestions
 */
export class CoachAgent implements Agent {
  name = 'Coach'
  description = 'Suggests follow-ups and drafts personalized outreach messages'

  private llmClient: LLMClient | null = null
  private config: CoachAgentConfig

  constructor(config: CoachAgentConfig = {}) {
    this.config = config

    // Use provided LLM client if available (for testing)
    if (config.llmClient) {
      this.llmClient = config.llmClient
    }
  }

  /**
   * Main execution method - analyzes the first application in context
   */
  async execute(context: AgentContext): Promise<CoachResult> {
    const startTime = Date.now()

    try {
      // Validate inputs
      if (!context.user) {
        return this.createErrorResult('No user profile provided', startTime)
      }

      if (!context.applications || context.applications.length === 0) {
        return this.createErrorResult('No applications provided for coaching', startTime)
      }

      // Initialize LLM client if not already done (from context API keys)
      this.initializeLLMClient(context)

      // Get the first application to analyze
      const application = context.applications[0]

      // Find the job and company for this application
      const job = context.jobs?.find((j) => j.id === application.jobId)
      const company = job
        ? context.companies?.find((c) => c.id === job.companyId)
        : undefined

      // Find contacts at this company
      const extendedContext = context as ExtendedAgentContext
      const companyContacts = company
        ? extendedContext.contacts?.filter((c) => c.companyId === company.id) || []
        : []

      // Analyze timing and generate suggestion
      const result = await this.generateCoachingResult(
        application,
        job,
        company,
        companyContacts,
        context.user.fullName || 'Job Seeker',
        startTime
      )

      return result
    } catch (error) {
      return this.createErrorResult(
        error instanceof Error ? error.message : 'Unknown error occurred',
        startTime
      )
    }
  }

  /**
   * Generate the coaching result for an application
   */
  private async generateCoachingResult(
    application: Application,
    job: Job | undefined,
    company: Company | undefined,
    contacts: Contact[],
    userName: string,
    startTime: number
  ): Promise<CoachResult> {
    const lastActivity = getLastActivityDate(application)
    const days = daysSince(lastActivity)
    const timing = getFollowUpTiming(application.stage)

    // Check if follow-up is suggested
    const shouldFollowUp = shouldSuggestFollowUp(application.stage, lastActivity)

    let suggestion: string
    let draftMessage: string | undefined
    const suggestedContacts = contacts.map((c) => c.name)

    if (!shouldFollowUp) {
      // Too soon to follow up
      suggestion = timing
        ? `It's too soon to follow up. Wait until day ${timing.minDays} since applying (currently day ${days}).`
        : 'No follow-up action needed at this stage.'
    } else {
      // Generate suggestion and draft message
      suggestion = getTimingSuggestion(application.stage, days)

      const messageType = this.getSuggestedMessageType(application)
      const messageContext: MessageContext = {
        userName,
        companyName: company?.name || 'the company',
        jobTitle: job?.title || 'the position',
        stage: application.stage,
        daysSinceLastActivity: days,
        contactName: contacts[0]?.name,
        contactTitle: contacts[0]?.title || undefined,
        applicationNotes: application.notes || undefined,
      }

      try {
        if (this.llmClient) {
          draftMessage = await generateMessageByType(
            this.llmClient,
            messageType,
            messageContext
          )
        } else {
          draftMessage = getFallbackMessage(messageType, messageContext)
        }
      } catch {
        // If LLM fails, use fallback template
        draftMessage = getFallbackMessage(messageType, messageContext)
      }
    }

    return {
      success: true,
      data: {
        applicationId: application.id,
        suggestion,
        suggestedContacts: suggestedContacts.length > 0 ? suggestedContacts : undefined,
        draftMessage,
      },
      metadata: {
        duration: Date.now() - startTime,
      },
    }
  }

  /**
   * Determine the best message type based on application stage and timing
   */
  getSuggestedMessageType(application: Application): MessageType {
    const lastActivity = getLastActivityDate(application)
    const days = daysSince(lastActivity)

    switch (application.stage) {
      case 'interview':
        // After interview, suggest thank you if within 2 days, otherwise follow-up
        return days <= 2 ? 'thank_you' : 'follow_up'

      case 'screen':
        // After screen, suggest thank you if within 3 days, otherwise check-in
        return days <= 3 ? 'thank_you' : 'check_in'

      case 'offer':
        // At offer stage, usually need to follow up on specifics
        return 'follow_up'

      case 'applied':
      default:
        // For applied stage, standard follow-up
        return 'follow_up'
    }
  }

  /**
   * Initialize LLM client from context API keys if not already initialized
   */
  private initializeLLMClient(context: AgentContext): void {
    // Skip if already initialized (e.g., from constructor)
    if (this.llmClient) {
      return
    }

    // Create client from API keys
    this.llmClient = createLLMClient(context.apiKeys ?? {})
  }

  /**
   * Create an error result with duration metadata
   */
  private createErrorResult(error: string, startTime: number): CoachResult {
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
}
