// The one judge: is this posting inside this person's targets? Code only, no model call.
//
// Every place that stores a role, lists one or counts one asks this function, so what is stored, what
// is listed and what is counted cannot disagree. Cheapest rung first, and the answer is the first
// rung that says no:
//
//   place        country, remote only, language
//   age          posted longer ago than the window
//   excluded     an excluded company, or an excluded word in the title or the description
//   level        a level the person did not choose
//   dealbreaker  needs sponsorship, a pay floor, onsite cities, a refused level, an excluded title word
//   type         not the kind of role they chose (the type step once role_types_live is on, else
//                their job functions and typed titles)
//   untyped      the type step could not tell what kind of role it is
//
// A role that nothing disagrees with, whose place, level or function could not be read, is kept hidden
// (`hidden: true`): the person can still find it and it is never silently lost. With nothing stated,
// nothing is filtered.

import { EMPTY_TARGETING, type Targeting } from '../targeting'
import { isStalePosting } from '../jobs/freshness'
import type { ParsedTitle } from '../matching/title-rank'
import { assessTargetRelevance, prepareTargets, typeVerdict, type PersonTargets } from '../jobs/target-relevance'
import type { OutsideReason } from '../jobs/relevance-types'
import { classifyJob, parseLocation, type Seniority } from '../jobs/classify'
import { containsWord, parsePayRange, sponsorshipRefusal, type StatedConstraints } from '../scoring/constraints'
import type { BlockReason, RoleFacts } from '../scoring/types'

export type KeepReason = OutsideReason

export type Keep = { keep: true; hidden: boolean } | { keep: false; reason: KeepReason }

/** What the judge reads of a posting. Everything but the title may be missing; a missing fact is never a disagreement. */
export interface RoleToKeep {
  title: string
  description?: string | null
  job_function?: string | null
  seniority?: string | null
  country?: string | null
  language?: string | null
  is_remote?: boolean | null
  location?: string | null
  salary_range?: string | null
  postedAt?: string | null
  title_norm?: string | null
  role_type?: string | null
  /** The employer's name as the person sees it. */
  company?: string | null
}

// --- reading the role against the stated targets --------------------------------------------------------

type Verdict = 'inside' | 'outside' | 'unclassified'

/**
 * A title with no level word ("Data Scientist", "Software Engineer") is an ordinary individual-contributor
 * role, so with junior, mid or senior targeted an unmarked title counts as inside. Without this the default
 * targets of a junior or mid candidate would hide every plain title.
 */
const UNMARKED_IS_IC = ['junior', 'mid', 'senior']
const isBlank = (v: string | null | undefined) => v == null || v === '' || v === 'unknown'

