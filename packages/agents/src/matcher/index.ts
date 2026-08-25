/**
 * Matcher Agent - Compares jobs to resume and calculates match scores
 *
 * The Matcher Agent is responsible for:
 * 1. Calculating overall match score between jobs and user profile
 * 2. Breaking down match into sub-scores (skills, experience, location)
 * 3. Extracting highlights (why job fits) and gaps (missing requirements)
 * 4. Using embeddings for semantic similarity (optional enhancement)
 */

import type { Job, UserProfile, MatchDetails } from '@cello/shared'
import type { Agent, AgentContext, MatcherResult, AgentApiKeys } from '../types'
import type { SingleMatchResult, EmbeddingConfig } from './types'
import {
  calculateSkillsMatch,
  calculateExperienceMatch,
  calculateLocationMatch,
  calculateOverallScore,
  extractSkillsFromText,
  extractExperienceRequirement,
  extractYearsFromResume,
} from './scoring'
import { extractHighlights, extractGaps } from './analysis'
import { EmbeddingProvider, cosineSimilarity, createEmbeddingProvider } from './embeddings'

// Re-export modules
export * from './types'
export * from './scoring'
export * from './analysis'
export * from './embeddings'

/**
 * MatcherAgent compares jobs against user profile and calculates fit scores.
 *
 * Usage:
 * ```typescript
 * const matcher = new MatcherAgent()
 *
 * // Match a single job
 * const matchDetails = await matcher.matchJob(job, userProfile)
 *
 * // Match multiple jobs via execute
 * const result = await matcher.execute({
 *   user: userProfile,
 *   jobs: [job1, job2, job3]
 * })
 *
 * // Get all matches
 * const allMatches = await matcher.matchAll(context)
 * ```
 */
export class MatcherAgent implements Agent {
  name = 'Matcher'
  description = 'Compares job descriptions to resume and calculates match percentage'

  private embeddingProvider: EmbeddingProvider | null = null

  constructor(embeddingConfig?: Partial<EmbeddingConfig>) {
    if (embeddingConfig) {
      this.embeddingProvider = new EmbeddingProvider(embeddingConfig)
    }
  }

  /**
   * Main execution method - matches first job from context
   * Returns MatcherResult for the first job
   */
  async execute(context: AgentContext): Promise<MatcherResult> {
    const startTime = Date.now()

    try {
      const { user, jobs, apiKeys } = context

      // Validation
      if (!jobs || jobs.length === 0) {
        return {
          success: false,
          error: 'No jobs provided to match',
          metadata: { duration: Date.now() - startTime },
        }
      }

      if (!user.resumeText || user.resumeText.trim().length === 0) {
        return {
          success: false,
          error: 'No resume text available for matching',
          metadata: { duration: Date.now() - startTime },
        }
      }

      // Initialize embedding provider with API key if available
      if (!this.embeddingProvider && apiKeys?.openai) {
        this.embeddingProvider = createEmbeddingProvider(apiKeys.openai)
      }

      // Match the first job (for single result interface)
      const job = jobs[0]
      const matchDetails = await this.matchJob(job, user, apiKeys)

      return {
        success: true,
        data: {
          jobId: job.id,
          score: matchDetails.overallScore,
          highlights: matchDetails.highlights,
          gaps: matchDetails.gaps,
        },
        metadata: {
          duration: Date.now() - startTime,
        },
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
        metadata: { duration: Date.now() - startTime },
      }
    }
  }

  /**
   * Match all jobs in context
   */
  async matchAll(context: AgentContext): Promise<SingleMatchResult[]> {
    const { user, jobs, apiKeys } = context

    if (!jobs || !user.resumeText) {
      return []
    }

    // Initialize embedding provider with API key if available
    if (!this.embeddingProvider && apiKeys?.openai) {
      this.embeddingProvider = createEmbeddingProvider(apiKeys.openai)
    }

    const results: SingleMatchResult[] = []

    for (const job of jobs) {
      const matchDetails = await this.matchJob(job, user, apiKeys)
      results.push({
        jobId: job.id,
        score: matchDetails.overallScore,
        highlights: matchDetails.highlights,
        gaps: matchDetails.gaps,
        details: matchDetails,
      })
    }

    return results
  }

