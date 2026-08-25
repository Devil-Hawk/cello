/**
 * Analysis module for extracting highlights and gaps
 *
 * Compares job requirements against resume to identify:
 * - Highlights: Matching qualifications, skills, experience
 * - Gaps: Missing requirements, skill gaps, experience shortfalls
 */

import type { Job } from '@cello/shared'
import {
  extractSkillsFromText,
  extractExperienceRequirement,
  extractYearsFromResume,
} from './scoring'
import { COMMON_SKILLS, EXPERIENCE_INDICATORS, type ExtractedSkill } from './types'

/**
 * Extract highlights - reasons why the candidate is a good fit
 */
export function extractHighlights(
  jobDescription: string,
  resumeText: string,
  job: Job
): string[] {
  const highlights: string[] = []
  const normalizedResume = resumeText.toLowerCase()
  const normalizedJobDesc = jobDescription.toLowerCase()

  // 1. Matching skills
  const requiredSkills = extractSkillsFromText(jobDescription)
  const matchingSkills = findMatchingSkills(requiredSkills, normalizedResume)

  if (matchingSkills.length > 0) {
    if (matchingSkills.length >= 5) {
      highlights.push(
        `Strong skills match: ${matchingSkills.slice(0, 5).join(', ')}${matchingSkills.length > 5 ? ` and ${matchingSkills.length - 5} more` : ''}`
      )
    } else {
      highlights.push(`Matching skills: ${matchingSkills.join(', ')}`)
    }
  }

  // 2. Experience match
  const expRequirement = extractExperienceRequirement(jobDescription)
  const resumeYears = extractYearsFromResume(resumeText)

  if (resumeYears >= expRequirement.yearsMin) {
    if (resumeYears > expRequirement.yearsMin) {
      highlights.push(
        `Experience exceeds requirement: ${resumeYears} years (${expRequirement.yearsMin}+ required)`
      )
    } else {
      highlights.push(`Experience meets requirement: ${resumeYears} years`)
    }
  }

  // 3. Location match
  if (job.location) {
    const jobLocationLower = job.location.toLowerCase()
    const isRemote = jobLocationLower.includes('remote')
    const isHybrid = jobLocationLower.includes('hybrid')

    if (isRemote && normalizedResume.includes('remote')) {
      highlights.push('Location: Remote work compatible')
    } else if (isHybrid && normalizedResume.includes('hybrid')) {
      highlights.push(`Location: Hybrid in ${job.location.replace(/\(.*\)/, '').trim()}`)
    } else {
      // Check for city match
      const jobCity = extractCity(job.location)
      if (jobCity && normalizedResume.includes(jobCity.toLowerCase())) {
        highlights.push(`Location: Based in ${jobCity}`)
      } else if (normalizedResume.includes('open to') || normalizedResume.includes('willing to relocate')) {
        highlights.push('Location: Open to relocation')
      }
    }
  }

  // 4. Seniority level match
  const levelMatch = findLevelMatch(normalizedJobDesc, normalizedResume)
  if (levelMatch) {
    highlights.push(levelMatch)
  }

  // 5. Education match
  const educationMatch = findEducationMatch(normalizedJobDesc, normalizedResume)
  if (educationMatch) {
    highlights.push(educationMatch)
  }

  // 6. Domain/industry experience
  const domainMatch = findDomainMatch(normalizedJobDesc, normalizedResume)
  if (domainMatch) {
    highlights.push(domainMatch)
  }

  return highlights
}

/**
 * Extract gaps - missing requirements or qualifications
 */
