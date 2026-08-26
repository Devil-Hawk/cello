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
  /**
   * The Google OAuth refresh token for this account's "monitor mailbox"
   * grant, encrypted with the same helper api_keys uses (lib/crypto.ts).
   * Captured once, at the OAuth callback that lands with gmail.readonly
   * newly granted (app/auth/callback/route.ts) — Supabase's own
   * provider_token dies in about an hour and is never persisted, so this is
   * the only thing that makes sync possible outside an active browser
   * session. See lib/gmail/token.ts for how it gets exchanged for an access
   * token, and how an invalid_grant clears it.
   */
  refreshToken?: string
  /** ISO 8601. Set when Google refuses to refresh the token above (the owner revoked access) — see lib/gmail/token.ts. */
  revokedAt?: string | null
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
