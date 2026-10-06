// The words of the record that code can write from stored facts. No model: every
// line here is a fact about where a posting came from, what it states, or what
// the person's own search says about it.

export const FOLD_LINES = 12

/** A posting longer than the fold gets the fade and "Read the whole posting"; a short one is shown whole. */
export function needsFold(text: string): boolean {
  return text.length > 900 || text.split('\n').length > FOLD_LINES
}

const LEVEL: Record<string, string> = { intern: 'Intern', junior: 'Junior', mid: 'Mid', senior: 'Senior', staff: 'Staff', principal: 'Principal', manager: 'Manager', director: 'Director', exec: 'Executive' }
const FUNCTION: Record<string, string> = { engineering: 'Engineering', data: 'Data', product: 'Product', design: 'Design', sales: 'Sales', marketing: 'Marketing', operations: 'Operations', other: 'Other' }

export interface WhyFacts {
  jobFunction: string | null
  seniority: string | null
  isRemote: boolean | null
  country: string | null
}

export interface WhyTargets {
  functions: string[]
  seniority: string[]
  countries: string[]
  remoteOnly: boolean
}

/**
 * Why the role was kept, from the person's own search and the role's stored
 * facts: "Kept: Engineering is one of your role types, Senior is your level, and
 * remote is how you want to work." Null when the search names nothing this role
 * matches, so the group stays hidden rather than saying something empty.
 */
export function whyKept(job: WhyFacts, t: WhyTargets): string | null {
  const parts: string[] = []
  if (job.jobFunction && t.functions.includes(job.jobFunction)) parts.push(`${FUNCTION[job.jobFunction] ?? job.jobFunction} is one of your role types`)
  if (job.seniority && t.seniority.includes(job.seniority)) parts.push(`${LEVEL[job.seniority] ?? job.seniority} is your level`)
  if (job.country && t.countries.includes(job.country)) parts.push(`${job.country} is where you work`)
  if (job.isRemote && t.remoteOnly) parts.push('remote is how you want to work')
  if (parts.length === 0) return null
  const last = parts.pop()!
  return `Kept: ${parts.length ? `${parts.join(', ')}, and ${last}` : last}.`
}

/**
 * What the posting says about sponsorship, for a person who needs it. Past H-1B
 * filings come from the public list and are only ever a track record; nothing
 * here says an employer does not sponsor.
 */
export function sponsorshipLines(needsSponsorship: boolean, pastH1B: boolean, description: string): string[] {
  if (!needsSponsorship) return []
  const lines = [/sponsor/i.test(description) ? 'The posting mentions sponsorship.' : 'The posting does not mention sponsorship.']
  if (pastH1B) lines.push('Past H-1B filings.')
  return lines
}

export interface ApplicationFacts {
  stage: string
  appliedAt: string | null
}

const month = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

/** "You applied on Sep 12." once applied; nothing for a role that is only saved. */
export function statusSentence(a: ApplicationFacts | null): string | null {
  if (!a || a.stage === 'discovered') return null
  return a.appliedAt ? `You applied on ${month(a.appliedAt)}.` : 'You applied.'
}

/** Where the posting was read, as a fact about the read: "From Stripe's job board. Still listed as of 3 hours ago." */
export function sourceLine(company: string, tier: string | null, closed: boolean, checkedAt: string | null, now = Date.now()): string | null {
  const from = tier === 'board' ? `From ${company}'s job board.` : tier ? `From ${company}'s careers site.` : null
  let listed: string | null = null
  if (closed) listed = 'The posting is closed.'
  else if (checkedAt) {
    const hours = Math.max(0, Math.floor((now - Date.parse(checkedAt)) / 3_600_000))
    listed = `Still listed as of ${hours < 1 ? 'just now' : hours < 24 ? `${hours} ${hours === 1 ? 'hour' : 'hours'} ago` : `${Math.floor(hours / 24)} ${Math.floor(hours / 24) === 1 ? 'day' : 'days'} ago`}.`
  }
  return [from, listed].filter(Boolean).join(' ') || null
}

/** A posting that is only a link or a stub: the page says so and sends the person to the employer. */
export function isPartial(description: string): boolean {
  return description.trim().length < 200
}
