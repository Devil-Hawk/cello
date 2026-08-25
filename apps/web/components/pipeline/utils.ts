/*
 * Shared pipeline types + status logic.
 * The three legacy warning systems (ghost icon, follow-up bubble, coach chip)
 * collapse into ONE alert: amber "Follow up" / red "Ghosted?".
 */

import { GHOST_THRESHOLDS } from '@cello/shared'

export interface ApplicationWithJob {
  id: string
  user_id: string
  job_id: string
  stage: string
  applied_at: string | null
  source: 'gmail_sync' | 'manual' | string | null
  notes: string | null
  created_at: string
  updated_at: string
  jobs: {
    id: string
    title: string
    url: string
    match_score: number | null
    companies: {
      name: string
      domain: string | null
      logo_url: string | null
    }
  }
}

/** Coach follow-up timing thresholds by stage (days since last update). */
export const FOLLOW_UP_TIMING: Record<string, { min: number; max: number }> = {
  applied: { min: 5, max: 7 }, // 5-7 days after applying
  screen: { min: 3, max: 5 }, // 3-5 days after screen
  interview: { min: 1, max: 2 }, // 1-2 days after interview (thank you)
  offer: { min: 2, max: 3 }, // 2-3 days to respond
}

export function getDaysSinceUpdate(updatedAt: string): number {
  const diff = Math.abs(Date.now() - new Date(updatedAt).getTime())
  return Math.floor(diff / (1000 * 60 * 60 * 24))
}

export interface PipelineAlert {
  kind: 'ghosted' | 'follow_up'
  label: string
  /** Tooltip / detail text. */
  title: string
}

/**
 * Single alert per application: red "Ghosted?" past GHOST_THRESHOLDS.GHOSTED,
 * amber "Follow up" when the coach timing or ghost warning thresholds hit.
 */
export function getPipelineAlert(app: ApplicationWithJob): PipelineAlert | null {
  const days = getDaysSinceUpdate(app.updated_at)

  if (['applied', 'screen', 'interview'].includes(app.stage)) {
    if (days >= GHOST_THRESHOLDS.GHOSTED) {
      return { kind: 'ghosted', label: 'Ghosted?', title: `No response in ${days} days` }
    }
    if (days >= GHOST_THRESHOLDS.WARNING) {
      return {
        kind: 'follow_up',
        label: 'Follow up',
        title: `No response in ${days} days — consider following up`,
      }
    }
  }

  const timing = FOLLOW_UP_TIMING[app.stage]
  if (timing && days >= timing.min) {
    return {
      kind: 'follow_up',
      label: 'Follow up',
      title:
        days >= timing.max
          ? `Follow-up overdue (${days} days in stage)`
          : `Consider following up (${days} days in stage)`,
    }
  }

  return null
}

export interface GmailInfo {
  threadUrl: string | null
  subject: string | null
}

/** Parse Gmail thread info stored as JSON in applications.notes (Gmail sync contract). */
export function parseGmailInfo(notes: string | null): GmailInfo {
  if (!notes) return { threadUrl: null, subject: null }
  try {
    const parsed = JSON.parse(notes)
    return {
      threadUrl: parsed.gmail_thread_url || null,
      subject: parsed.detected_from_subject || null,
    }
  } catch {
    return { threadUrl: null, subject: null }
  }
}

/** Gmail link for a card: saved thread URL, else a search URL for gmail-synced apps. */
export function getGmailUrl(app: ApplicationWithJob): string | null {
  const info = parseGmailInfo(app.notes)
  if (info.threadUrl) return info.threadUrl
  const companyName = app.jobs?.companies?.name
  if (app.source === 'gmail_sync' && companyName) {
    const searchQuery = encodeURIComponent(
      `from:${companyName.toLowerCase().replace(/\s+/g, '')} OR subject:${companyName}`
    )
    return `https://mail.google.com/mail/u/0/#search/${searchQuery}`
  }
  return null
}
