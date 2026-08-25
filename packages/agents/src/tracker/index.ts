import type { Application } from '@cello/shared'
import type { Agent, AgentContext, TrackerResult } from '../types'
import type { EmailInput, EmailProcessingResult, GhostingResult } from './types'
import { extractStatusSignals } from './email-parser'
import { detectStatus, isValidTransition, mapSignalToStage } from './status-detector'
import { detectGhosting, detectGhostingBatch, GhostStatus } from './ghost-detector'

export * from './types'
export { parseEmail, extractStatusSignals, normalizeText, EMAIL_PATTERNS } from './email-parser'
export { detectStatus, mapSignalToStage, isValidTransition, getStageOrder, isTerminalStage, getValidNextStages } from './status-detector'
export { detectGhosting, detectGhostingBatch, getGhostedApplications, getFollowUpApplications, getGhostStatus, GhostStatus, daysBetween } from './ghost-detector'

/**
 * Tracker Agent monitors Gmail and detects application status changes.
 *
 * Responsibilities:
 * 1. Parses email subjects and bodies for status indicators
 * 2. Maps email patterns to pipeline stages with confidence scores
 * 3. Detects ghosting based on time thresholds
 * 4. Provides TypeScript interface (actual Gmail API calls in web app)
 *
 * Workflow:
 * 1. Receive emails from Gmail API (via web app)
 * 2. Parse and extract status signals
 * 3. Match emails to applications
 * 4. Detect status changes with confidence
 * 5. Check for ghosted applications
 * 6. Return detected changes and suggestions
 */
export class TrackerAgent implements Agent {
  name = 'Tracker'
  description = 'Monitors email for application status changes and detects ghosting'

  /**
   * Main execution method - checks applications for ghosting
   *
   * Note: Email processing is done via processEmail() which is called
   * separately when new emails are received.
   */
  async execute(context: AgentContext): Promise<TrackerResult> {
    const startTime = Date.now()

    try {
      const { applications } = context

      if (!applications || applications.length === 0) {
        return {
          success: false,
          error: 'No applications provided to track',
          metadata: {
            duration: Date.now() - startTime,
          },
        }
      }

      // Check all applications for ghosting
      const ghostResults = detectGhostingBatch(applications)

      // Find any that should be moved to ghosted
      const ghostedApps = ghostResults.filter((r) => r.shouldMoveToGhosted)

      // If there are ghosted applications, return the first one
      // (in practice, the caller would process all of them)
      if (ghostedApps.length > 0) {
        const firstGhosted = ghostedApps[0]
        const app = applications.find((a) => a.id === firstGhosted.applicationId)

        return {
          success: true,
          data: {
            applicationId: firstGhosted.applicationId,
            previousStage: app?.stage || 'unknown',
            newStage: 'ghosted',
          },
          metadata: {
            duration: Date.now() - startTime,
          },
        }
      }

      // No changes detected
      return {
        success: true,
        metadata: {
          duration: Date.now() - startTime,
        },
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
        metadata: {
          duration: Date.now() - startTime,
        },
      }
    }
  }

  /**
   * Process an email and detect status changes for an application
   *
   * @param email The email to process
   * @param application The application to check against
   * @returns Processing result with stage change, or null if no change detected
   */
  processEmail(
    email: EmailInput,
    application: Application
  ): EmailProcessingResult | null {
    // Extract status signals from email
    const signals = extractStatusSignals(email)

    if (signals.length === 0) {
      return null
    }

    // Get the best status signal
    const bestSignal = detectStatus(signals)

    if (!bestSignal) {
      return null
    }

    // Check if the transition is valid
    const newStage = mapSignalToStage(bestSignal)

    if (!isValidTransition(application.stage, newStage)) {
      return null
    }

    return {
      applicationId: application.id,
      previousStage: application.stage,
      newStage,
      confidence: bestSignal.confidence,
      emailSubject: email.subject,
      reason: bestSignal.reason,
    }
  }

  /**
   * Process multiple emails for an application
   */
  processEmails(
    emails: EmailInput[],
    application: Application
  ): EmailProcessingResult[] {
    const results: EmailProcessingResult[] = []

    // Sort emails by date (oldest first)
    const sortedEmails = [...emails].sort(
      (a, b) => a.receivedAt.getTime() - b.receivedAt.getTime()
    )

    // Track current stage as we process
    let currentStage = application.stage

    for (const email of sortedEmails) {
      const result = this.processEmail(email, {
        ...application,
        stage: currentStage,
      })

      if (result) {
        results.push(result)
        // Update current stage for subsequent emails
        currentStage = result.newStage as typeof currentStage
      }
    }

    return results
  }

  /**
   * Check an application for ghosting
   */
  checkGhosting(application: Application, now: Date = new Date()): GhostingResult {
    return detectGhosting(application, now)
  }

  /**
   * Check multiple applications for ghosting
   */
  checkGhostingBatch(
    applications: Application[],
    now: Date = new Date()
  ): GhostingResult[] {
    return detectGhostingBatch(applications, now)
  }

  /**
   * Match an email to potential applications based on sender domain
   *
   * @param email The email to match
   * @param applications List of applications to check
   * @param companyDomains Map of company IDs to their email domains
   * @returns Matching applications
   */
  matchEmailToApplications(
    email: EmailInput,
    applications: Application[],
    companyDomains: Map<string, string[]>
  ): Application[] {
    // Extract domain from sender email
    const senderDomain = this.extractDomain(email.from)

    if (!senderDomain) {
      return []
    }

    // Find applications whose company domain matches the sender
    return applications.filter((app) => {
      // This would require job -> company lookup
      // For now, return empty - actual implementation needs company data
      return false
    })
  }

  /**
   * Extract domain from an email address
   */
  private extractDomain(email: string): string | null {
    const match = email.match(/@([a-zA-Z0-9.-]+)$/)
    return match ? match[1].toLowerCase() : null
  }
}