/** Keywords reduced to plain text: wildcard and list-syntax characters are dropped. */
const keywordsOf = (t: Targeting) => t.excludedKeywords.map((k) => k.replace(/[%_\\,()"*]/g, '').trim()).filter(Boolean)

/** Inside, outside, or unclassified (nothing disagrees but a dimension the person set could not be read). */
function read(job: RoleToKeep, t: Targeting): Verdict {
  const name = (job.company ?? '').toLowerCase()
  if (name && t.excludedCompanies.some((c) => name.includes(c))) return 'outside'
  const text = job.title.toLowerCase()
  const body = (job.description ?? '').toLowerCase()
  if (keywordsOf(t).some((k) => text.includes(k) || body.includes(k))) return 'outside'

  let unread = false

  if (t.functions.length > 0) {
    const fn = job.job_function
    if (fn && t.functions.includes(fn)) {
      /* inside */
    } else if (isBlank(fn) || fn === 'other') unread = true
    else return 'outside'
  }

  if (t.seniority.length > 0) {
    const sr = job.seniority
    if (sr && t.seniority.includes(sr)) {
      /* inside */
    } else if (isBlank(sr)) {
      if (!t.seniority.some((s) => UNMARKED_IS_IC.includes(s))) unread = true
    } else return 'outside'
  }

  if (t.countries.length > 0) {
    const c = job.country?.toUpperCase()
    if (!c) unread = true
    else if (!t.countries.includes(c)) return 'outside'
  }

  if (t.languages.length > 0) {
    const l = job.language?.toLowerCase()
    if (isBlank(l)) unread = true
    else if (!t.languages.includes(l!)) return 'outside'
  }

  if (t.remoteOnly) {
    if (job.is_remote === true) {
      /* inside */
    } else if (job.is_remote == null) unread = true
    else return 'outside'
  }

  return unread ? 'unclassified' : 'inside'
}

// --- dealbreakers: facts the person stated about what they cannot or will not do ---------------------------

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
const countryName = (code: string) => COUNTRY_NAMES[code] ?? code

const AMOUNT = String.raw`(?:\$|usd\s?)\s?\d[\d,]*(?:\.\d+)?\s?k?`
const PAY_RANGE = new RegExp(String.raw`(?:salary|compensation|base pay|pay range|pay scale|annual)([^$]{0,120})(${AMOUNT}\s*(?:-|\u2013|\u2014|to)\s*${AMOUNT})(.{0,24})`, 'i')
/** Pay that is not the salary: a range of these is a bonus or an allowance, never the floor's business. */
const NOT_SALARY = /bonus|stipend|allowance|relocation|sign-?on|signing|equity|stock|commission|reimburs/i
const NOT_SALARY_AFTER = /^\s*(?:\w+\s+)?(?:bonus|stipend|allowance)/i

/**
 * The pay range a description states, or null. Only a range (two dollar amounts joined by a dash or "to")
 * after a pay word counts, never a single amount: a $20,000 relocation allowance is not a salary, and a role
 * is only blocked on pay the posting states.
 * ponytail: a range written "$150k - 200k" (no sign on the second amount) is not read, so it keeps.
 */
function payParagraph(description: string | null | undefined): string | null {
  const m = description ? PAY_RANGE.exec(description) : null
  return m && !NOT_SALARY.test(m[1]) && !NOT_SALARY_AFTER.test(m[3]) ? m[2] : null
}

/**
 * Every stated constraint this role breaks, each with the reason in plain words. Empty means it stays.
 * A constraint only applies when both the stated fact and the posting's own words are clear: where the
 * posting is silent (no pay listed, no location given) the role stays. The scoring step writes these
 * into `blocked_reasons`.
 */
export function blockReasons(role: RoleFacts, c: StatedConstraints): BlockReason[] {
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
    // ponytail: only a "City, Region" location can name a city we know is not theirs. A single word ("London",
    // "NYC") could be a city, a state or a region, so it keeps; upgrade is a city list.
    (role.location ?? '').includes(',') &&
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

// --- the judge ---------------------------------------------------------------------------------------------

// The parsed target titles, once per targets object: a read judges one person's targets against hundreds of roles.
const parsed = new WeakMap<object, ParsedTitle[]>()
function parsedTitles(t: PersonTargets): ParsedTitle[] {
  let p = parsed.get(t)
  if (!p) parsed.set(t, (p = prepareTargets(t.titles)))
  return p
}

export function keepsRole(role: RoleToKeep, targets: PersonTargets): Keep {
  const tg = targets.targeting
  const only = (over: Partial<Targeting>) => read(role, { ...EMPTY_TARGETING, ...over })

  const place = only({ countries: tg.countries, remoteOnly: tg.remoteOnly, languages: tg.languages })
  if (place === 'outside') return { keep: false, reason: 'place' }
  if (isStalePosting(role.postedAt)) return { keep: false, reason: 'age' }
  if (only({ excludedCompanies: tg.excludedCompanies, excludedKeywords: tg.excludedKeywords }) === 'outside') return { keep: false, reason: 'excluded' }
  const level = only({ seniority: tg.seniority })
  if (level === 'outside') return { keep: false, reason: 'level' }
  const c = targets.constraints
  if (
    c &&
    blockReasons(
      {
        id: '',
        title: role.title,
        company: role.company ?? '',
        location: role.location ?? null,
        description: role.description ?? null,
        salaryRange: role.salary_range ?? null,
        seniority: role.seniority,
        country: role.country,
        isRemote: role.is_remote,
      },
      c
    ).length > 0
  ) {
    return { keep: false, reason: 'dealbreaker' }
  }
  if (targets.typeStep?.live && targets.typeStep.chosen.length > 0) {
    const v = typeVerdict(role, targets.typeStep)
    if (v === 'other') return { keep: false, reason: 'type' }
    if (v === 'unknown') return { keep: false, reason: 'untyped' }
    return { keep: true, hidden: v === 'near' || place === 'unclassified' || level === 'unclassified' }
  }
  const fn = only({ functions: tg.functions })
  if (fn === 'outside') return { keep: false, reason: 'type' }
  const titles = parsedTitles(targets)
  if (titles.length > 0 && !assessTargetRelevance({ title: role.title, jobFunction: role.job_function }, titles).keep) return { keep: false, reason: 'type' }
  return { keep: true, hidden: place === 'unclassified' || level === 'unclassified' || fn === 'unclassified' }
}
