import type { ATSType, CareerPageResult } from './types'

// Common career page path patterns
export const CAREER_PAGE_PATTERNS = [
  '/careers',
  '/jobs',
  '/job-openings',
  '/work-with-us',
  '/join-us',
  '/openings',
  '/opportunities',
] as const

// ATS platform URL patterns
export const ATS_PATTERNS: Record<string, RegExp> = {
  greenhouse: /(?:boards\.greenhouse\.io|[\w-]+\.greenhouse\.io)/i,
  lever: /jobs\.lever\.co/i,
  workday: /[\w-]+\.wd\d+\.myworkdayjobs\.com/i,
  ashby: /jobs\.ashbyhq\.com/i,
}

/**
 * Detects the ATS type from a URL
 */
export function detectATSType(url: string): ATSType {
  for (const [atsType, pattern] of Object.entries(ATS_PATTERNS)) {
    if (pattern.test(url)) {
      return atsType as ATSType
    }
  }
  return 'unknown'
}

/**
 * Extracts company identifier from domain
 * e.g., "www.stripe.com" -> "stripe"
 */
export function extractCompanySlug(domain: string): string {
  // Remove protocol if present
  let cleaned = domain.replace(/^https?:\/\//, '')
  // Remove www prefix
  cleaned = cleaned.replace(/^www\./, '')
  // Get the subdomain/domain before the TLD
  const parts = cleaned.split('.')
  if (parts.length >= 2) {
    return parts[0]
  }
  return cleaned
}

/**
 * Generates potential career page URLs for a domain
 */
export function generateCareerUrls(domain: string): string[] {
  const slug = extractCompanySlug(domain)
  const baseUrl = domain.startsWith('http') ? domain : `https://${domain}`
  const cleanBase = baseUrl.replace(/\/$/, '')

  const urls: string[] = []

  // Add known ATS platform URLs
  urls.push(`https://boards.greenhouse.io/${slug}`)
  urls.push(`https://jobs.lever.co/${slug}`)
  urls.push(`https://jobs.ashbyhq.com/${slug}`)
  urls.push(`https://${slug}.wd5.myworkdayjobs.com/careers`)

  // Add common career page paths
  for (const path of CAREER_PAGE_PATTERNS) {
    urls.push(`${cleanBase}${path}`)
  }

  return urls
}

/**
 * Detects career page information from a domain
 * If careerUrl is provided, analyzes it; otherwise, suggests potential URLs
 */
export function detectCareerPage(domain: string, careerUrl?: string): CareerPageResult {
  // If a career URL is provided, analyze it
  if (careerUrl) {
    const atsType = detectATSType(careerUrl)

    // Known ATS platforms have high confidence
    if (atsType !== 'unknown') {
      return {
        url: careerUrl,
        confidence: 0.95,
        atsType,
      }
    }

    // Check if URL contains common career page patterns
    const hasCareerPath = CAREER_PAGE_PATTERNS.some(
      (pattern) => careerUrl.toLowerCase().includes(pattern)
    )

    if (hasCareerPath) {
      return {
        url: careerUrl,
        confidence: 0.8,
        atsType: 'custom',
      }
    }

    // URL provided but doesn't match known patterns
    return {
      url: careerUrl,
      confidence: 0.5,
      atsType: 'custom',
    }
  }

  // No URL provided - suggest the most likely career page URL
  const slug = extractCompanySlug(domain)
  const potentialUrls = generateCareerUrls(domain)

  // Return the first potential URL with low confidence (needs verification)
  return {
    url: potentialUrls[0],
    confidence: 0.3,
    atsType: 'unknown',
  }
}

/**
 * Validates if a URL appears to be a valid career page
 * This is a heuristic check - actual validation requires fetching the page
 */
export function isLikelyCareerPage(url: string): boolean {
  const lowercaseUrl = url.toLowerCase()

  // Check for ATS patterns
  for (const pattern of Object.values(ATS_PATTERNS)) {
    if (pattern.test(lowercaseUrl)) {
      return true
    }
  }

  // Check for common career page paths
  for (const path of CAREER_PAGE_PATTERNS) {
    if (lowercaseUrl.includes(path)) {
      return true
    }
  }

  return false
}
