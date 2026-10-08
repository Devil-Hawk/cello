// The sentences Network shows about a person, built from counts and dates, never from a model.

const DAY = 86_400_000

/** "today", "yesterday", "6 days ago", "3 weeks ago", "5 months ago". */
export function ago(iso: string | null, now = new Date()): string {
  if (!iso) return 'never'
  const days = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / DAY))
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} days ago`
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`
  return `${Math.floor(days / 30)} months ago`
}

const times = (n: number) => (n === 1 ? 'once' : `${n} times`)

/** "6 days ago, you wrote last" */
export function lastInTouch(iso: string | null, from: 'you' | 'them' | null, now = new Date()): string {
  if (!iso) return 'No mail yet'
  return `${ago(iso, now)}, ${from === 'them' ? 'they wrote last' : 'you wrote last'}`
}

/** "You wrote 4 times, they replied 3", or null when nothing was exchanged. */
export function replyEvidence(sent: number, received: number): string | null {
  if (sent === 0 && received === 0) return null
  if (sent === 0) return `They wrote ${times(received)}`
  return `You wrote ${times(sent)}, they replied ${received === 0 ? 'never' : times(received)}`
}

/** The kind of person as a label. */
export const KIND_LABEL: Record<string, string> = {
  recruiter: 'Recruiter',
  agency_recruiter: 'Agency recruiter',
  hiring_manager: 'Hiring manager',
  referrer: 'Referrer',
  other: 'Other',
}
