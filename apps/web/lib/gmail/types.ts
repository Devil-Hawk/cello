// Shared types for Gmail sync (app/api/gmail/sync/route.ts + lib/gmail/*).

export interface GmailMessage {
  id: string
  threadId: string
  snippet: string
  payload: {
    headers: Array<{ name: string; value: string }>
    body?: { data?: string }
    parts?: Array<{ body?: { data?: string }; mimeType?: string }>
  }
  internalDate: string
}

export interface SyncState {
  lastSyncDate?: string
  scannedEmailIds?: string[]
}

/** Statuses the classifier can detect from an inbound email. */
export type ApplicationStatus =
  | 'applied'
  | 'screen'
  | 'interview'
  | 'offer'
  | 'accepted'
  | 'rejected'
  | 'unknown'

export interface ParsedEmail {
  /** The real hiring company — NEVER the sending ATS/job-board domain. */
  companyName: string | null
  jobTitle: string | null
  status: ApplicationStatus
  /** The employer's own domain. Never an ATS/job-board domain (see skip-lists.ts). */
  companyDomain: string | null
  careerPageUrl: string | null
  confidence: number
  isJobRelated: boolean
  reasoning: string | null
  /** ISO 8601 datetime for an interview/screen if one was mentioned, else null. */
  interviewDateTime: string | null
}

/** activities.type values this route ever writes. */
export type ActivityType =
  | 'email_received'
  | 'interview_scheduled'
  | 'offer_received'
  | 'rejected'
  | 'stage_change'

export interface UnmatchedEmail {
  subject: string
  from: string
  receivedAt: string
  reason: string
}
