import type { Job, Company } from '@cello/shared'
import type { Agent, AgentContext, ScoutResult } from '../types'
import type { ScoutInput, ParsedJob, CareerPageResult } from './types'
import { detectCareerPage, detectATSType } from './career-detector'
import { parseJobListings } from './job-parser'
import { deduplicateJobs, buildUrlSet, buildHashSet } from './deduplication'

export * from './types'
export { detectCareerPage, detectATSType, generateCareerUrls } from './career-detector'
export { parseJobListings, normalizeTitle } from './job-parser'
export { deduplicateJobs, generateJobHash, buildUrlSet, buildHashSet } from './deduplication'

/**
 * Scout Agent discovers career pages and monitors for new jobs.
 *
 * Responsibilities:
 * 1. Given a company domain, discovers the career page URL
 * 2. Parses job listings from career pages (supports common ATS patterns)
 * 3. Detects new jobs vs already-seen jobs
 * 4. Provides TypeScript interface for Python scrapers (packages/scrapers/)
 *
 * Workflow:
 * 1. Receive company domain/career URL
 * 2. Detect or validate career page
 * 3. Fetch HTML (via external scraper)
 * 4. Parse job listings based on ATS type
 * 5. Deduplicate against existing jobs
 * 6. Return new and updated jobs
 */
export class ScoutAgent implements Agent {
  name = 'Scout'
  description = 'Discovers career pages and monitors for new job listings'

  /**
   * Main execution method - scouts for new jobs from provided companies
   */
  async execute(context: AgentContext): Promise<ScoutResult> {
    const startTime = Date.now()

    try {
      const { companies, jobs: existingJobs } = context

      if (!companies || companies.length === 0) {
        return {
          success: false,
          error: 'No companies provided to scout',
          metadata: {
            duration: Date.now() - startTime,
          },
        }
      }

      const allNewJobs: Job[] = []
      const allUpdatedJobs: Job[] = []

      for (const company of companies) {
        const result = await this.scoutCompany(company, existingJobs || [])
        allNewJobs.push(...result.newJobs)
        allUpdatedJobs.push(...result.updatedJobs)
      }

      return {
        success: true,
        data: {
          newJobs: allNewJobs,
          updatedJobs: allUpdatedJobs,
        },
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
   * Scout a single company for new jobs
   */
  async scoutCompany(
    company: Company,
    existingJobs: Job[]
  ): Promise<{ newJobs: Job[]; updatedJobs: Job[] }> {
    // Get career page info
    const careerPage = this.analyzeCareerPage(company)

    // Filter existing jobs for this company
    const companyJobs = existingJobs.filter((j) => j.companyId === company.id)

    // Build deduplication sets
    const existingUrls = buildUrlSet(companyJobs)
    const existingHashes = buildHashSet(companyJobs, company.id)

    // Note: Actual HTML fetching would be done by Python scrapers
    // This method prepares the analysis - HTML is passed in separately
    // For now, return empty result (HTML will be provided externally)

    return {
      newJobs: [],
      updatedJobs: [],
    }
  }

  /**
   * Analyze career page for a company
   */
  analyzeCareerPage(company: Company): CareerPageResult {
    return detectCareerPage(company.domain || '', company.careerUrl)
  }

  /**
   * Process HTML from a career page and extract jobs
   * This is called after the Python scraper fetches the HTML
   */
  processCareerPageHtml(
    html: string,
    company: Company,
    existingJobs: Job[]
  ): { newJobs: Job[]; updatedJobs: Job[] } {
    // Detect ATS type from career URL
    const atsType = detectATSType(company.careerUrl)

    // Parse jobs from HTML
    const parsedJobs = parseJobListings(html, atsType, company.careerUrl)

    // Filter existing jobs for this company
    const companyJobs = existingJobs.filter((j) => j.companyId === company.id)

    // Build deduplication sets
    const existingUrls = buildUrlSet(companyJobs)
    const existingHashes = buildHashSet(companyJobs, company.id)

    // Deduplicate
    const { newJobs: newParsedJobs, existingJobs: existingParsedJobs } =
      deduplicateJobs(parsedJobs, company.id, existingUrls, existingHashes)

    // Convert ParsedJobs to Jobs
    const newJobs = newParsedJobs.map((parsed) =>
      this.parsedJobToJob(parsed, company)
    )

    // Check for updated jobs (same URL but potentially updated details)
    const updatedJobs = this.detectUpdatedJobs(existingParsedJobs, companyJobs, company)

    return {
      newJobs,
      updatedJobs,
    }
  }

  /**
   * Convert a ParsedJob to a Job
   */
  private parsedJobToJob(parsed: ParsedJob, company: Company): Job {
    return {
      id: '', // Will be assigned by database
      companyId: company.id,
      title: parsed.title,
      description: '', // Description will be fetched separately
      url: parsed.url,
      location: parsed.location || null,
      salaryRange: null,
      jobType: null,
      postedAt: parsed.postedAt || null,
      discoveredAt: new Date(),
      matchScore: null,
      matchDetails: null,
      isNew: true,
    }
  }

  /**
   * Detect jobs that have been updated (same URL, different details)
   */
  private detectUpdatedJobs(
    parsedExisting: ParsedJob[],
    existingJobs: Job[],
    company: Company
  ): Job[] {
    const updatedJobs: Job[] = []

    // Create a map of existing jobs by URL
    const existingByUrl = new Map(existingJobs.map((j) => [j.url, j]))

    for (const parsed of parsedExisting) {
      const existing = existingByUrl.get(parsed.url)
      if (!existing) continue

      // Check if any details changed
      const titleChanged = parsed.title !== existing.title
      const locationChanged =
        parsed.location !== undefined && parsed.location !== existing.location

      if (titleChanged || locationChanged) {
        updatedJobs.push({
          ...existing,
          title: titleChanged ? parsed.title : existing.title,
          location: locationChanged ? (parsed.location ?? null) : existing.location,
          isNew: false,
        })
      }
    }

    return updatedJobs
  }

  /**
   * Prepare scout input from a company
   */
  prepareScoutInput(company: Company): ScoutInput {
    return {
      companyId: company.id,
      domain: company.domain || '',
      existingCareerUrl: company.careerUrl,
    }
  }
}
