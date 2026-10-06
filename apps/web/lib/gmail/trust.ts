// How far a piece of mail may be believed, decided by code from the sender and the DKIM check, never
// by a model. A display name proves nothing: "Acme Careers" can be written by anyone. Mail is
// `proven` only when its sender domain is the verified employer's own (or the applicant system the
// employer uses) and the mail carries a passing DKIM result for that same domain. Everything else is
// `unconfirmed`: it may be shown, and it moves no stage and counts for nothing in the strategy.
// A relay (an applicant system, a job board) is never the employer.

import type { Trust } from '@/lib/pipeline/types'
import { isAtsOrJobBoardDomain, isPersonalEmailDomain } from './skip-lists'

export interface HeaderVerdict {
  domain: string | null
  dkim: 'pass' | 'fail' | 'none' | string
}

// Applicant-system sending domains that are not in skip-lists (their own mail relays).
const EXTRA_RELAYS = ['greenhouse-mail.io', 'hire.lever.co', 'us.greenhouse-mail.io', 'eu.greenhouse-mail.io']

export function isRelay(domain: string | null): boolean {
  if (!domain) return false
  const d = domain.toLowerCase()
  return isAtsOrJobBoardDomain(d) || EXTRA_RELAYS.some((r) => d === r || d.endsWith(`.${r}`))
}

// `parent` is the domain itself or a registrable parent of `domain`: DKIM's relaxed alignment, one way only.
const sameOrg = (parent: string, domain: string) => parent === domain || domain.endsWith(`.${parent}`)

// Gmail's own authserv-id. The sender can write any Authentication-Results header; only the one Gmail
// added, on top of the others, says what Gmail checked.
const GMAIL_AUTHSERV = 'mx.google.com'

/**
 * The DKIM verdict from the topmost Authentication-Results header that Gmail itself added (its
 * authserv-id is mx.google.com; every other one is the sender's writing and is ignored): a passing
 * signature whose domain lines up with the From domain wins; otherwise the first result, otherwise
 * "none". A mail that carries no Gmail header is "none".
 */
export function headerVerdict(headers: Array<{ name: string; value: string }>, fromDomain: string | null): HeaderVerdict {
  const gmail = headers.find((h) => h.name.toLowerCase() === 'authentication-results' && h.value.split(';')[0].trim().split(/\s+/)[0].toLowerCase() === GMAIL_AUTHSERV)
  const results = gmail ? [gmail.value] : []
  let first: HeaderVerdict | null = null
  for (const value of results) {
    for (const m of value.matchAll(/dkim=(\w+)([^;]*)/gi)) {
      const result = m[1].toLowerCase()
      const d = /header\.(?:d|i)=@?([a-z0-9.-]+)/i.exec(m[2])?.[1]?.toLowerCase() ?? null
      const v: HeaderVerdict = { domain: d, dkim: result }
      if (result === 'pass' && d && fromDomain && sameOrg(d, fromDomain.toLowerCase())) return v
      first ??= v
    }
  }
  return first ?? { domain: null, dkim: 'none' }
}

/** The employer a sender stands for: its own domain, never a relay or a free-mail host. */
export function senderEmployerDomain(fromDomain: string | null): string | null {
  if (!fromDomain || isRelay(fromDomain) || isPersonalEmailDomain(fromDomain)) return null
  return fromDomain.toLowerCase()
}

/**
 * proven: the sender is the verified employer (or its applicant system) and DKIM passed for that
 * domain. employerDomain is the verified employer's domain, from a company the person follows or a
 * directory employer that passed the verifier.
 */
export function trustOf(args: { fromDomain: string | null; employerDomain: string | null; verdict: HeaderVerdict }): Trust {
  const { fromDomain, employerDomain, verdict } = args
  if (!fromDomain || verdict.dkim !== 'pass' || !verdict.domain) return 'unconfirmed'
  // the signature must be for the domain the mail says it is from
  if (!sameOrg(verdict.domain.toLowerCase(), fromDomain.toLowerCase())) return 'unconfirmed'
  if (isRelay(fromDomain)) return 'proven'
  return employerDomain && sameOrg(employerDomain.toLowerCase(), fromDomain.toLowerCase()) ? 'proven' : 'unconfirmed'
}
