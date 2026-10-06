// Hard constraints: facts the person stated about what they cannot or will not
// do. A role that breaks one is filtered out with the reason in the person's own
// terms. Nothing here scores anything, and nothing here guesses: a constraint
// only applies when both the stated fact and the posting's own words are clear.
// Where the posting is silent (no pay listed, no location given) the role stays.
//
// Stored at profiles.preferences.constraints, next to the older
// profiles.preferences.targeting, which supplies the company exclusions, the
// countries they work in and "remote only". The older minimum-score setting is
// retired with the score it filtered on.

import { classifyJob, parseLocation, type Seniority } from '@/lib/jobs/classify'
import { resolveTargeting } from '@/lib/targeting'
import type { BlockReason, RoleFacts } from './types'

export interface StatedConstraints {
  /** Countries (ISO alpha-2) they cannot work in. */
  blockedCountries: string[]
  /** Countries (ISO alpha-2) they can work in. Empty means no stated limit. */
  onlyCountries: string[]
  /** Cities where they can work on site. Remote roles are not affected. Empty means no stated limit. */
  onsiteCities: string[]
  /** They need an employer to sponsor their right to work. */
  needsSponsorship: boolean
  /** Lowest yearly pay they will consider, in USD. */
  salaryFloorUsd: number | null
  /** Only fully remote roles. */
  remoteOnly: boolean
  /** Companies they ruled out, lowercased. */
  excludedCompanies: string[]
  /** Levels they will not take, from lib/jobs/classify.ts. */
  refusedSeniority: string[]
  /** Words that rule a role out when they appear in its title, lowercased. */
  excludedTitleWords: string[]
}

export const NO_CONSTRAINTS: StatedConstraints = {
  blockedCountries: [],
  onlyCountries: [],
  onsiteCities: [],
  needsSponsorship: false,
  salaryFloorUsd: null,
  remoteOnly: false,
  excludedCompanies: [],
  refusedSeniority: [],
  excludedTitleWords: [],
}

function strings(v: unknown, f: (s: string) => string): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== 'string') continue
    const s = f(x.trim())
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

/** Reads the stated constraints out of a raw profiles.preferences blob. Never throws. */
export function resolveConstraints(preferences: unknown): StatedConstraints {
  const prefs = (preferences && typeof preferences === 'object' ? preferences : {}) as Record<string, unknown>
  const raw = (prefs.constraints && typeof prefs.constraints === 'object' ? prefs.constraints : {}) as Record<string, unknown>
  const t = resolveTargeting(preferences)
  const floor = typeof raw.salaryFloorUsd === 'number' && Number.isFinite(raw.salaryFloorUsd) && raw.salaryFloorUsd > 0 ? Math.round(raw.salaryFloorUsd) : null
  return {
    blockedCountries: strings(raw.blockedCountries, (s) => s.toUpperCase()),
    onlyCountries: [...new Set([...strings(raw.onlyCountries, (s) => s.toUpperCase()), ...t.countries])],
    onsiteCities: strings(raw.onsiteCities, (s) => s.toLowerCase()),
    needsSponsorship: raw.needsSponsorship === true,
    salaryFloorUsd: floor,
    remoteOnly: raw.remoteOnly === true || t.remoteOnly,
    excludedCompanies: [...new Set([...strings(raw.excludedCompanies, (s) => s.toLowerCase()), ...t.excludedCompanies])],
    refusedSeniority: strings(raw.refusedSeniority, (s) => s.toLowerCase()),
    excludedTitleWords: [...new Set([...strings(raw.excludedTitleWords, (s) => s.toLowerCase()), ...t.excludedKeywords])],
  }
}

export function hasAnyConstraint(c: StatedConstraints): boolean {
  return (
    c.blockedCountries.length > 0 ||
    c.onlyCountries.length > 0 ||
    c.onsiteCities.length > 0 ||
    c.needsSponsorship ||
    c.salaryFloorUsd !== null ||
    c.remoteOnly ||
    c.excludedCompanies.length > 0 ||
    c.refusedSeniority.length > 0 ||
    c.excludedTitleWords.length > 0
  )
}

// ---------------------------------------------------------------------------
// Reading the posting
// ---------------------------------------------------------------------------

function norm(s: string): string {
  return ` ${s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `
}

/** Whole-word (or whole-phrase) containment, so "intern" never matches "internal". */
export function containsWord(haystack: string, needle: string): boolean {
  const n = norm(needle).trim()
  return n.length > 0 && norm(haystack).includes(` ${n} `)
}

const COUNTRY_NAMES: Record<string, string> = {
  US: 'the United States',
  CA: 'Canada',
  GB: 'the United Kingdom',
  DE: 'Germany',
  FR: 'France',
  IN: 'India',
  IE: 'Ireland',
  NL: 'the Netherlands',
  ES: 'Spain',
  AU: 'Australia',
  SG: 'Singapore',
  JP: 'Japan',
  BR: 'Brazil',
  MX: 'Mexico',
  PL: 'Poland',
  IL: 'Israel',
}

function countryName(code: string): string {
  return COUNTRY_NAMES[code] ?? code
}

/** A pay range stated in the posting, normalised to USD per year. Null when it states none. */
export interface PayRange {
  min: number
  max: number
}

const MONEY = /(?:\$|usd\s?)\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k)?/gi

/**
 * The first dollar range in a salary field or a posting ("$150,000 - $200,000",
 * "$150k to $200k", "$60/hour"). Only dollar amounts are read; other
 * currencies return null rather than being converted at a guessed rate.
 */
