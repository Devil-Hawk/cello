// What a posting asks for, read once at ingest into jobs.requirements.
//
// Deterministic parsing does the work: section headings, bullet text, a
// vocabulary of skills, the years/visa/salary/location phrases a posting
// actually uses. Nothing here calls a model. When a posting has no
// requirements section at all (so there is nothing to split must-have from
// nice-to-have), `parseRequirements` says so with `needsModel(...)` and the
// ingest pass may ask a free model, whose answer goes through
// `groundModelAnswer`: every skill must appear in the description verbatim, every
// number must appear in it, or it is dropped.
//
// Framework-free and import-light on purpose: lib/ats/index.ts stores the
// result on every new row, from both the app route and the scheduled script.

import { z } from 'zod'
import { classifyJob } from './classify'
import { findSkills } from './skill-vocabulary'

export const REQUIREMENTS_VERSION = 1

const SENIORITIES = ['intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'manager', 'director', 'exec'] as const

export const RequirementsSchema = z.object({
  version: z.literal(REQUIREMENTS_VERSION),
  /** 'deterministic' read only the text; 'mixed' also used a model for the skill lists. */
  source: z.enum(['deterministic', 'mixed']),
  /** True when the posting had a requirements section, or a model read it. False means the lists are empty because nothing could be split, not because nothing is required. */
  skills_resolved: z.boolean(),
  must_have: z.array(z.string().min(1).max(80)).max(25),
  nice_to_have: z.array(z.string().min(1).max(80)).max(25),
  years_experience: z.object({
    min: z.number().int().min(0).max(40).nullable(),
    max: z.number().int().min(0).max(40).nullable(),
  }),
  seniority: z.enum(SENIORITIES).nullable(),
  location: z.object({
    mode: z.enum(['remote', 'hybrid', 'onsite']).nullable(),
    places: z.array(z.string().min(1).max(80)).max(10),
  }),
  visa: z.object({
    sponsorship: z.enum(['offered', 'not_offered', 'not_stated']),
    /** The sentence the call was read from, verbatim. Null when not stated. */
    evidence: z.string().max(240).nullable(),
  }),
  salary: z
    .object({
      min: z.number().min(0).nullable(),
      max: z.number().min(0).nullable(),
      currency: z.string().max(3).nullable(),
      period: z.enum(['year', 'month', 'hour']).nullable(),
    })
    .nullable(),
  /** When a model last read this posting for its skill lists, even if it found none. Not set by the parser, so a posting is not asked twice until its description changes (which rewrites this record). */
  model_checked_at: z.string().nullable().optional(),
})
export type Requirements = z.infer<typeof RequirementsSchema>

export interface RequirementsInput {
  title: string
  description: string
  location?: string | null
  /** jobs.salary_range as the provider supplied it, e.g. "USD 120,000–160,000 / yr". */
  salaryRange?: string | null
}

// --- sections -------------------------------------------------------------

const MUST_HEADING =
  /^(?:minimum |basic |key |required |core |preferred and )?(?:requirements?|qualifications?|what (?:you['’]ll|you will) (?:need|bring)|what we(?:['’]re| are) looking for|what you(?: need| bring|['’]ve got| have)|who you are|you have|you(?:['’]ll| will) have|about you|your (?:skills|background|profile|experience|expertise|qualifications)|key attributes|skills(?: and experience)?|must[- ]haves?|what we expect|the ideal candidate|who we(?:['’]re| are) looking for)\b/i
const NICE_HEADING =
  /^(?:nice[- ]to[- ]haves?|preferred(?: qualifications| skills| experience)?|bonus(?: points)?|great to have|it['’]s a plus|extra credit|a plus|ideally|we(?:['’]d| would) love|even better|desired)\b/i

function isBullet(line: string): boolean {
  return /^\s*(?:[-*•·▪◦–]|\d{1,2}[.)])\s+/.test(line)
}

/** A short line that is not a sentence and not a bullet: a heading. */
function looksLikeHeading(line: string): boolean {
  const t = line.trim()
  if (!t || isBullet(t) || t.length > 70) return false
  if (/[.,;]$/.test(t)) return false
  return t.split(/\s+/).length <= 9
}

interface Sections {
  must: string
  nice: string
  found: boolean
}

export function splitSections(description: string): Sections {
  const must: string[] = []
  const nice: string[] = []
  let mode: 'must' | 'nice' | null = null
  let found = false
  for (const raw of description.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const heading = line.replace(/[:：]\s*$/, '')
    if (looksLikeHeading(line) || (/[:：]$/.test(line) && line.length < 70)) {
      if (NICE_HEADING.test(heading)) {
        mode = 'nice'
        found = true
        continue
      }
      if (MUST_HEADING.test(heading)) {
        mode = 'must'
        found = true
        continue
      }
      if (looksLikeHeading(line) && !isBullet(line)) {
        mode = null
        continue
      }
    }
    // A bullet that opens with its own label ("Nice to have: Rust") belongs to that label.
    const inline = line.replace(/^\s*(?:[-*•·▪◦–]|\d{1,2}[.)])\s+/, '')
    if (NICE_HEADING.test(inline) && /[:：]/.test(inline)) {
      nice.push(inline)
      found = true
      continue
    }
    if (mode === 'must') must.push(line)
    else if (mode === 'nice') nice.push(line)
  }
  return { must: must.join('\n'), nice: nice.join('\n'), found }
}

// --- individual fields ----------------------------------------------------

const MAX_YEARS = 40

/** The overall years of experience asked for: the largest "N+ years ... experience" in the requirements. */
export function parseYears(text: string): { min: number | null; max: number | null } {
  let best: { min: number; max: number | null } | null = null
  const re = /(\d{1,2})\s*(?:\+|plus)?(?:\s*(?:-|–|—|to)\s*(\d{1,2}))?\s*\+?\s*(?:years?|yrs?)\b/gi
  for (const m of text.matchAll(re)) {
    const around = text.slice(Math.max(0, (m.index ?? 0) - 60), (m.index ?? 0) + m[0].length + 80)
    // "the company has been around for 10 years" is not a requirement.
    if (!/experience|exp\b|background|working|professional|hands[- ]on|in a|as a|minimum|at least|of\s/i.test(around)) continue
    if (/(?:founded|established|been (?:around|in business)|for over \d+ years we)/i.test(around)) continue
    const min = Number(m[1])
    const max = m[2] ? Number(m[2]) : null
    if (min > MAX_YEARS || (max !== null && max > MAX_YEARS)) continue
    if (!best || min > best.min) best = { min, max }
  }
  return best ?? { min: null, max: null }
}

const OFFERED = /(?:visa|work permit|immigration|relocation and visa)[^.\n]{0,40}\b(?:sponsorship )?(?:is |are |will be )?(?:available|provided|offered|supported)|\b(?:we|company)\s+(?:do |does |can |will |are able to |are happy to |offer )?(?:sponsor|support)(?:s)?\s+(?:work )?visas?|sponsorship (?:is )?(?:available|provided|offered)|\bvisa sponsorship\b(?![^.\n]{0,50}\b(?:not|unable|cannot|can['’]t|no)\b)/i
const NOT_OFFERED =
  /(?:\b(?:we|company)\s+(?:do not|don['’]t|cannot|can['’]t|are unable to|will not|won['’]t|are not able to)\s+(?:offer\s+|provide\s+)?(?:visa\s+)?sponsor|(?:no|not)\s+(?:visa\s+)?sponsorship|sponsorship\s+(?:is\s+)?(?:not\s+(?:available|offered|provided)|unavailable)|without\s+(?:the\s+need\s+for\s+)?(?:visa\s+)?sponsorship|must\s+(?:be\s+)?(?:legally\s+)?authori[sz]ed\s+to\s+work[^.\n]{0,60}without|unable\s+to\s+sponsor|not\s+(?:able|in a position)\s+to\s+sponsor)/i

/** The sentence around a match, so the stored evidence is a real quote. */
function sentenceAround(text: string, index: number, length: number): string {
  const before = text.slice(0, index)
  const start = Math.max(before.lastIndexOf('.'), before.lastIndexOf('\n'), -1) + 1
  const after = text.slice(index + length)
  const stop = after.search(/[.\n]/)
  const end = stop === -1 ? text.length : index + length + stop + 1
  return text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 240)
}

export function parseVisa(text: string): Requirements['visa'] {
  // A refusal wins: "we do not offer visa sponsorship" also contains "visa sponsorship".
  const no = NOT_OFFERED.exec(text)
  if (no) return { sponsorship: 'not_offered', evidence: sentenceAround(text, no.index, no[0].length) }
  const yes = OFFERED.exec(text)
  if (yes) return { sponsorship: 'offered', evidence: sentenceAround(text, yes.index, yes[0].length) }
  return { sponsorship: 'not_stated', evidence: null }
}

const CURRENCY_SYMBOL: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP' }

function toNumber(raw: string, k: string | undefined): number {
  const n = Number(raw.replace(/,/g, ''))
  return k ? n * 1000 : n
}

function periodOf(text: string): 'year' | 'month' | 'hour' | null {
  if (/\b(?:per\s+)?hour|\/\s*h(?:ou)?r|hourly/i.test(text)) return 'hour'
  if (/\b(?:per\s+)?month|\/\s*mo(?:nth)?\b|monthly/i.test(text)) return 'month'
  if (/\b(?:per\s+)?(?:year|annum)|\/\s*yr|annual|\bp\.?a\.?\b|\bsalary\b|\bbase\b/i.test(text)) return 'year'
  return null
}

const RANGE =
  /(USD|EUR|GBP|CAD|AUD|CHF|[$€£])\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k)?\s*(?:-|–|—|to)\s*(?:(?:USD|EUR|GBP|CAD|AUD|CHF|[$€£])\s?)?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k)?/i
const SINGLE = /(USD|EUR|GBP|CAD|AUD|CHF|[$€£])\s?(\d{1,3}(?:,\d{3})+|\d{2,}(?:\.\d+)?)\s?(k)?\b/i

function inferPeriod(min: number, ctx: string): 'year' | 'month' | 'hour' | null {
  const explicit = periodOf(ctx)
  if (explicit) return explicit
  if (min >= 20_000) return 'year'
  if (min > 0 && min < 500) return 'hour'
  return null
}

/** A pay range, from the provider's structured string first and the posting text second. */
export function parseSalary(structured: string | null | undefined, description: string): Requirements['salary'] {
  for (const [text, structuredSource] of [[structured ?? '', true], [description, false]] as const) {
    if (!text) continue
    const m = RANGE.exec(text)
    if (m) {
      let a = toNumber(m[2], m[3])
      let b = toNumber(m[4], m[5] ?? m[3])
      // "$150-200k": the k closes the range for both ends.
      if (m[5] && !m[3] && a < 1000) a *= 1000
      if (a > b) [a, b] = [b, a]
      const ctx = text.slice(Math.max(0, (m.index ?? 0) - 80), (m.index ?? 0) + m[0].length + 60)
      const period = inferPeriod(a, ctx)
      if (period === 'year' && a < 1000) continue
      // A range in the posting body must read like pay, not like a funding round.
      if (!structuredSource && !/salary|compensation|pay|base|range|ote|annual|hour/i.test(ctx)) continue
      const cur = CURRENCY_SYMBOL[m[1]] ?? m[1].toUpperCase()
      return { min: a, max: b, currency: cur, period }
    }
    if (structuredSource) {
      const s = SINGLE.exec(text) ?? /(\d{1,3}(?:,\d{3})+)/.exec(text)
      if (s) {
        const hasCur = s.length > 3
        const value = hasCur ? toNumber(s[2], s[3]) : toNumber(s[1], undefined)
        const cur = hasCur ? CURRENCY_SYMBOL[s[1]] ?? s[1].toUpperCase() : null
        return { min: value, max: value, currency: cur, period: inferPeriod(value, text) }
      }
    }
  }
  return null
}

function parseLocation(location: string | null | undefined, title: string, description: string): Requirements['location'] {
  const loc = location ?? ''
  const places = loc
    .split(/\s*[·;|]\s*|\s{2,}/)
    .map((p) => p.trim())
    .filter((p) => p && !/^(?:remote|hybrid|on-?site|anywhere)$/i.test(p))
    .slice(0, 10)
  const head = `${title} ${loc}`
  const body = description.slice(0, 6000)
  const flags = (t: string) => ({
    hybrid: /\bhybrid\b/i.test(t),
    remote: /\bremote\b|work from home|\bwfh\b|distributed team/i.test(t),
    onsite: /\bon[- ]?site\b|\bin[- ]office\b|\bin[- ]person\b/i.test(t),
  })
  const h = flags(head)
  // The structured fields (title, location) outrank prose, which often says "remote-friendly" in a perks list.
  let mode: 'remote' | 'hybrid' | 'onsite' | null = h.hybrid ? 'hybrid' : h.remote ? 'remote' : h.onsite ? 'onsite' : null
  if (!mode) {
    const b = flags(body)
    mode = b.hybrid ? 'hybrid' : b.onsite && !b.remote ? 'onsite' : b.remote && !b.onsite ? 'remote' : null
  }
  return { mode, places }
}

function bulletList(text: string): string[] {
  return findSkills(text)
}

// --- the parse ------------------------------------------------------------

export function parseRequirements(input: RequirementsInput): Requirements {
  const description = (input.description ?? '').trim()
  const sections = splitSections(description)
  const mustText = sections.found ? sections.must : ''
  const mustSkills = bulletList(mustText)
  const niceSkills = bulletList(sections.nice).filter((s) => !mustSkills.includes(s))
  const seniority = classifyJob({ title: input.title, description, location: input.location ?? null }).seniority

  return {
    version: REQUIREMENTS_VERSION,
    source: 'deterministic',
    skills_resolved: sections.found && (mustSkills.length > 0 || niceSkills.length > 0),
    must_have: mustSkills.slice(0, 25),
    nice_to_have: niceSkills.slice(0, 25),
    years_experience: parseYears(mustText || description),
    seniority: seniority === 'unknown' ? null : seniority,
    location: parseLocation(input.location, input.title, description),
    visa: parseVisa(description),
    salary: parseSalary(input.salaryRange, description),
  }
}

// --- the model step -------------------------------------------------------

/** Enough text to read, and no requirements section to read it from. */
export function needsModel(req: Requirements, description: string): boolean {
  return !req.skills_resolved && description.trim().length >= 400
}

export const ModelAnswerSchema = z.object({
  must_have: z.array(z.string()).max(40).default([]),
  nice_to_have: z.array(z.string()).max(40).default([]),
  years_min: z.number().int().nullable().optional(),
})
export type ModelAnswer = z.infer<typeof ModelAnswerSchema>

const norm = (s: string) => s.toLowerCase().replace(/[\s ]+/g, ' ').trim()

/**
 * A skill the model named is kept only if the posting says it: the same words,
 * case aside. A model that "knows" a role at that company needs Kubernetes does
 * not get to put Kubernetes on the job.
 */
export function groundModelAnswer(base: Requirements, description: string, answer: ModelAnswer): Requirements {
  const hay = norm(description)
  const grounded = (items: string[]): string[] => {
    const out: string[] = []
    for (const raw of items) {
      const item = raw.trim().replace(/\s+/g, ' ')
      if (!item || item.length > 80 || item.split(' ').length > 6) continue
      if (!hay.includes(norm(item))) continue
      if (!out.some((o) => norm(o) === norm(item))) out.push(item)
    }
    return out.slice(0, 25)
  }
  const must = grounded(answer.must_have)
  const nice = grounded(answer.nice_to_have).filter((n) => !must.some((m) => norm(m) === norm(n)))
  let years = base.years_experience
  if (years.min === null && typeof answer.years_min === 'number' && answer.years_min >= 0 && answer.years_min <= MAX_YEARS) {
    // The number must be written next to "years" in the posting.
    if (new RegExp(`\\b${answer.years_min}\\s*\\+?\\s*(?:years?|yrs?)\\b`, 'i').test(description)) {
      years = { min: answer.years_min, max: null }
    }
  }
  if (must.length === 0 && nice.length === 0) return base
  return { ...base, source: 'mixed', skills_resolved: true, must_have: must, nice_to_have: nice, years_experience: years }
}
