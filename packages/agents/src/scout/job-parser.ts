import type { ATSType, ParsedJob } from './types'

/**
 * Normalizes a job title for comparison/hashing
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .trim()
    // Remove special characters except spaces
    .replace(/[^\w\s]/g, '')
    // Collapse multiple spaces
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Resolves a relative URL to an absolute URL
 */
function resolveUrl(href: string, baseUrl: string): string {
  if (href.startsWith('http://') || href.startsWith('https://')) {
    return href
  }

  try {
    const base = new URL(baseUrl)
    if (href.startsWith('/')) {
      return `${base.origin}${href}`
    }
    return new URL(href, baseUrl).toString()
  } catch {
    // If URL parsing fails, return as-is
    return href
  }
}

/**
 * Simple HTML element extraction using regex
 * Note: This is a basic implementation. In production, you'd use a proper HTML parser.
 */
function extractElements(
  html: string,
  tagPattern: RegExp
): Array<{ content: string; attributes: Record<string, string> }> {
  const results: Array<{ content: string; attributes: Record<string, string> }> = []
  let match

  while ((match = tagPattern.exec(html)) !== null) {
    const fullMatch = match[0]
    const content = match[1] || ''

    // Extract attributes
    const attributes: Record<string, string> = {}
    const attrPattern = /(\w+)=["']([^"']*)["']/g
    let attrMatch
    while ((attrMatch = attrPattern.exec(fullMatch)) !== null) {
      attributes[attrMatch[1]] = attrMatch[2]
    }

    results.push({ content, attributes })
  }

  return results
}

/**
 * Strips HTML tags from a string
 */
function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim()
}

/**
 * Parses Greenhouse job listings
 */
