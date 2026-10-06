// Today as pure functions: the sentences that come from stored facts. The check
// line reads only what the clock's own record says (lib/clock/status.ts), never a
// schedule; every count is passed in. No model writes any of this.

import type { ChecksStatus } from '@/lib/clock/status'

const MIN = 60_000
const HOUR = 60 * MIN

/** "2 hours ago", "35 minutes ago", "3 days ago". */
export function ago(iso: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(iso))
  if (ms < MIN) return 'just now'
  if (ms < HOUR) {
    const m = Math.floor(ms / MIN)
    return `${m} ${m === 1 ? 'minute' : 'minutes'} ago`
  }
  if (ms < 24 * HOUR) {
    const h = Math.floor(ms / HOUR)
    return `${h} ${h === 1 ? 'hour' : 'hours'} ago`
  }
  const d = Math.floor(ms / (24 * HOUR))
  return `${d} ${d === 1 ? 'day' : 'days'} ago`
}

const hhmm = (iso: string) => new Date(iso).toISOString().slice(11, 16)

/**
 * The check line, from the clock's record and nothing else. A pause or a server
 * with background work off outranks a missed check, which outranks the plain
 * "Checked 2 hours ago. Next check at 18:00 UTC." Null when the clock has said
 * nothing yet (a first visit), and the page then says Cello is reading roles.
 */
export function checkLine(s: Pick<ChecksStatus, 'backgroundText' | 'pausedText' | 'rolesCheck'>, now: number): string | null {
  if (s.pausedText) return s.pausedText
  if (s.backgroundText) return s.backgroundText
  const c = s.rolesCheck
  if (!c) return null
  if (c.missed && c.missedText) return c.missedText
  const checked = c.lastSucceededAt ? `Checked ${ago(c.lastSucceededAt, now)}.` : null
  const next = c.nextDueAt ? `Next check at ${hhmm(c.nextDueAt)} UTC.` : null
  return [checked, next].filter(Boolean).join(' ') || null
}

export interface HeaderFacts {
  /** Roles in today's band, and what kind they are. */
  band: { kind: 'picks' | 'newest'; count: number }
  /** Roles that became visible today, from SQL. */
  newCount: number
}

/** The one sentence at the top. It only counts what is stored; with nothing to count it says so. */
export function headerSentence(f: HeaderFacts): string {
  if (f.band.count > 0 && f.band.kind === 'picks') return `${f.band.count} ${f.band.count === 1 ? 'pick' : 'picks'} from ${f.newCount} new ${f.newCount === 1 ? 'role' : 'roles'}.`
  if (f.newCount > 0) return `${f.newCount} new ${f.newCount === 1 ? 'role' : 'roles'} kept for you today.`
  return 'Nothing new today.'
}

export const FIRST_USE = 'Cello is reading roles for your search. Your first roles arrive in a few minutes.'
export const FAILED = 'Could not load Today.'

export interface SentRow {
  jobId: string
  title: string
  company: string
  companyId: string | null
  domain: string | null
  logoUrl: string | null
  /** When it was sent (ISO). */
  at: string
  /** The posting is closed. */
  closed: boolean
  /** Where the application stands; anything past applied means the employer answered. */
  stage: string
}

/** "Stripe, Senior Data Engineer, sent 9 days ago, still listed". Facts only. */
export function sentLine(r: SentRow, now: number): string {
  return `Sent ${ago(r.at, now)}, ${r.closed ? 'closed' : 'still listed'}`
}

/**
 * "You sent 6 applications in the last 14 days. No replies yet." Replies are named only when they can be read.
 * It does not say "Nothing needs you": that is a claim about Needs you, which Today makes once Needs you is built.
 */
export function quietSentence(sent: number, canReadReplies: boolean, replies: number): string {
  const sentPart = sent === 0 ? null : `You sent ${sent} ${sent === 1 ? 'application' : 'applications'} in the last 14 days.`
  const repliesPart = canReadReplies ? (replies === 0 ? 'No replies yet.' : `${replies} ${replies === 1 ? 'has' : 'have'} moved past applied.`) : 'Cello cannot see replies: Gmail is not connected.'
  return [sentPart, sent > 0 ? repliesPart : null].filter(Boolean).join(' ')
}

export interface SinceChange {
  jobId: string
  title: string
  company: string
  companyId: string | null
  domain: string | null
  logoUrl: string | null
  /** What changed, in words: "Moved to interview." */
  text: string
}

export const STAGE_WORDS: Record<string, string> = {
  applied: 'Marked as applied.',
  screening: 'Moved to screening.',
  interview: 'Moved to interview.',
  offer: 'Offer.',
  rejected: 'Closed.',
  withdrawn: 'Withdrawn.',
}

/** The roles-kept line of "Since you were last here". Null when none, so the group stays hidden. */
export function keptSince(n: number): string | null {
  return n > 0 ? `${n} ${n === 1 ? 'role was' : 'roles were'} kept for you.` : null
}