export function parsePayRange(text: string | null | undefined): PayRange | null {
  if (!text) return null
  const t = text.replace(/ /g, ' ')
  const hourly = /\/\s?(?:hr|hour)|per hour|hourly/i.test(t)
  const nums: number[] = []
  for (const m of t.matchAll(MONEY)) {
    let v = Number(m[1].replace(/,/g, ''))
    if (!Number.isFinite(v)) continue
    if (m[2]) v *= 1000
    nums.push(v)
    if (nums.length === 2) break
  }
  if (nums.length === 0) return null
  const [a, b = a] = nums
  const scale = hourly ? 2080 : 1
  const lo = Math.min(a, b) * scale
  const hi = Math.max(a, b) * scale
  // Anything under $10,000 a year is not a salary; it is a figure for something else.
  return hi < 10_000 ? null : { min: lo, max: hi }
}

const NO_SPONSORSHIP = [
  /(?:will|can|does|do|is|are)\s+not\s+(?:be\s+able\s+to\s+)?(?:provide\s+|offer\s+)?(?:visa\s+)?sponsor/i,
  /(?:unable|not able)\s+to\s+(?:provide\s+|offer\s+)?(?:visa\s+)?sponsor/i,
  /\bno\s+(?:visa\s+)?sponsorship\b/i,
  /without\s+(?:the\s+need\s+for\s+)?(?:visa\s+)?sponsorship/i,
  /(?:cannot|can't|won't)\s+(?:provide\s+|offer\s+)?(?:visa\s+)?sponsor/i,
  /sponsorship\s+(?:is\s+)?not\s+(?:available|offered|provided)/i,
]

/** The sentence in which a posting says it will not sponsor, or null when it does not say so. */
export function sponsorshipRefusal(description: string | null | undefined): string | null {
  if (!description) return null
  const sentences = description.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/)
  for (const s of sentences) {
    if (s.length > 400) continue
    if (NO_SPONSORSHIP.some((re) => re.test(s))) return s.trim()
  }
  return null
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/** Every stated constraint this role breaks, each with the reason in plain words. Empty means it stays. */
export function checkConstraints(role: RoleFacts, c: StatedConstraints): BlockReason[] {
  const out: BlockReason[] = []
  const cls = classifyJob({ title: role.title, description: role.description, location: role.location, companyName: role.company })
  const geo = parseLocation(role.location ?? '')
  const country = role.country ?? cls.country ?? geo.country
  const remote = role.isRemote ?? cls.isRemote ?? geo.isRemote
  const seniority = (role.seniority && role.seniority !== 'unknown' ? role.seniority : cls.seniority) as Seniority

  for (const name of c.excludedCompanies) {
    if (containsWord(role.company, name)) {
      out.push({ kind: 'company', text: `You ruled out ${role.company}.` })
      break
    }
  }

  if (country && c.blockedCountries.includes(country)) {
    out.push({ kind: 'location', text: `It is based in ${countryName(country)}, and you said you cannot work there.` })
  } else if (country && c.onlyCountries.length > 0 && !c.onlyCountries.includes(country)) {
    out.push({
      kind: 'location',
      text: `It is based in ${countryName(country)}, and you said you work in ${c.onlyCountries.map(countryName).join(' or ')}.`,
    })
  }

  if (c.remoteOnly && !remote && (role.location ?? '').trim() !== '') {
    out.push({ kind: 'remote', text: 'You said remote roles only, and this one is listed with an office location.' })
  }

  if (
    c.onsiteCities.length > 0 &&
    !remote &&
    (role.location ?? '').trim() !== '' &&
    !c.onsiteCities.some((city) => containsWord(role.location ?? '', city)) &&
    // A country-wide or multi-site listing says nothing about where the person would sit.
    !/\b(?:multiple|various|anywhere|hybrid)\b/i.test(role.location ?? '')
  ) {
    out.push({
      kind: 'location',
      text: `It is on site in ${role.location}, and you can only work on site in ${c.onsiteCities.join(' or ')}.`,
    })
  }

  if (c.needsSponsorship) {
    const sentence = sponsorshipRefusal(role.description)
    if (sentence) out.push({ kind: 'sponsorship', text: `You need visa sponsorship and the posting says: "${sentence.slice(0, 200)}"` })
  }

  if (c.salaryFloorUsd !== null) {
    const pay = parsePayRange(role.salaryRange) ?? parsePayRange(payParagraph(role.description))
    if (pay && pay.max < c.salaryFloorUsd) {
      out.push({
        kind: 'salary',
        text: `The posting pays up to $${Math.round(pay.max).toLocaleString('en-US')}, below the $${c.salaryFloorUsd.toLocaleString('en-US')} floor you set.`,
      })
    }
  }

  if (seniority !== 'unknown' && c.refusedSeniority.includes(seniority)) {
    out.push({ kind: 'seniority', text: `It is a ${seniority} level role, and you said you will not take that level.` })
  }

  for (const w of c.excludedTitleWords) {
    if (containsWord(role.title, w)) {
      out.push({ kind: 'keyword', text: `The title says "${w}", which you ruled out.` })
      break
    }
  }
  return out
}

/** The part of a description that talks about pay, so a stray "$5 million" elsewhere is not read as a salary. */
function payParagraph(description: string | null | undefined): string | null {
  if (!description) return null
  const m = /(?:salary|compensation|base pay|pay range|pay scale|annual)[^$]{0,120}(\$[^\n]{0,160})/i.exec(description)
  return m ? m[1] : null
}
