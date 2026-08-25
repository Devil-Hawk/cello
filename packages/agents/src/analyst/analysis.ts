// Analysis logic and response parsing for Analyst Agent

import type { LLMClient } from './llm-client'
import type { AnalysisInput, AnalysisOutput, CacheEntry } from './types'
import { generateFullAnalysisPrompt } from './prompts'

/**
 * In-memory cache for company insights with TTL
 */
export class CompanyInsightsCache {
  private cache: Map<string, CacheEntry<string[]>> = new Map()
  private defaultTTL: number

  /**
   * Create a new cache with the specified default TTL
   * @param defaultTTL Default time-to-live in milliseconds (default: 1 hour)
   */
  constructor(defaultTTL: number = 3600000) {
    this.defaultTTL = defaultTTL
  }

  /**
   * Get cached insights for a company
   * Returns undefined if not found or expired
   */
  get(companyId: string): string[] | undefined {
    const entry = this.cache.get(companyId)

    if (!entry) {
      return undefined
    }

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(companyId)
      return undefined
    }

    return entry.value
  }

  /**
   * Cache insights for a company
   * @param companyId Company identifier
   * @param insights Array of insight strings
   * @param ttl Optional TTL in milliseconds (uses default if not specified)
   */
  set(companyId: string, insights: string[], ttl?: number): void {
    const expiresAt = Date.now() + (ttl ?? this.defaultTTL)
    this.cache.set(companyId, { value: insights, expiresAt })
  }

  /**
   * Check if a company has cached insights (non-expired)
   */
  has(companyId: string): boolean {
    return this.get(companyId) !== undefined
  }

  /**
   * Clear all cached entries
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * Get the number of cached entries (including expired)
   */
  get size(): number {
    return this.cache.size
  }
}

/**
 * Performs job analysis using an LLM client
 */
export class JobAnalyzer {
  private llmClient: LLMClient
  private companyCache: CompanyInsightsCache

  constructor(llmClient: LLMClient, cache?: CompanyInsightsCache) {
    this.llmClient = llmClient
    this.companyCache = cache ?? new CompanyInsightsCache()
  }

  /**
   * Analyze a job and generate comprehensive preparation guidance
   */
  async analyze(input: AnalysisInput): Promise<AnalysisOutput> {
    // Check cache for company insights
    const cachedInsights = this.companyCache.get(input.companyId)

    // Generate full analysis prompt
    const prompt = generateFullAnalysisPrompt(input)

    // Get LLM response
    const response = await this.llmClient.complete(prompt)

    // Parse the response
    const analysis = this.parseAnalysisResponse(response)

    // Use cached insights if available and valid
    if (cachedInsights && cachedInsights.length > 0) {
      // Merge cached insights with fresh analysis, preferring fresh but keeping unique cached ones
      const freshInsightSet = new Set(analysis.companyInsights.map((i) => i.toLowerCase()))
      const uniqueCachedInsights = cachedInsights.filter(
        (i) => !freshInsightSet.has(i.toLowerCase())
      )
      analysis.companyInsights = [...analysis.companyInsights, ...uniqueCachedInsights].slice(0, 5)
    } else {
      // Cache the new company insights for future use
      this.companyCache.set(input.companyId, analysis.companyInsights)
    }

    return analysis
  }

  /**
   * Parse the LLM response into structured analysis output
   */
  private parseAnalysisResponse(response: string): AnalysisOutput {
    try {
      // Try to extract JSON from the response
      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        throw new Error('No JSON found in response')
      }

      const parsed = JSON.parse(jsonMatch[0])

      // Validate and sanitize the response
      return {
        summary: this.sanitizeString(parsed.summary) || 'Unable to generate summary.',
        talkingPoints: this.sanitizeStringArray(parsed.talkingPoints),
        companyInsights: this.sanitizeStringArray(parsed.companyInsights),
        interviewTips: this.sanitizeStringArray(parsed.interviewTips),
      }
    } catch (error) {
      // If parsing fails, return a fallback response
      console.error('Failed to parse LLM response:', error)
      return this.createFallbackResponse()
    }
  }

  /**
   * Sanitize a string value
   */
  private sanitizeString(value: unknown): string {
    if (typeof value === 'string') {
      return value.trim()
    }
    return ''
  }

  /**
   * Sanitize an array of strings
   */
  private sanitizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return []
    }
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  }

  /**
   * Create a fallback response when parsing fails
   */
  private createFallbackResponse(): AnalysisOutput {
    return {
      summary: 'Unable to generate analysis. Please try again.',
      talkingPoints: [
        'Review the job description and identify matching skills from your resume',
        'Prepare specific examples that demonstrate relevant experience',
        'Research the company and prepare thoughtful questions',
      ],
      companyInsights: [
        'Research the company website and recent news',
        'Look up employee reviews on Glassdoor',
        'Check LinkedIn for current employees and company culture',
      ],
      interviewTips: [
        'Prepare for both technical and behavioral questions',
        'Practice explaining your past projects clearly',
        'Prepare questions to ask the interviewer',
      ],
    }
  }

  /**
   * Get the company insights cache (for testing or external cache management)
   */
  getCache(): CompanyInsightsCache {
    return this.companyCache
  }
}
