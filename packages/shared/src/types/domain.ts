import type { PipelineStage } from '../constants'

// User profile for job matching
export interface UserProfile {
  id: string
  email: string
  fullName: string | null
  avatarUrl: string | null
  resumeText: string | null
  resumeEmbedding: number[] | null
  preferences: UserPreferences | null
  createdAt: Date
  updatedAt: Date
}

export interface UserPreferences {
  preferredLocations: string[]
  remotePreference: 'remote' | 'hybrid' | 'onsite' | 'any'
  salaryMin: number | null
  jobTypes: ('full-time' | 'contract' | 'part-time')[]
  notificationSettings: NotificationSettings
}

export interface NotificationSettings {
  pushEnabled: boolean
  emailEnabled: boolean
  matchThreshold: number // Only notify for jobs above this match score
}

// Company tracking
export interface Company {
  id: string
  userId: string
  name: string
  domain: string | null
  logoUrl: string | null
  careerUrl: string
  scrapeFrequency: number // minutes
  lastScrapedAt: Date | null
  isDreamCompany: boolean
  notes: string | null
  createdAt: Date
}

// Job listing
export interface Job {
  id: string
  companyId: string
  title: string
  description: string
  url: string
  location: string | null
  salaryRange: string | null
  jobType: string | null
  postedAt: Date | null
  discoveredAt: Date
  matchScore: number | null
  matchDetails: MatchDetails | null
  isNew: boolean
}

export interface MatchDetails {
  overallScore: number
  skillsMatch: number
  experienceMatch: number
  locationMatch: number
  highlights: string[]
  gaps: string[]
}

// Application tracking
export interface Application {
  id: string
  userId: string
  jobId: string
  stage: PipelineStage
  appliedAt: Date | null
  source: string | null // Where they found/applied (direct, referral, etc)
  notes: string | null
  resumeVersion: string | null
  coverLetter: string | null
  createdAt: Date
  updatedAt: Date
}

// Activity log for applications
export interface Activity {
  id: string
  applicationId: string
  type: ActivityType
  title: string
  description: string | null
  metadata: Record<string, unknown> | null
  occurredAt: Date
  createdAt: Date
}

export type ActivityType =
  | 'email_received'
  | 'email_sent'
  | 'interview_scheduled'
  | 'status_changed'
  | 'note_added'
  | 'follow_up_due'

// Contact management
export interface Contact {
  id: string
  userId: string
  companyId: string | null
  name: string
  email: string | null
  linkedinUrl: string | null
  title: string | null
  relationship: string | null
  lastContactAt: Date | null
  notes: string | null
  createdAt: Date
}

// Follow-up reminders
export interface FollowUp {
  id: string
  contactId: string | null
  applicationId: string | null
  dueDate: Date
  note: string
  isCompleted: boolean
  completedAt: Date | null
  createdAt: Date
}
