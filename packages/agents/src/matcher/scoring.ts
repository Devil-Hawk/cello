/**
 * Scoring module for job-resume matching
 *
 * Calculates sub-scores for skills, experience, and location,
 * then combines them into an overall match score.
 */

import type { UserPreferences } from '@cello/shared'
import {
  COMMON_SKILLS,
  EXPERIENCE_INDICATORS,
  DEFAULT_SCORING_WEIGHTS,
  type ScoringWeights,
  type ExperienceLevel,
  type SkillCategory,
  type ExtractedSkill,
  type ExperienceRequirement,
} from './types'

/**
 * Calculate skills match score (0-100)
 *
 * Compares required skills from job description against resume text.
 * Uses keyword matching with fuzzy matching for common variations.
 */
export function calculateSkillsMatch(
  requiredSkills: string[],
  resumeText: string
): number {
  if (requiredSkills.length === 0) {
    return 100 // No requirements = perfect match
  }

  if (!resumeText || resumeText.trim().length === 0) {
    return 0
  }

  const normalizedResume = resumeText.toLowerCase()
  let matchedCount = 0

  for (const skill of requiredSkills) {
    const normalizedSkill = skill.toLowerCase().trim()

    // Direct match
    if (normalizedResume.includes(normalizedSkill)) {
      matchedCount++
      continue
    }

    // Check for common variations
    const variations = getSkillVariations(normalizedSkill)
    if (variations.some((v) => normalizedResume.includes(v))) {
      matchedCount++
      continue
    }
  }

  return Math.round((matchedCount / requiredSkills.length) * 100)
}

/**
 * Get common variations of a skill name
 */
function getSkillVariations(skill: string): string[] {
  const variations: string[] = [skill]

  // Common variations
  const variationMap: Record<string, string[]> = {
    'javascript': ['js', 'ecmascript'],
    'typescript': ['ts'],
    'node.js': ['nodejs', 'node'],
    'react.js': ['reactjs', 'react'],
    'vue.js': ['vuejs', 'vue'],
    'next.js': ['nextjs', 'next'],
    'c++': ['cpp', 'cplusplus'],
    'c#': ['csharp', 'c sharp'],
    'golang': ['go'],
    'kubernetes': ['k8s'],
    'postgresql': ['postgres', 'psql'],
    'amazon web services': ['aws'],
    'google cloud': ['gcp', 'google cloud platform'],
    'microsoft azure': ['azure'],
    '.net': ['dotnet', 'dot net'],
  }

  // Check if skill has variations
  if (variationMap[skill]) {
    variations.push(...variationMap[skill])
  }

  // Check reverse (if skill is a variation)
  for (const [main, vars] of Object.entries(variationMap)) {
    if (vars.includes(skill)) {
      variations.push(main)
      variations.push(...vars.filter((v) => v !== skill))
    }
  }

  return variations
}

/**
 * Calculate experience match score (0-100)
 *
 * Compares years of experience required against user's experience.
 */
export function calculateExperienceMatch(
  yearsRequired: number,
  yearsInResume: number
): number {
  if (yearsRequired === 0) {
    return 100 // No requirement = perfect match
  }

  if (yearsInResume === 0) {
    return 0
  }

  const ratio = yearsInResume / yearsRequired

  if (ratio >= 1) {
    // Meets or exceeds requirement
    return Math.min(100, 90 + Math.min(10, (ratio - 1) * 10))
  }

  if (ratio >= 0.8) {
    // Close to requirement (80-100% of required)
    return Math.round(70 + (ratio - 0.8) * 100)
  }

  if (ratio >= 0.5) {
    // Moderate shortfall (50-80% of required)
    return Math.round(40 + (ratio - 0.5) * 100)
  }

  // Significant shortfall
  return Math.round(ratio * 80)
}

/**
 * Calculate location match score (0-100)
 *
 * Compares job location against user's preferred locations
 * and remote preference.
 */