export function extractGaps(
  jobDescription: string,
  resumeText: string,
  job: Job
): string[] {
  const gaps: string[] = []
  const normalizedResume = resumeText.toLowerCase()
  const normalizedJobDesc = jobDescription.toLowerCase()

  // 1. Missing skills
  const requiredSkills = extractSkillsFromText(jobDescription)
  const missingSkills = findMissingSkills(
    requiredSkills.filter((s) => s.required),
    normalizedResume
  )

  if (missingSkills.length > 0) {
    if (missingSkills.length >= 3) {
      gaps.push(
        `Missing required skills: ${missingSkills.slice(0, 3).join(', ')}${missingSkills.length > 3 ? ` and ${missingSkills.length - 3} more` : ''}`
      )
    } else {
      gaps.push(`Missing skills: ${missingSkills.join(', ')}`)
    }
  }

  // 2. Experience gap
  const expRequirement = extractExperienceRequirement(jobDescription)
  const resumeYears = extractYearsFromResume(resumeText)

  if (resumeYears < expRequirement.yearsMin) {
    const shortfall = expRequirement.yearsMin - resumeYears
    gaps.push(
      `Experience shortfall: ${resumeYears} years vs ${expRequirement.yearsMin}+ required (${shortfall} years gap)`
    )
  }

  // 3. Education requirements
  const educationGap = findEducationGap(normalizedJobDesc, normalizedResume)
  if (educationGap) {
    gaps.push(educationGap)
  }

  // 4. Location mismatch
  if (job.location) {
    const locationGap = findLocationGap(job.location, normalizedResume)
    if (locationGap) {
      gaps.push(locationGap)
    }
  }

  // 5. Specific certifications or licenses
  const certGaps = findCertificationGaps(normalizedJobDesc, normalizedResume)
  if (certGaps.length > 0) {
    gaps.push(`Missing certifications: ${certGaps.join(', ')}`)
  }

  // 6. Level mismatch
  const levelGap = findLevelGap(normalizedJobDesc, normalizedResume)
  if (levelGap) {
    gaps.push(levelGap)
  }

  return gaps
}

/**
 * Find matching skills between job requirements and resume
 */
function findMatchingSkills(
  requiredSkills: ExtractedSkill[],
  resumeText: string
): string[] {
  const matching: string[] = []

  for (const skill of requiredSkills) {
    if (skillInText(skill.name, resumeText)) {
      matching.push(skill.name)
    }
  }

  return matching
}

/**
 * Find missing skills
 */
function findMissingSkills(
  requiredSkills: ExtractedSkill[],
  resumeText: string
): string[] {
  const missing: string[] = []

  for (const skill of requiredSkills) {
    if (!skillInText(skill.name, resumeText)) {
      missing.push(skill.name)
    }
  }

  return missing
}

/**
 * Check if a skill is present in text (with variations)
 */
function skillInText(skill: string, text: string): boolean {
  const normalizedSkill = skill.toLowerCase()

  // Direct match
  if (text.includes(normalizedSkill)) {
    return true
  }

  // Common variations
  const variations: Record<string, string[]> = {
    'javascript': ['js', 'ecmascript'],
    'typescript': ['ts'],
    'node.js': ['nodejs', 'node'],
    'react': ['reactjs', 'react.js'],
    'vue': ['vuejs', 'vue.js'],
    'postgresql': ['postgres', 'psql'],
    'kubernetes': ['k8s'],
    'golang': ['go language', 'go programming'],
  }

  if (variations[normalizedSkill]) {
    return variations[normalizedSkill].some((v) => text.includes(v))
  }

  return false
}

/**
 * Extract city from location string
 */
function extractCity(location: string): string | null {
  // Remove parenthetical content
  const cleaned = location.replace(/\(.*\)/, '').trim()

  // Get first part before comma
  const parts = cleaned.split(',')
  return parts[0]?.trim() || null
}

/**
 * Find matching experience level
 */
function findLevelMatch(jobDesc: string, resume: string): string | null {
  const levels = ['senior', 'lead', 'principal', 'staff', 'architect']

  for (const level of levels) {
    if (jobDesc.includes(level) && resume.includes(level)) {
      return `Seniority: ${level.charAt(0).toUpperCase() + level.slice(1)} level experience`
    }
  }

  return null
}

/**
 * Find education match
 */
function findEducationMatch(jobDesc: string, resume: string): string | null {
  const degrees = [
    { pattern: 'phd', label: 'PhD' },
    { pattern: 'ph.d', label: 'PhD' },
    { pattern: "master's", label: "Master's degree" },
    { pattern: 'masters', label: "Master's degree" },
    { pattern: 'ms ', label: "Master's degree" },
    { pattern: 'mba', label: 'MBA' },
    { pattern: "bachelor's", label: "Bachelor's degree" },
    { pattern: 'bachelors', label: "Bachelor's degree" },
    { pattern: 'bs ', label: "Bachelor's degree" },
    { pattern: 'ba ', label: "Bachelor's degree" },
  ]

  for (const { pattern, label } of degrees) {
    if (jobDesc.includes(pattern) && resume.includes(pattern)) {
      return `Education: ${label}`
    }
  }

  // Check for CS/Engineering degree
  const csPatterns = ['computer science', 'software engineering', 'cs degree']
  for (const pattern of csPatterns) {
    if (jobDesc.includes(pattern) && resume.includes(pattern)) {
      return 'Education: Computer Science background'
    }
  }

  return null
}

