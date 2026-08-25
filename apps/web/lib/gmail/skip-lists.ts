// Domains that must never be treated as an employer identity.

/** Personal/free email providers — an email FROM these is not from a company. */
export const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'icloud.com',
  'live.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'msn.com',
])

/**
 * ATS / job-board / aggregator senders. An email from one of these domains is
 * ABOUT a company, it is not FROM that company — never use the sending domain
 * as the employer's companyDomain when it matches this list. The real
 * employer must be parsed out of the subject/body/display-name instead.
 */
export const ATS_JOB_BOARD_DOMAINS = new Set([
  'greenhouse.io',
  'lever.co',
  'ashbyhq.com',
  'myworkday.com',
  'workday.com',
  'icims.com',
  'taleo.net',
  'smartrecruiters.com',
  'jobvite.com',
  'linkedin.com',
  'indeed.com',
  'glassdoor.com',
  'ziprecruiter.com',
  'dice.com',
  'wellfound.com',
  'angel.co',
  'hired.com',
  'otta.com',
  'monster.com',
  'seek.com',
  // Common notification subdomains route through these apex domains too;
  // extractDomain() only ever returns the registrable-ish suffix match, so
  // checking against the apex set above is sufficient for e.g.
  // "notifications@mail.greenhouse.io" style senders once normalized.
])

export function isPersonalEmailDomain(domain: string | null): boolean {
  return !!domain && PERSONAL_EMAIL_DOMAINS.has(domain.toLowerCase())
}

export function isAtsOrJobBoardDomain(domain: string | null): boolean {
  if (!domain) return false
  const d = domain.toLowerCase()
  if (ATS_JOB_BOARD_DOMAINS.has(d)) return true
  // Match subdomains too, e.g. "mail.greenhouse.io" or "boards.greenhouse.io".
  for (const ats of ATS_JOB_BOARD_DOMAINS) {
    if (d === ats || d.endsWith(`.${ats}`)) return true
  }
  return false
}
