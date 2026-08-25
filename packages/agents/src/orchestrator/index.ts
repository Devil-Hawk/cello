import type { Job, Company } from '@cello/shared'
import type { Agent, AgentContext } from '../types'
import type { OrchestratorResult, OrchestratorData } from './types'
import { calculatePriority } from './priority'

export * from './types'
export { calculatePriority } from './priority'

/**
 * Orchestrator Agent coordinates all other agents and decides actions.
 *
 * Responsibilities:
 * 1. Receives job discovery events from Scout Agent
 * 2. Routes jobs to Matcher for scoring
 * 3. Decides urgency/priority based on: match score + company importance + freshness
 * 4. Returns priority level and recommended actions
 */
export class OrchestratorAgent implements Agent {
  name = 'Orchestrator'
  description =
    'Coordinates all agents and decides job processing priority and actions'

  async execute(context: AgentContext): Promise<OrchestratorResult> {
    const startTime = Date.now()

    try {
      const { jobs, companies } = context

      if (!jobs || jobs.length === 0) {
        return {
          success: false,
          error: 'No jobs provided to orchestrator',
          metadata: {
            duration: Date.now() - startTime,
          },
        }
      }

      // Process the first job (single job processing)
      // For batch processing, this could be extended
      const job = jobs[0]
      const company = companies?.find((c) => c.id === job.companyId)

      const result = this.processJob(job, company)

      return {
        success: true,
        data: result,
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
   * Process a single job and determine its priority and recommended actions
   */
  processJob(job: Job, company?: Company): OrchestratorData {
    const matchScore = job.matchScore ?? 0
    const isDreamCompany = company?.isDreamCompany ?? false
    const hoursAgo = this.calculateHoursAgo(job.postedAt ?? job.discoveredAt)

    const priorityResult = calculatePriority({
      matchScore,
      isDreamCompany,
      hoursAgo,
    })

    // If priority is 'skip', we still return the data but with no priority
    // The calling code can decide what to do with skipped jobs
    const priority = priorityResult.priority === 'skip' ? 'low' : priorityResult.priority

    return {
      jobId: job.id,
      priority,
      score: matchScore,
      reasons: priorityResult.reasons,
      recommendedActions: priorityResult.recommendedActions,
    }
  }

  /**
   * Calculate how many hours ago a date was
   */
  private calculateHoursAgo(date: Date): number {
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    return diffMs / (1000 * 60 * 60)
  }

  /**
   * Process multiple jobs and sort by priority
   */
  async processJobs(
    jobs: Job[],
    companies: Company[]
  ): Promise<OrchestratorData[]> {
    const companyMap = new Map(companies.map((c) => [c.id, c]))

    const results = jobs.map((job) => {
      const company = companyMap.get(job.companyId)
      return this.processJob(job, company)
    })

    // Sort by priority (urgent first, then high, medium, low)
    const priorityOrder = { urgent: 0, high: 1, medium: 2, low: 3 }
    return results.sort(
      (a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]
    )
  }
}