/**
 * Find domain/industry match
 */
function findDomainMatch(jobDesc: string, resume: string): string | null {
  const domains = [
    { pattern: 'fintech', label: 'Fintech experience' },
    { pattern: 'healthcare', label: 'Healthcare experience' },
    { pattern: 'e-commerce', label: 'E-commerce experience' },
    { pattern: 'saas', label: 'SaaS experience' },
    { pattern: 'startup', label: 'Startup experience' },
    { pattern: 'enterprise', label: 'Enterprise experience' },
    { pattern: 'b2b', label: 'B2B experience' },
    { pattern: 'b2c', label: 'B2C experience' },
    { pattern: 'machine learning', label: 'ML experience' },
    { pattern: 'data science', label: 'Data Science experience' },
  ]

  for (const { pattern, label } of domains) {
    if (jobDesc.includes(pattern) && resume.includes(pattern)) {
      return `Domain: ${label}`
    }
  }

  return null
}

/**
 * Find education gap
 */
function findEducationGap(jobDesc: string, resume: string): string | null {
  const degrees = [
    { pattern: 'phd required', label: 'PhD required' },
    { pattern: 'ph.d required', label: 'PhD required' },
    { pattern: 'phd in', label: 'PhD required' },
    { pattern: "master's required", label: "Master's degree required" },
    { pattern: "master's degree", label: "Master's degree required" },
  ]

  for (const { pattern, label } of degrees) {
    if (jobDesc.includes(pattern)) {
      // Check if resume has this degree
      const degreeType = pattern.split(' ')[0]
      if (!resume.includes(degreeType) && !resume.includes(degreeType.replace('.', ''))) {
        return `Education: ${label}`
      }
    }
  }

  return null
}

/**
 * Find location gap
 */
function findLocationGap(jobLocation: string, resume: string): string | null {
  const normalizedLocation = jobLocation.toLowerCase()

  // Check if onsite only
  if (
    normalizedLocation.includes('on-site') ||
    normalizedLocation.includes('onsite') ||
    (normalizedLocation.includes('only') && !normalizedLocation.includes('remote'))
  ) {
    const city = extractCity(jobLocation)
    if (city && !resume.includes(city.toLowerCase())) {
      // Check if user mentions relocation
      if (!resume.includes('relocat') && !resume.includes('open to')) {
        return `Location: Position requires ${city} (on-site)`
      }
    }
  }

  return null
}

/**
 * Find missing certifications
 */
function findCertificationGaps(jobDesc: string, resume: string): string[] {
  const gaps: string[] = []

  const certifications = [
    { pattern: 'aws certified', label: 'AWS Certification' },
    { pattern: 'aws certification', label: 'AWS Certification' },
    { pattern: 'gcp certified', label: 'GCP Certification' },
    { pattern: 'azure certified', label: 'Azure Certification' },
    { pattern: 'pmp', label: 'PMP Certification' },
    { pattern: 'cissp', label: 'CISSP Certification' },
    { pattern: 'cka', label: 'Kubernetes CKA' },
    { pattern: 'ckad', label: 'Kubernetes CKAD' },
    { pattern: 'scrum master', label: 'Scrum Master Certification' },
  ]

  for (const { pattern, label } of certifications) {
    if (
      (jobDesc.includes(pattern) || jobDesc.includes(pattern + ' required')) &&
      !resume.includes(pattern)
    ) {
      gaps.push(label)
    }
  }

  return gaps
}

/**
 * Find level/seniority gap
 */
function findLevelGap(jobDesc: string, resume: string): string | null {
  // Check for senior role without senior experience
  if (
    (jobDesc.includes('senior') || jobDesc.includes('lead')) &&
    !resume.includes('senior') &&
    !resume.includes('lead')
  ) {
    return 'Experience: Role requires senior-level experience'
  }

  // Check for principal/staff level
  if (
    (jobDesc.includes('principal') || jobDesc.includes('staff')) &&
    !resume.includes('principal') &&
    !resume.includes('staff') &&
    !resume.includes('architect')
  ) {
    return 'Experience: Role requires principal/staff-level experience'
  }

  return null
}
