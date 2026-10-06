import { describe, expect, it } from 'vitest'
import { extractInterviewDateTime } from './datetime'

// Tuesday 6 October 2026, noon local. Every expectation is built in local time too, so the file passes in any zone.
const REF = new Date(2026, 9, 6, 12, 0)

const ics = (dtstart: string) => ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', dtstart, 'SUMMARY:Interview', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')

describe('extractInterviewDateTime', () => {
  it('reads an invite start with its own zone, and the invite wins over the prose', () => {
    const out = extractInterviewDateTime('How about October 27 at 9am?', REF, ics('DTSTART;TZID=America/New_York:20261020T140000'))
    expect(out.iso).toBe('2026-10-20T18:00:00.000Z') // 14:00 in New York is EDT, UTC-4
  })

  it('reads a UTC invite start', () => {
    expect(extractInterviewDateTime('', REF, ics('DTSTART:20261020T180000Z')).iso).toBe('2026-10-20T18:00:00.000Z')
  })

  it('falls back to the prose when the invite names a zone Intl does not know', () => {
    const out = extractInterviewDateTime('Friday October 16 at 3pm', REF, ics('DTSTART;TZID=Eastern Standard Time:20261020T140000'))
    expect(out.iso).toBe(new Date(2026, 9, 16, 15, 0).toISOString())
  })

  it('reads a weekday phrase forward from the reference date', () => {
    expect(extractInterviewDateTime('Can we talk next Tuesday at 2pm?', REF).iso).toBe(new Date(2026, 9, 13, 14, 0).toISOString())
  })

  it('reads a month name with a time, and puts a date with no time at 9:00', () => {
    expect(extractInterviewDateTime('Your interview is on October 20 at 2:30 PM', REF).iso).toBe(new Date(2026, 9, 20, 14, 30).toISOString())
    expect(extractInterviewDateTime('Your interview is on October 20.', REF).iso).toBe(new Date(2026, 9, 20, 9, 0).toISOString())
  })

  it('reads a US numeric date', () => {
    expect(extractInterviewDateTime('Call on 10/20/2026 at 10:00 am', REF).iso).toBe(new Date(2026, 9, 20, 10, 0).toISOString())
  })

  it('does not take a fraction for a date, or a date years away', () => {
    expect(extractInterviewDateTime('You are 3/4 of the way there.', REF)).toEqual({ iso: null, rawText: null })
    expect(extractInterviewDateTime('See you on October 20, 2031.', REF).iso).toBeNull()
  })
})