export function calculateLocationMatch(
  jobLocation: string | null,
  userPreferredLocations: string[],
  remotePreference: 'remote' | 'hybrid' | 'onsite' | 'any'
): number {
  // Unknown job location - give moderate score
  if (!jobLocation || jobLocation.trim().length === 0) {
    return 60
  }

  const normalizedJobLocation = jobLocation.toLowerCase().trim()
  const isRemote = normalizedJobLocation.includes('remote')
  const isHybrid = normalizedJobLocation.includes('hybrid')

  // Handle remote jobs
  if (isRemote) {
    if (remotePreference === 'remote') {
      return 100
    }
    if (remotePreference === 'any' || remotePreference === 'hybrid') {
      return 90
    }
    // User prefers onsite but job is remote
    return 50
  }

  // Handle hybrid jobs
  if (isHybrid) {
    // Extract the city from hybrid location
    const cityMatch = normalizedJobLocation.replace(/\(hybrid\)/i, '').trim()

    if (remotePreference === 'hybrid') {
      // Check if city matches preferred locations
      for (const loc of userPreferredLocations) {
        if (locationMatches(cityMatch, loc.toLowerCase())) {
          return 100
        }
      }
      return 80 // Hybrid but different city
    }

    if (remotePreference === 'any') {
      for (const loc of userPreferredLocations) {
        if (locationMatches(cityMatch, loc.toLowerCase())) {
          return 95
        }
      }
      return 75
    }

    if (remotePreference === 'remote') {
      return 70 // User prefers remote, job is hybrid
    }

    // User prefers onsite
    for (const loc of userPreferredLocations) {
      if (locationMatches(cityMatch, loc.toLowerCase())) {
        return 90
      }
    }
    return 60
  }

  // Onsite job - check location match
  for (const loc of userPreferredLocations) {
    if (locationMatches(normalizedJobLocation, loc.toLowerCase())) {
      return 100
    }
  }

  // Check for same state/region
  for (const loc of userPreferredLocations) {
    if (sameRegion(normalizedJobLocation, loc.toLowerCase())) {
      return 60
    }
  }

  // No location match
  if (remotePreference === 'any') {
    return 40
  }

  return 20
}

/**
 * Check if two locations match (fuzzy matching)
 */
function locationMatches(location1: string, location2: string): boolean {
  // Exact match
  if (location1 === location2) {
    return true
  }

  // Extract city and state
  const parts1 = location1.split(',').map((p) => p.trim())
  const parts2 = location2.split(',').map((p) => p.trim())

  // Check if cities match
  if (parts1[0] && parts2[0] && parts1[0] === parts2[0]) {
    return true
  }

  // Check for common city name variations
  const cityAliases: Record<string, string[]> = {
    'san francisco': ['sf', 'bay area'],
    'new york': ['nyc', 'ny', 'manhattan'],
    'los angeles': ['la'],
    'washington dc': ['dc', 'washington'],
  }

  for (const [city, aliases] of Object.entries(cityAliases)) {
    if (
      (location1.includes(city) || aliases.some((a) => location1.includes(a))) &&
      (location2.includes(city) || aliases.some((a) => location2.includes(a)))
    ) {
      return true
    }
  }

  return false
}

/**
 * Check if locations are in the same state/region
 */
function sameRegion(location1: string, location2: string): boolean {
  // Extract state abbreviations
  const statePattern = /\b([a-z]{2})\b/gi
  const states1 = location1.match(statePattern) || []
  const states2 = location2.match(statePattern) || []

  return states1.some((s1) =>
    states2.some((s2) => s1.toLowerCase() === s2.toLowerCase())
  )
}

/**
 * Calculate overall match score from sub-scores
 *
 * Default weights: 50% skills, 30% experience, 20% location
 */
export function calculateOverallScore(
  skillsScore: number,
  experienceScore: number,
  locationScore: number,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS
): number {
  // Clamp inputs to 0-100
  const clamp = (val: number) => Math.max(0, Math.min(100, val))

  const clampedSkills = clamp(skillsScore)
  const clampedExperience = clamp(experienceScore)
  const clampedLocation = clamp(locationScore)

  const score =
    clampedSkills * weights.skills +
    clampedExperience * weights.experience +
    clampedLocation * weights.location

  return Math.round(clamp(score))
}

/**
 * Extract skills from job description
 */
export function extractSkillsFromText(text: string): ExtractedSkill[] {
  const skills: ExtractedSkill[] = []
  const normalizedText = text.toLowerCase()
  const seenSkills = new Set<string>()

  // Check for required section
  const requiredSection = normalizedText.match(
    /requirements?:?([\s\S]*?)(?:nice to have|preferred|bonus|about|we offer|benefits|$)/i
  )
  const niceToHaveSection = normalizedText.match(
    /(?:nice to have|preferred|bonus):?([\s\S]*?)(?:about|we offer|benefits|$)/i
  )

  const requiredText = requiredSection?.[1] || normalizedText
  const niceToHaveText = niceToHaveSection?.[1] || ''

  // Extract skills from each category
  for (const [category, skillList] of Object.entries(COMMON_SKILLS)) {
    for (const skill of skillList) {
      if (seenSkills.has(skill)) continue

      const isInRequired = requiredText.includes(skill)
      const isInNiceToHave = niceToHaveText.includes(skill)

      if (isInRequired || isInNiceToHave) {
        skills.push({
          name: skill,
          required: isInRequired && !isInNiceToHave,
          category: category as SkillCategory,
        })
        seenSkills.add(skill)
      }
    }
  }

  return skills
}

