// Best-effort extraction of an interview date/time mentioned in an email
// body/subject. Used as a fallback when no LLM key is configured, and to
// validate/repair whatever the LLM classifier returned. An invite (.ics) is read
// with ical.js and wins over the prose, which chrono-node reads.

import ICAL from 'ical.js'
import * as chrono from 'chrono-node'

export interface ExtractedDateTime {
  iso: string | null
  rawText: string | null
}

/** The instant a wall-clock time has in an IANA zone. Throws RangeError for a name Intl does not know. */
function zonedInstant(t: ICAL.Time, timeZone: string): Date {
  const guess = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute)
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
      .formatToParts(new Date(guess))
      .map((p) => [p.type, Number(p.value)])
  )
  // ponytail: one pass, so a time inside a DST gap lands an hour off. Fine for an invite; loop if it ever matters.
  return new Date(guess - (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - guess))
}

/** The start of the first event in an .ics invite, with its own zone, or null when it has none we can place. */
function inviteStart(invite: string): Date | null {
  try {
    const start = ICAL.Component.fromString(invite).getFirstSubcomponent('vevent')?.getFirstProperty('dtstart')
    const t = start?.getFirstValue() as ICAL.Time | undefined
    if (!start || !t || t.isDate) return null
    if (t.zone === ICAL.Timezone.utcTimezone) return t.toJSDate()
    const tzid = start.getParameter('tzid')
    return typeof tzid === 'string' ? zonedInstant(t, tzid) : t.toJSDate()
  } catch {
    // An unreadable invite or a zone name Intl does not know (Outlook's "Eastern Standard Time"): the prose gets its turn.
    return null
  }
}

/**
 * Find the interview date/time. An invite's DTSTART wins; otherwise chrono-node
 * reads the first date in `text` ("October 20 at 2pm", "next Tuesday at 2pm",
 * "3/12/2026 10:00"), forward from `referenceDate`. A date with no time is 9:00.
 * Returns { iso: null, rawText: null } when nothing parses to a sane date.
 */
export function extractInterviewDateTime(text: string, referenceDate: Date, invite?: string): ExtractedDateTime {
  const fromInvite = invite ? inviteStart(invite) : null
  if (fromInvite && isPlausible(fromInvite, referenceDate)) return { iso: fromInvite.toISOString(), rawText: 'calendar invite' }

  // A bare "3/4" is a fraction in a sentence far more often than a date.
  const hit = chrono.parse(text, referenceDate, { forwardDate: true }).find((r) => !/^\d{1,2}\/\d{1,2}$/.test(r.text))
  if (!hit) return { iso: null, rawText: null }
  const date = hit.start.date()
  if (!hit.start.isCertain('hour')) date.setHours(9, 0, 0, 0)
  return isPlausible(date, referenceDate) ? { iso: date.toISOString(), rawText: hit.text } : { iso: null, rawText: null }
}

/** Reject obviously-wrong parses (typo years, stray "3/4" fractions read as dates, etc). */
function isPlausible(date: Date, referenceDate: Date): boolean {
  const twoYearsMs = 2 * 365 * 24 * 60 * 60 * 1000
  return Math.abs(date.getTime() - referenceDate.getTime()) <= twoYearsMs
}

/** Validate/normalize an ISO datetime string the LLM returned; null if unusable. */
export function normalizeIsoDateTime(value: unknown, referenceDate: Date): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const date = new Date(value)
  if (isNaN(date.getTime())) return null
  if (!isPlausible(date, referenceDate)) return null
  return date.toISOString()
}
