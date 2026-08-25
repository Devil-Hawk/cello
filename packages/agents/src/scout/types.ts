// Scout Agent specific types

// ATS (Applicant Tracking System) type
export type ATSType =
  | 'greenhouse'
  | 'lever'
  | 'workday'
  | 'ashby'
  | 'custom'
  | 'unknown'

// Result from career page detection
export interface CareerPageResult {
  url: string
  confidence: number // 0-1 scale
  atsType: ATSType
}

// Parsed job from career page HTML
export interface ParsedJob {
  title: string
  url: string
  location?: string
  department?: string
  postedAt?: Date
}

// Input for scouting a company
export interface ScoutInput {
  companyId: string
  domain: string
  existingCareerUrl?: string
}

// Deduplication result
export interface DeduplicationResult {
  newJobs: ParsedJob[]
  existingJobs: ParsedJob[]
}
