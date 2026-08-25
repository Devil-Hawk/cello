// Daily-digest domain types (framework-free — safe in request + cron contexts).
//
// The digest is an OPT-IN daily email composed entirely from data Cello already
// stores (no external fetch, no LLM). Preferences live under the `.digest`
// subkey of profiles.preferences (namespaced away from `.api_keys`/`.outreach`).

/** User-configurable digest policy (profiles.preferences.digest). */
export interface DigestPreferences {
  /** Opt-in flag. Default: false (feature is OFF unless the user enables it). */
  enabled: boolean
  /** Preferred send hour (0-23, UTC). Advisory only; default 13 (~9am ET). */
  sendHour?: number
  /** YYYY-MM-DD (UTC) of the last composed/sent digest — enforces once-per-day. */
  lastSentDate?: string
}

export const DEFAULT_DIGEST_PREFS: DigestPreferences = {
  enabled: false,
  sendHour: 13,
}

/** Normalize a raw jsonb value into a safe DigestPreferences. */
export function resolveDigestPreferences(raw: unknown): DigestPreferences {
  const p = (raw ?? {}) as Partial<DigestPreferences>
  const sendHour =
    typeof p.sendHour === 'number' && Number.isFinite(p.sendHour)
      ? Math.min(23, Math.max(0, Math.floor(p.sendHour)))
      : DEFAULT_DIGEST_PREFS.sendHour
  const lastSentDate =
    typeof p.lastSentDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.lastSentDate)
      ? p.lastSentDate
      : undefined
  return {
    enabled: p.enabled === true,
    sendHour,
    lastSentDate,
  }
}

/** UTC calendar day as YYYY-MM-DD — the once-per-day key. */
export function utcDateKey(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

// --- Composed digest payload (stored at preferences.digest.latest) -----------

export interface DigestTopJob {
  jobId: string
  title: string
  companyName: string | null
  matchScore: number | null
  url: string | null
}

export interface DigestStaleApp {
  applicationId: string
  jobTitle: string
  companyName: string | null
  stage: string
  daysStale: number
}

export interface DigestPrepReady {
  jobId: string
  jobTitle: string
  companyName: string | null
  stage: string
}

export interface DigestFollowUpDue {
  id: string
  note: string
  dueDate: string
  overdue: boolean
}

/** The fully composed digest — safe to store as JSON and render in-app. */
export interface ComposedDigest {
  /** YYYY-MM-DD (UTC) this digest was composed for. */
  date: string
  subject: string
  text: string
  html: string
  topJobs: DigestTopJob[]
  prepReady: DigestPrepReady[]
  staleApps: DigestStaleApp[]
  followUpsDue: DigestFollowUpDue[]
  /** True when there is nothing actionable to report. */
  empty: boolean
}