/**
 * Extract experience requirement from job description
 */
export function extractExperienceRequirement(text: string): ExperienceRequirement {
  const normalizedText = text.toLowerCase()

  // Try to find explicit years pattern
  const yearsPattern = /(\d+)\+?\s*(?:-\s*(\d+))?\s*years?/g
  const matches = [...normalizedText.matchAll(yearsPattern)]

  let yearsMin = 0
  let yearsMax: number | null = null

  if (matches.length > 0) {
    // Find the most likely experience requirement
    for (const match of matches) {
      const min = parseInt(match[1], 10)
      const max = match[2] ? parseInt(match[2], 10) : null

      // Take the first reasonable range
      if (min >= 0 && min <= 20) {
        yearsMin = min
        yearsMax = max
        break
      }
    }
  }

  // Determine level from indicators
  let level: ExperienceLevel = 'mid' // default

  for (const [lvl, indicators] of Object.entries(EXPERIENCE_INDICATORS)) {
    if (indicators.some((ind) => normalizedText.includes(ind))) {
      level = lvl as ExperienceLevel
      break
    }
  }

  // Adjust years if not found but level is known
  if (yearsMin === 0) {
    switch (level) {
      case 'entry':
        yearsMin = 0
        break
      case 'junior':
        yearsMin = 1
        break
      case 'mid':
        yearsMin = 3
        break
      case 'senior':
        yearsMin = 5
        break
      case 'lead':
        yearsMin = 7
        break
      case 'principal':
        yearsMin = 10
        break
      case 'executive':
        yearsMin = 12
        break
    }
  }

  return {
    yearsMin,
    yearsMax,
    level,
  }
}

/**
 * Extract years of experience from resume text
 */
export function extractYearsFromResume(resumeText: string): number {
  const normalizedText = resumeText.toLowerCase()

  // Look for explicit experience statements
  const expPattern = /(\d+)\+?\s*years?\s*(?:of)?\s*(?:experience|exp\.?)/gi
  const matches = [...normalizedText.matchAll(expPattern)]

  if (matches.length > 0) {
    // Take the largest number found (total experience)
    return Math.max(...matches.map((m) => parseInt(m[1], 10)))
  }

  // Try to calculate from job history
  const dateRanges = extractDateRanges(normalizedText)
  if (dateRanges.length > 0) {
    // Calculate total years from date ranges
    return calculateTotalYears(dateRanges)
  }

  // Look for level indicators
  if (normalizedText.includes('senior') || normalizedText.includes('lead')) {
    return 5
  }
  if (normalizedText.includes('junior') || normalizedText.includes('entry')) {
    return 1
  }

  // Default to mid-level assumption
  return 3
}

/**
 * Extract date ranges from text (e.g., "2019 - 2022")
 */
function extractDateRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  const currentYear = new Date().getFullYear()

  // Pattern for year ranges
  const rangePattern = /(\d{4})\s*[-–to]+\s*(\d{4}|present|current|now)/gi
  const matches = [...text.matchAll(rangePattern)]

  for (const match of matches) {
    const startYear = parseInt(match[1], 10)
    const endYear = match[2].toLowerCase().includes('present') ||
      match[2].toLowerCase().includes('current') ||
      match[2].toLowerCase().includes('now')
      ? currentYear
      : parseInt(match[2], 10)

    if (startYear >= 1990 && startYear <= currentYear && endYear >= startYear) {
      ranges.push({ start: startYear, end: endYear })
    }
  }

  return ranges
}

/**
 * Calculate total years from date ranges (accounting for overlaps)
 */
function calculateTotalYears(ranges: Array<{ start: number; end: number }>): number {
  if (ranges.length === 0) return 0

  // Sort by start year
  const sorted = [...ranges].sort((a, b) => a.start - b.start)

  let totalYears = 0
  let currentEnd = 0

  for (const range of sorted) {
    if (range.start >= currentEnd) {
      // No overlap
      totalYears += range.end - range.start
      currentEnd = range.end
    } else if (range.end > currentEnd) {
      // Partial overlap
      totalYears += range.end - currentEnd
      currentEnd = range.end
    }
    // Full overlap - don't add anything
  }

  return totalYears
}
