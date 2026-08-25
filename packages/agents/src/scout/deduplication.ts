import type { ParsedJob, DeduplicationResult } from './types'
import { normalizeTitle } from './job-parser'

/**
 * Generates a hash for a job based on company ID and normalized title
 * This is used as a secondary deduplication method when URLs differ
 */
export function generateJobHash(companyId: string, title: string): string {
  const normalizedTitle = normalizeTitle(title)
  const combined = `${companyId}:${normalizedTitle}`

  // Simple hash function (djb2)
  let hash = 5381
  for (let i = 0; i < combined.length; i++) {
    hash = (hash * 33) ^ combined.charCodeAt(i)
  }

  // Convert to unsigned 32-bit integer and then to hex
  return (hash >>> 0).toString(16)
}

/**
 * Deduplicates jobs against existing job URLs and title hashes
 *
 * Deduplication strategy:
 * 1. Primary: Check if job URL already exists (exact match)
 * 2. Secondary: Check if (company_id + normalized_title) hash exists
 *
 * @param jobs - Parsed jobs from the career page
 * @param companyId - The company ID for hash generation
 * @param existingUrls - Set of existing job URLs
 * @param existingHashes - Set of existing job hashes (company_id + title)
 * @returns Deduplication result with new and existing jobs
 */
export function deduplicateJobs(
  jobs: ParsedJob[],
  companyId: string,
  existingUrls: Set<string>,
  existingHashes: Set<string>
): DeduplicationResult {
  const newJobs: ParsedJob[] = []
  const existingJobs: ParsedJob[] = []

  for (const job of jobs) {
    // Primary check: URL match
    if (existingUrls.has(job.url)) {
      existingJobs.push(job)
      continue
    }

    // Secondary check: Title hash match
    const hash = generateJobHash(companyId, job.title)
    if (existingHashes.has(hash)) {
      existingJobs.push(job)
      continue
    }

    // Job is new
    newJobs.push(job)
  }

  return {
    newJobs,
    existingJobs,
  }
}

/**
 * Builds a set of job URLs from an array of jobs
 */
export function buildUrlSet(jobs: Array<{ url: string }>): Set<string> {
  return new Set(jobs.map((job) => job.url))
}

/**
 * Builds a set of job hashes from an array of jobs
 */
export function buildHashSet(
  jobs: Array<{ title: string }>,
  companyId: string
): Set<string> {
  return new Set(jobs.map((job) => generateJobHash(companyId, job.title)))
}