function parseGreenhouseJobs(html: string, baseUrl: string): ParsedJob[] {
  const jobs: ParsedJob[] = []

  // Greenhouse pattern: <div class="opening"> with nested <a> and <span class="job-title">
  const openingPattern = /<div[^>]*class="[^"]*opening[^"]*"[^>]*>([\s\S]*?)<\/div>/gi
  const openings = extractElements(html, openingPattern)

  for (const opening of openings) {
    // Extract link
    const linkMatch = opening.content.match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!linkMatch) continue

    const href = linkMatch[1]
    const linkContent = linkMatch[2]

    // Extract title
    const titleMatch = linkContent.match(/<span[^>]*class="[^"]*job-title[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
    const title = titleMatch ? stripHtmlTags(titleMatch[1]) : stripHtmlTags(linkContent)

    if (!title) continue

    // Extract location
    const locationMatch = opening.content.match(/<span[^>]*class="[^"]*location[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
    const location = locationMatch ? stripHtmlTags(locationMatch[1]) : undefined

    // Extract department
    const deptMatch = opening.content.match(/<span[^>]*class="[^"]*department[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
    const department = deptMatch ? stripHtmlTags(deptMatch[1]) : undefined

    jobs.push({
      title,
      url: resolveUrl(href, baseUrl),
      location,
      department,
    })
  }

  return jobs
}

/**
 * Parses Lever job listings
 */
function parseLeverJobs(html: string, baseUrl: string): ParsedJob[] {
  const jobs: ParsedJob[] = []

  // Lever pattern: <div class="posting"> with <a class="posting-title">
  const postingPattern = /<div[^>]*class="[^"]*posting[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div|$)/gi
  const postings = extractElements(html, postingPattern)

  for (const posting of postings) {
    // Extract link with posting-title class
    const linkMatch = posting.content.match(/<a[^>]*class="[^"]*posting-title[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!linkMatch) continue

    const href = linkMatch[1]
    const linkContent = linkMatch[2]

    // Extract title from h5 within the link
    const titleMatch = linkContent.match(/<h5[^>]*>([\s\S]*?)<\/h5>/i)
    const title = titleMatch ? stripHtmlTags(titleMatch[1]) : stripHtmlTags(linkContent)

    if (!title) continue

    // Extract location
    const locationMatch = linkContent.match(/<span[^>]*class="[^"]*location[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
    const location = locationMatch ? stripHtmlTags(locationMatch[1]) : undefined

    // Extract department/team
    const teamMatch = posting.content.match(/<span[^>]*class="[^"]*team[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
    const department = teamMatch ? stripHtmlTags(teamMatch[1]) : undefined

    jobs.push({
      title,
      url: resolveUrl(href, baseUrl),
      location,
      department,
    })
  }

  return jobs
}

/**
 * Parses Ashby job listings
 */
function parseAshbyJobs(html: string, baseUrl: string): ParsedJob[] {
  const jobs: ParsedJob[] = []

  // Ashby pattern: <a> with class containing "ashby-job-posting-brief-item"
  // Handle both attribute orders (href before class, or class before href)
  const jobPattern = /<a[^>]*class="[^"]*ashby-job-posting-brief-item[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  let match

  while ((match = jobPattern.exec(html)) !== null) {
    const fullTag = match[0]
    const content = match[1]

    // Extract href from the full tag
    const hrefMatch = fullTag.match(/href="([^"]*)"/i)
    if (!hrefMatch) continue
    const href = hrefMatch[1]

    // Extract title
    const titleMatch = content.match(/<span[^>]*class="[^"]*ashby-job-posting-brief-title[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
    const title = titleMatch ? stripHtmlTags(titleMatch[1]) : ''

    if (!title) continue

    // Extract location
    const locationMatch = content.match(/<span[^>]*class="[^"]*ashby-job-posting-brief-location[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
    const location = locationMatch ? stripHtmlTags(locationMatch[1]) : undefined

    jobs.push({
      title,
      url: resolveUrl(href, baseUrl),
      location,
    })
  }

  return jobs
}

/**
 * Parses Workday job listings
 */
function parseWorkdayJobs(html: string, baseUrl: string): ParsedJob[] {
  const jobs: ParsedJob[] = []

  // Workday uses various patterns - try common ones
  // Pattern 1: data-automation-id="jobTitle"
  const jobTitlePattern = /<a[^>]*data-automation-id="jobTitle"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
  let match

  while ((match = jobTitlePattern.exec(html)) !== null) {
    const href = match[1]
    const title = stripHtmlTags(match[2])

    if (!title) continue

    jobs.push({
      title,
      url: resolveUrl(href, baseUrl),
    })
  }

  return jobs
}

/**
 * Parses custom career page with generic patterns
 */
function parseCustomJobs(html: string, baseUrl: string): ParsedJob[] {
  const jobs: ParsedJob[] = []

  // Try multiple common patterns

  // Pattern 1: <h3 class="job-title"><a href="...">Title</a></h3>
  const pattern1 = /<h[1-6][^>]*class="[^"]*job[-_]?title[^"]*"[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>\s*<\/h[1-6]>/gi
  let match

  while ((match = pattern1.exec(html)) !== null) {
    const href = match[1]
    const title = stripHtmlTags(match[2])

    if (title) {
      jobs.push({
        title,
        url: resolveUrl(href, baseUrl),
      })
    }
  }

  // Pattern 2: <a class="job-title" href="...">Title</a>
  if (jobs.length === 0) {
    const pattern2 = /<a[^>]*class="[^"]*job[-_]?title[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi

    while ((match = pattern2.exec(html)) !== null) {
      const href = match[1]
      const title = stripHtmlTags(match[2])

      if (title) {
        jobs.push({
          title,
          url: resolveUrl(href, baseUrl),
        })
      }
    }
  }

  // Pattern 3: Look for links within job-listing containers
  if (jobs.length === 0) {
    const listingPattern = /<div[^>]*class="[^"]*job[-_]?listing[^"]*"[^>]*>([\s\S]*?)<\/div>/gi
    const listings = extractElements(html, listingPattern)

    for (const listing of listings) {
      const linkMatch = listing.content.match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i)
      if (linkMatch) {
        const href = linkMatch[1]
        const title = stripHtmlTags(linkMatch[2])

        // Look for location in the same container
        const locationMatch = listing.content.match(/<span[^>]*class="[^"]*location[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
        const location = locationMatch ? stripHtmlTags(locationMatch[1]) : undefined

        if (title) {
          jobs.push({
            title,
            url: resolveUrl(href, baseUrl),
            location,
          })
        }
      }
    }
  }

  return jobs
}

/**
 * Parses job listings from HTML based on the ATS type
 */
export function parseJobListings(
  html: string,
  atsType: ATSType,
  baseUrl: string
): ParsedJob[] {
  if (!html || html.trim() === '') {
    return []
  }

  switch (atsType) {
    case 'greenhouse':
      return parseGreenhouseJobs(html, baseUrl)
    case 'lever':
      return parseLeverJobs(html, baseUrl)
    case 'ashby':
      return parseAshbyJobs(html, baseUrl)
    case 'workday':
      return parseWorkdayJobs(html, baseUrl)
    case 'custom':
    case 'unknown':
    default:
      return parseCustomJobs(html, baseUrl)
  }
}