  /**
   * Match a single job against user profile
   */
  async matchJob(
    job: Job,
    user: UserProfile,
    apiKeys?: AgentApiKeys
  ): Promise<MatchDetails> {
    const resumeText = user.resumeText || ''
    const jobDescription = job.description

    // Extract requirements from job
    const requiredSkills = extractSkillsFromText(jobDescription)
    const experienceReq = extractExperienceRequirement(jobDescription)

    // Extract info from resume
    const resumeYears = extractYearsFromResume(resumeText)

    // Calculate sub-scores
    const skillsMatch = calculateSkillsMatch(
      requiredSkills.map((s) => s.name),
      resumeText
    )

    const experienceMatch = calculateExperienceMatch(
      experienceReq.yearsMin,
      resumeYears
    )

    const locationMatch = calculateLocationMatch(
      job.location,
      user.preferences?.preferredLocations || [],
      user.preferences?.remotePreference || 'any'
    )

    // Calculate overall score
    let overallScore = calculateOverallScore(skillsMatch, experienceMatch, locationMatch)

    // Optionally enhance with embedding similarity
    if (this.embeddingProvider && resumeText && jobDescription) {
      try {
        const embeddingSimilarity = await this.embeddingProvider.computeSimilarity(
          resumeText,
          jobDescription
        )
        // Blend embedding score with calculated score (10% weight)
        const embeddingScore = Math.round(embeddingSimilarity * 100)
        overallScore = Math.round(overallScore * 0.9 + embeddingScore * 0.1)
      } catch {
        // Silently fall back to calculated score only
      }
    }

    // Extract highlights and gaps
    const highlights = extractHighlights(jobDescription, resumeText, job)
    const gaps = extractGaps(jobDescription, resumeText, job)

    return {
      overallScore,
      skillsMatch,
      experienceMatch,
      locationMatch,
      highlights,
      gaps,
    }
  }

  /**
   * Match job using pre-computed embeddings (faster for bulk operations)
   */
  matchJobWithEmbeddings(
    job: Job,
    user: UserProfile,
    jobEmbedding: number[],
    resumeEmbedding: number[]
  ): MatchDetails {
    const resumeText = user.resumeText || ''
    const jobDescription = job.description

    // Extract requirements from job
    const requiredSkills = extractSkillsFromText(jobDescription)
    const experienceReq = extractExperienceRequirement(jobDescription)

    // Extract info from resume
    const resumeYears = extractYearsFromResume(resumeText)

    // Calculate sub-scores
    const skillsMatch = calculateSkillsMatch(
      requiredSkills.map((s) => s.name),
      resumeText
    )

    const experienceMatch = calculateExperienceMatch(
      experienceReq.yearsMin,
      resumeYears
    )

    const locationMatch = calculateLocationMatch(
      job.location,
      user.preferences?.preferredLocations || [],
      user.preferences?.remotePreference || 'any'
    )

    // Calculate overall score with embedding blend
    let overallScore = calculateOverallScore(skillsMatch, experienceMatch, locationMatch)

    // Blend with embedding similarity
    const embeddingSimilarity = cosineSimilarity(jobEmbedding, resumeEmbedding)
    const embeddingScore = Math.round(Math.max(0, embeddingSimilarity) * 100)
    overallScore = Math.round(overallScore * 0.9 + embeddingScore * 0.1)

    // Extract highlights and gaps
    const highlights = extractHighlights(jobDescription, resumeText, job)
    const gaps = extractGaps(jobDescription, resumeText, job)

    return {
      overallScore,
      skillsMatch,
      experienceMatch,
      locationMatch,
      highlights,
      gaps,
    }
  }

  /**
   * Set custom embedding provider
   */
  setEmbeddingProvider(provider: EmbeddingProvider): void {
    this.embeddingProvider = provider
  }

  /**
   * Get current embedding provider (for testing)
   */
  getEmbeddingProvider(): EmbeddingProvider | null {
    return this.embeddingProvider
  }
}
