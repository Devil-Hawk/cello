// Best-effort extraction of an interview date/time mentioned in an email
// body/subject. Used as a fallback when no LLM key is configured, and to
// validate/repair whatever the LLM classifier returned.

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
}

function to24Hour(hour: number, meridiem: string | undefined): number {
  if (!meridiem) return hour
  const m = meridiem.toLowerCase().replace(/\./g, '')
  if (m === 'pm' && hour < 12) return hour + 12
  if (m === 'am' && hour === 12) return 0
  return hour
}

const MONTH_NAME_RE =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t)?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?(?:\s*(?:at|@|,)?\s*(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?))?/i

const NUMERIC_DATE_RE =
  /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b(?:\s*(?:at|@)?\s*(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?)?/i

const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/

export interface ExtractedDateTime {
  iso: string | null
  rawText: string | null
}

/**
 * Scan `text` for a date/time mention and return it as an ISO string,
 * anchored to `referenceYear` when the year is omitted. Returns
 * { iso: null, rawText: null } when nothing parses to a sane date.
 */
export function extractInterviewDateTime(text: string, referenceDate: Date): ExtractedDateTime {
  const referenceYear = referenceDate.getFullYear()

  const monthMatch = text.match(MONTH_NAME_RE)
  if (monthMatch) {
    const monthKey = monthMatch[1].toLowerCase().replace(/\.$/, '')
    const month = MONTHS[monthKey]
    const day = parseInt(monthMatch[2], 10)
    const year = monthMatch[3] ? parseInt(monthMatch[3], 10) : referenceYear
    const hasTime = monthMatch[4] !== undefined
    const hour = hasTime ? to24Hour(parseInt(monthMatch[4], 10), monthMatch[6]) : 9
    const minute = hasTime && monthMatch[5] ? parseInt(monthMatch[5], 10) : 0

    if (month !== undefined && day >= 1 && day <= 31) {
      const date = new Date(year, month, day, hour, minute, 0)
      if (!isNaN(date.getTime()) && isPlausible(date, referenceDate)) {
        return { iso: date.toISOString(), rawText: monthMatch[0].trim() }
      }
    }
  }

  const numericMatch = text.match(NUMERIC_DATE_RE)
  if (numericMatch) {
    // Assume US-style MM/DD/YYYY (the codebase targets US job listings).
    const month = parseInt(numericMatch[1], 10) - 1
    const day = parseInt(numericMatch[2], 10)
    let year = parseInt(numericMatch[3], 10)
    if (year < 100) year += 2000
    const hasTime = numericMatch[4] !== undefined
    const hour = hasTime ? to24Hour(parseInt(numericMatch[4], 10), numericMatch[6]) : 9
    const minute = hasTime && numericMatch[5] ? parseInt(numericMatch[5], 10) : 0

    if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
      const date = new Date(year, month, day, hour, minute, 0)
      if (!isNaN(date.getTime()) && isPlausible(date, referenceDate)) {
        return { iso: date.toISOString(), rawText: numericMatch[0].trim() }
      }
    }
  }

  const isoMatch = text.match(ISO_DATE_RE)
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10)
    const month = parseInt(isoMatch[2], 10) - 1
    const day = parseInt(isoMatch[3], 10)
    const hour = isoMatch[4] ? parseInt(isoMatch[4], 10) : 9
    const minute = isoMatch[5] ? parseInt(isoMatch[5], 10) : 0
    const date = new Date(year, month, day, hour, minute, 0)
    if (!isNaN(date.getTime()) && isPlausible(date, referenceDate)) {
      return { iso: date.toISOString(), rawText: isoMatch[0].trim() }
    }
  }

  return { iso: null, rawText: null }
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
