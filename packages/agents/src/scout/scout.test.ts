import { describe, it, expect } from 'vitest'
import { detectCareerPage, CAREER_PAGE_PATTERNS, ATS_PATTERNS } from './career-detector'
import { parseJobListings, normalizeTitle } from './job-parser'
import { deduplicateJobs, generateJobHash } from './deduplication'
import type { ParsedJob } from './types'

describe('Career Page Detection', () => {
  describe('detectCareerPage', () => {
    it('should detect Greenhouse career pages', () => {
      const result = detectCareerPage('stripe.com')
      // Greenhouse boards are at boards.greenhouse.io/{company}
      expect(result).toBeDefined()
    })

    it('should detect Lever career pages', () => {
      const result = detectCareerPage('example.com', 'jobs.lever.co/example')
      expect(result.atsType).toBe('lever')
      expect(result.confidence).toBeGreaterThanOrEqual(0.9)
    })

    it('should detect Workday career pages', () => {
      const result = detectCareerPage('example.com', 'example.wd5.myworkdayjobs.com/careers')
      expect(result.atsType).toBe('workday')
      expect(result.confidence).toBeGreaterThanOrEqual(0.9)
    })

    it('should detect Ashby career pages', () => {
      const result = detectCareerPage('example.com', 'jobs.ashbyhq.com/example')
      expect(result.atsType).toBe('ashby')
      expect(result.confidence).toBeGreaterThanOrEqual(0.9)
    })

    it('should detect custom career pages by common paths', () => {
      const result = detectCareerPage('example.com', 'https://example.com/careers')
      expect(result.atsType).toBe('custom')
      expect(result.url).toContain('/careers')
    })

    it('should return unknown for unrecognized patterns', () => {
      const result = detectCareerPage('random-domain.xyz')
      expect(result.atsType).toBe('unknown')
      expect(result.confidence).toBeLessThan(0.5)
    })
  })

  describe('CAREER_PAGE_PATTERNS', () => {
    it('should contain common career page path patterns', () => {
      expect(CAREER_PAGE_PATTERNS).toContain('/careers')
      expect(CAREER_PAGE_PATTERNS).toContain('/jobs')
      expect(CAREER_PAGE_PATTERNS).toContain('/job-openings')
      expect(CAREER_PAGE_PATTERNS).toContain('/work-with-us')
    })
  })

  describe('ATS_PATTERNS', () => {
    it('should have patterns for known ATS platforms', () => {
      expect(ATS_PATTERNS.greenhouse).toBeDefined()
      expect(ATS_PATTERNS.lever).toBeDefined()
      expect(ATS_PATTERNS.workday).toBeDefined()
      expect(ATS_PATTERNS.ashby).toBeDefined()
    })

    it('should match greenhouse URLs correctly', () => {
      expect(ATS_PATTERNS.greenhouse.test('boards.greenhouse.io/stripe')).toBe(true)
      expect(ATS_PATTERNS.greenhouse.test('stripe.greenhouse.io/jobs')).toBe(true)
    })

    it('should match lever URLs correctly', () => {
      expect(ATS_PATTERNS.lever.test('jobs.lever.co/company')).toBe(true)
    })

    it('should match workday URLs correctly', () => {
      expect(ATS_PATTERNS.workday.test('company.wd5.myworkdayjobs.com/en-US/Careers')).toBe(true)
      expect(ATS_PATTERNS.workday.test('company.wd1.myworkdayjobs.com/careers')).toBe(true)
    })

    it('should match ashby URLs correctly', () => {
      expect(ATS_PATTERNS.ashby.test('jobs.ashbyhq.com/company')).toBe(true)
    })
  })
})

