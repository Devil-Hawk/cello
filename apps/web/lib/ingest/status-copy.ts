// The words for the "Find new roles" line, kept apart from the component so
// every state's copy can be tested. Glossary: "Find new roles", "check",
// "checked". Sentence case, no exclamation marks, no em dashes.

import type { FindNewRolesStatus } from './status'

export interface StatusCopy {
  /** First line on a laptop and a phone alike, long form. */
  long: string
  /** First line on a phone, shortened; same as `long` when there is nothing to shorten. */
  short: string
  /** Second line on a phone (the next check); on a laptop it follows the first. */
  next: string | null
  /** The state's visual tone: 'ink' for text, 'danger' for a red dot (failures only). */
  tone: 'ink' | 'danger'
  /** Show the drawing cello scroll instead of a dot. */
  working: boolean
  /** Offer the Details panel. */
  details: boolean
}

/** "2 hours ago", "just now". */
export function timeAgo(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  const days = Math.round(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}

/** "2h ago", for a phone. */
function timeAgoShort(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** 24-hour local time, "18:41". */
export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function found(s: FindNewRolesStatus): string {
  const parts: string[] = []
  if (s.jobsNew > 0) parts.push(`${s.jobsNew} new`)
  if (s.jobsClosed > 0) parts.push(`${s.jobsClosed} closed`)
  return parts.join(', ')
}

export function statusCopy(s: FindNewRolesStatus, now: Date): StatusCopy {
  const next = `Next around ${clockTime(s.nextCheckAt)}`
  const base = { tone: 'ink' as const, working: false, details: false }

  switch (s.state) {
    case 'never':
      return s.hasCompanies
        ? { ...base, long: `First check around ${clockTime(s.nextCheckAt)}. You can refresh now.`, short: `First check around ${clockTime(s.nextCheckAt)}. You can refresh now.`, next: null }
        : { ...base, long: 'Find new roles checks your companies every 6 hours. Add a company to start.', short: 'Find new roles checks your companies every 6 hours. Add a company to start.', next: null }

    case 'checking': {
      const n = s.companiesTotal > 0 ? plural(s.companiesTotal, 'company', 'companies') : 'your companies'
      const line = `Checking ${n} now`
      return { ...base, working: true, long: line, short: line, next: null }
    }

    case 'done': {
      const when = s.finishedAt ?? s.startedAt ?? now.toISOString()
      const what = found(s)
      const companies = plural(s.companiesChecked, 'company', 'companies')
      return {
        ...base,
        long: what ? `Checked ${companies} ${timeAgo(when, now)}: ${what}` : `Checked ${companies} ${timeAgo(when, now)}. No new roles.`,
        short: what ? `Checked ${timeAgoShort(when, now)}: ${what}` : `Checked ${timeAgoShort(when, now)}. No new roles.`,
        next,
      }
    }

    case 'partial': {
      const when = s.finishedAt ?? s.startedAt ?? now.toISOString()
      const total = s.companiesTotal || s.companiesChecked
      const newPart = s.jobsNew > 0 ? `: ${s.jobsNew} new` : ''
      return {
        ...base,
        details: true,
        long: `Checked ${s.companiesChecked} of ${plural(total, 'company', 'companies')} ${timeAgo(when, now)}${newPart}`,
        short: `Checked ${s.companiesChecked} of ${total} ${timeAgoShort(when, now)}${newPart}`,
        next,
      }
    }

    case 'failed': {
      const line = `The last check did not finish. Cello tries again around ${clockTime(s.nextCheckAt)}.`
      return { ...base, tone: 'danger', long: line, short: line, next: null }
    }
  }
}

export const STATUS_ERROR_COPY = 'Could not load when roles were last checked. Reload the page to try again.'

/** The Details panel: up to 10 companies that were not checked, then "and 4 more". */
export function detailsLines(s: FindNewRolesStatus, total: number | null = null): { items: string[]; more: string | null; footer: string } {
  const shown = s.failed.slice(0, 10)
  const hidden = Math.max(0, (total ?? s.failed.length) - shown.length)
  return {
    items: shown.map((f) => `${f.companyName}: ${f.text}`),
    more: hidden > 0 ? `and ${hidden} more` : null,
    footer: `These are checked again around ${clockTime(s.nextCheckAt)}.`,
  }
}
