// Heuristic extraction of the REAL hiring company from an email's content,
// used (a) as the only source of employer identity when the sender is an
// ATS/job-board domain, and (b) as the fallback classifier when no LLM key
// is configured. Never trust the sending domain in the ATS case.

import { isAtsOrJobBoardDomain, isPersonalEmailDomain } from './skip-lists'

export interface EmployerGuess {
  name: string | null
  domain: string | null
}

// Words that show up in "From" display names that are NOT part of the
// employer's name — strip them so "Acme Corp Talent Team" -> "Acme Corp".
const DISPLAY_NAME_NOISE = new Set([
  'careers', 'career', 'recruiting', 'recruitment', 'talent', 'talentteam',
  'hr', 'hiring', 'jobs', 'notifications', 'noreply', 'no-reply', 'team',
  'people', 'people ops', 'peopleops', 'via', 'greenhouse', 'lever', 'ashby',
  'workday', 'applicanttracking', 'ats',
])

function extractDomain(email: string): string | null {
  const match = email.match(/@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/)
  return match ? match[1].toLowerCase() : null
}

/** Parse `Display Name <addr@domain>` -> { name, address } */
function parseFromHeader(from: string): { displayName: string | null; address: string | null } {
  const match = from.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/)
  if (match) {
    const displayName = match[1].trim().replace(/^"|"$/g, '')
    return { displayName: displayName || null, address: match[2].trim() }
  }
  const bare = from.trim()
  if (bare.includes('@')) return { displayName: null, address: bare }
  return { displayName: bare || null, address: null }
}

function cleanDisplayNameToCompany(displayName: string): string | null {
  // Strip a common "via <ATS>" suffix, e.g. "Acme Corp via Greenhouse".
  const viaStripped = displayName.replace(/\s+via\s+\w+\s*$/i, '').trim()

  const words = viaStripped.split(/\s+/).filter(Boolean)
  if (words.length === 0) return null

  // Drop trailing noise words (Careers, Talent Team, HR, Recruiting, ...).
  while (words.length > 0) {
    const last = words[words.length - 1].toLowerCase().replace(/[^a-z]/g, '')
    if (DISPLAY_NAME_NOISE.has(last)) {
      words.pop()
    } else {
      break
    }
  }
  // Also drop leading noise words like "Notifications" / "No-Reply".
  while (words.length > 0) {
    const first = words[0].toLowerCase().replace(/[^a-z]/g, '')
    if (DISPLAY_NAME_NOISE.has(first)) {
      words.shift()
    } else {
      break
    }
  }

  const cleaned = words.join(' ').trim()
  if (cleaned.length < 2) return null
  // A name that's now just generic noise ("Team", "HR") isn't an employer name.
  if (DISPLAY_NAME_NOISE.has(cleaned.toLowerCase())) return null
  return cleaned
}

const SUBJECT_PHRASE_PATTERNS = [
  /application (?:to|with|at|for)\s+([A-Z][\w&.,'’-]+(?:\s+[A-Z][\w&.,'’-]+){0,3})/,
  /interview(?:ing)?\s+(?:with|at)\s+([A-Z][\w&.,'’-]+(?:\s+[A-Z][\w&.,'’-]+){0,3})/,
  /(?:thank you for applying|thanks for applying)\s+to\s+([A-Z][\w&.,'’-]+(?:\s+[A-Z][\w&.,'’-]+){0,3})/i,
  /your\s+([A-Z][\w&.,'’-]+(?:\s+[A-Z][\w&.,'’-]+){0,3})\s+application/,
  /update from\s+([A-Z][\w&.,'’-]+(?:\s+[A-Z][\w&.,'’-]+){0,3})/i,
  /offer from\s+([A-Z][\w&.,'’-]+(?:\s+[A-Z][\w&.,'’-]+){0,3})/i,
]

function extractCompanyFromText(text: string): string | null {
  for (const pattern of SUBJECT_PHRASE_PATTERNS) {
    const match = text.match(pattern)
    if (match?.[1]) {
      const candidate = match[1].trim().replace(/[.,]+$/, '')
      if (candidate.length >= 2 && candidate.length <= 60) return candidate
    }
  }
  return null
}

/**
 * Best-effort extraction of the real employer's name and domain. Never
 * returns an ATS/job-board or personal-email domain as the employer domain.
 */
export function extractEmployerFromContent(from: string, subject: string, body: string): EmployerGuess {
  const { displayName, address } = parseFromHeader(from)
  const fromDomain = address ? extractDomain(address) : extractDomain(from)
  const senderIsAts = isAtsOrJobBoardDomain(fromDomain)
  const senderIsPersonal = isPersonalEmailDomain(fromDomain)

  // 1. Display name is usually the most reliable signal, even for ATS senders
  //    (Greenhouse/Lever set the friendly "From" name to the employer).
  const fromDisplayCompany = displayName ? cleanDisplayNameToCompany(displayName) : null

  // 2. Subject/body phrase extraction as a secondary signal.
  const fromSubject = extractCompanyFromText(subject)
  const fromBody = !fromDisplayCompany && !fromSubject ? extractCompanyFromText(body.slice(0, 2000)) : null

  const name = fromDisplayCompany || fromSubject || fromBody || null

  // Domain is only trustworthy when the sender itself is the employer.
  const domain = !senderIsAts && !senderIsPersonal ? fromDomain : null

  return { name, domain }
}