describe('Job Parser', () => {
  describe('parseJobListings', () => {
    it('should parse Greenhouse job listings HTML', () => {
      const html = `
        <div class="opening">
          <a data-mapped="true" href="https://boards.greenhouse.io/company/jobs/123">
            <span class="job-title">Software Engineer</span>
          </a>
          <span class="location">San Francisco, CA</span>
        </div>
        <div class="opening">
          <a data-mapped="true" href="https://boards.greenhouse.io/company/jobs/456">
            <span class="job-title">Product Manager</span>
          </a>
          <span class="location">Remote</span>
        </div>
      `
      const jobs = parseJobListings(html, 'greenhouse', 'https://boards.greenhouse.io/company')
      expect(jobs).toHaveLength(2)
      expect(jobs[0].title).toBe('Software Engineer')
      expect(jobs[0].location).toBe('San Francisco, CA')
      expect(jobs[1].title).toBe('Product Manager')
    })

    it('should parse Lever job listings HTML', () => {
      const html = `
        <div class="posting">
          <a class="posting-title" href="https://jobs.lever.co/company/123">
            <h5>Backend Developer</h5>
            <span class="sort-by-location posting-category small-category-label">New York</span>
          </a>
          <span class="posting-categories">
            <span class="sort-by-team posting-category small-category-label">Engineering</span>
          </span>
        </div>
      `
      const jobs = parseJobListings(html, 'lever', 'https://jobs.lever.co/company')
      expect(jobs).toHaveLength(1)
      expect(jobs[0].title).toBe('Backend Developer')
      expect(jobs[0].location).toBe('New York')
      expect(jobs[0].department).toBe('Engineering')
    })

    it('should parse Ashby job listings HTML', () => {
      const html = `
        <div class="ashby-job-posting-brief-list">
          <a href="/company/job/123" class="ashby-job-posting-brief-item">
            <span class="ashby-job-posting-brief-title">Data Scientist</span>
            <span class="ashby-job-posting-brief-location">London, UK</span>
          </a>
        </div>
      `
      const jobs = parseJobListings(html, 'ashby', 'https://jobs.ashbyhq.com/company')
      expect(jobs).toHaveLength(1)
      expect(jobs[0].title).toBe('Data Scientist')
      expect(jobs[0].location).toBe('London, UK')
    })

    it('should parse custom career page with common patterns', () => {
      const html = `
        <div class="job-listing">
          <h3 class="job-title"><a href="/careers/job/789">Frontend Developer</a></h3>
          <span class="location">Austin, TX</span>
        </div>
      `
      const jobs = parseJobListings(html, 'custom', 'https://example.com/careers')
      expect(jobs).toHaveLength(1)
      expect(jobs[0].title).toBe('Frontend Developer')
    })

    it('should return empty array for empty HTML', () => {
      const jobs = parseJobListings('', 'greenhouse', 'https://example.com')
      expect(jobs).toEqual([])
    })

    it('should handle malformed HTML gracefully', () => {
      const html = '<div><span>Not a job listing</span></div>'
      const jobs = parseJobListings(html, 'greenhouse', 'https://example.com')
      expect(jobs).toEqual([])
    })
  })

  describe('normalizeTitle', () => {
    it('should lowercase and trim titles', () => {
      expect(normalizeTitle('  Software Engineer  ')).toBe('software engineer')
    })

    it('should remove extra whitespace', () => {
      expect(normalizeTitle('Senior   Software    Engineer')).toBe('senior software engineer')
    })

    it('should handle special characters', () => {
      expect(normalizeTitle('Sr. Engineer (Remote)')).toBe('sr engineer remote')
    })

    it('should handle empty strings', () => {
      expect(normalizeTitle('')).toBe('')
    })
  })
})

describe('Job Deduplication', () => {
  describe('generateJobHash', () => {
    it('should generate consistent hash for same inputs', () => {
      const hash1 = generateJobHash('company123', 'Software Engineer')
      const hash2 = generateJobHash('company123', 'Software Engineer')
      expect(hash1).toBe(hash2)
    })

    it('should generate different hash for different companies', () => {
      const hash1 = generateJobHash('company123', 'Software Engineer')
      const hash2 = generateJobHash('company456', 'Software Engineer')
      expect(hash1).not.toBe(hash2)
    })

    it('should generate different hash for different titles', () => {
      const hash1 = generateJobHash('company123', 'Software Engineer')
      const hash2 = generateJobHash('company123', 'Product Manager')
      expect(hash1).not.toBe(hash2)
    })

    it('should normalize titles before hashing', () => {
      const hash1 = generateJobHash('company123', 'Software Engineer')
      const hash2 = generateJobHash('company123', '  software   engineer  ')
      expect(hash1).toBe(hash2)
    })
  })

  describe('deduplicateJobs', () => {
    const existingUrls = new Set(['https://example.com/jobs/1', 'https://example.com/jobs/2'])
    const existingHashes = new Set([
      generateJobHash('company123', 'Existing Job'),
    ])

    it('should identify new jobs by URL', () => {
      const jobs: ParsedJob[] = [
        { title: 'New Job', url: 'https://example.com/jobs/3' },
        { title: 'Old Job', url: 'https://example.com/jobs/1' },
      ]
      const result = deduplicateJobs(jobs, 'company123', existingUrls, existingHashes)
      expect(result.newJobs).toHaveLength(1)
      expect(result.newJobs[0].title).toBe('New Job')
      expect(result.existingJobs).toHaveLength(1)
    })

    it('should identify duplicates by title hash', () => {
      const jobs: ParsedJob[] = [
        { title: 'Existing Job', url: 'https://example.com/jobs/new-url' },
        { title: 'Brand New Job', url: 'https://example.com/jobs/fresh' },
      ]
      const result = deduplicateJobs(jobs, 'company123', existingUrls, existingHashes)
      expect(result.newJobs).toHaveLength(1)
      expect(result.newJobs[0].title).toBe('Brand New Job')
      expect(result.existingJobs).toHaveLength(1)
    })

    it('should return all jobs as new when no existing data', () => {
      const jobs: ParsedJob[] = [
        { title: 'Job 1', url: 'https://example.com/jobs/1' },
        { title: 'Job 2', url: 'https://example.com/jobs/2' },
      ]
      const result = deduplicateJobs(jobs, 'company123', new Set(), new Set())
      expect(result.newJobs).toHaveLength(2)
      expect(result.existingJobs).toHaveLength(0)
    })

    it('should handle empty job list', () => {
      const result = deduplicateJobs([], 'company123', existingUrls, existingHashes)
      expect(result.newJobs).toHaveLength(0)
      expect(result.existingJobs).toHaveLength(0)
    })

    it('should use URL as primary deduplication method', () => {
      // Job with same URL but different title should be considered existing
      const jobs: ParsedJob[] = [
        { title: 'Updated Title', url: 'https://example.com/jobs/1' },
      ]
      const result = deduplicateJobs(jobs, 'company123', existingUrls, new Set())
      expect(result.newJobs).toHaveLength(0)
      expect(result.existingJobs).toHaveLength(1)
    })
  })
})
