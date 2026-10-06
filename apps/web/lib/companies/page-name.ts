// The employer's name for a careers page a person pasted: from what the employer
// declares (a JobPosting's hiringOrganization, og:site_name) or its domain, and
// never from a page title that is marketing copy ("Find your career").

import { readJobPostings } from '../ingest/jsonld'
import { lookupKnownCompanyByDomain } from './known-companies'

const GENERIC_WORDS = new Set([
  'find', 'your', 'our', 'the', 'a', 'an', 'career', 'careers', 'job', 'jobs', 'join', 'us', 'work', 'with', 'for', 'at', 'in', 'to', 'of',
  'home', 'welcome', 'search', 'open', 'openings', 'positions', 'position', 'roles', 'role', 'opportunities', 'opportunity', 'hiring', 'apply',
  'vacancies', 'employment', 'team', 'teams', 'life', 'future', 'dream', 'next', 'step', 'page', 'official', 'site', 'website', 'all', 'new',
  'explore', 'discover', 'build', 'grow', 'start', 'here', 'and', 'we', 'are', 'is', 'now', 'today', 'talent', 'recruiting', 'recruitment', 'students', 'graduates',
])

/** True for text that is a slogan or a page label, not a company's name: every word is a careers-page word. */
export function isGenericName(name: string | null | undefined): boolean {
  const words = (name ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (words.length === 0) return true
  if (words.length > 5) return true
  return words.every((w) => GENERIC_WORDS.has(w))
}

/** "Zalando Jobs" -> "Zalando"; "Careers at Acme" -> "Acme". */
function stripCareersWords(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/^(?:careers?|jobs?)\s+(?:at|@|with)\s+/i, '')
    .replace(/\s*[-|–—:]\s*(?:careers?|jobs?)\b.*$/i, '')
    .replace(/\s+(?:careers?|jobs?)$/i, '')
    .trim()
}

const clean = (raw: string | null | undefined): string | null => {
  const name = stripCareersWords((raw ?? '').trim())
  return name.length >= 2 && name.length < 40 && !isGenericName(name) ? name : null
}

/** "jobs.zalando.com" -> "Zalando"; "careers.walmart.com" -> "Walmart". */
export function nameFromDomain(domain: string): string {
  const base = domain.replace(/^(?:jobs|careers|www)\./, '').split('.')[0]
  return base.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function metaContent(html: string, property: string): string | null {
  const tag = new RegExp(`<meta[^>]+(?:property|name)="${property}"[^>]*>`, 'i').exec(html)?.[0]
  return tag ? (/content="([^"]*)"/i.exec(tag)?.[1] ?? null) : null
}

/** The employer's name for a page, never null: the domain is the last resort. */
export function employerNameFromPage(html: string, pageUrl: string, domain: string): string {
  const known = lookupKnownCompanyByDomain(domain)
  if (known) return known.name
  let declared: string | null = null
  try {
    declared = clean(readJobPostings(html, pageUrl).find((p) => p.employer)?.employer)
  } catch {
    /* no declared posting */
  }
  return declared ?? clean(metaContent(html, 'og:site_name')) ?? nameFromTitle(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]) ?? nameFromDomain(domain)
}

/** Only the two shapes that name the employer: "Careers at Acme" and "Acme Careers" (up to three words). */
function nameFromTitle(title: string | undefined): string | null {
  const t = (title ?? '').replace(/\s+/g, ' ').trim()
  const shaped = /^(?:careers?|jobs?)\s+(?:at|@|with)\s+.+$/i.test(t) || /^.+?\s*(?:[-|\u2013\u2014:]\s*)?(?:careers?|jobs?)$/i.test(t)
  const name = shaped ? clean(t) : null
  return name && name.split(' ').length <= 3 ? name : null
}
