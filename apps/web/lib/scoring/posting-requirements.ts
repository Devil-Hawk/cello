// What a posting asks for, as the checks of a chance assessment need it.
//
// Scoring does not read postings. The reader already did, once, at ingest, and
// stored the result on jobs.requirements (lib/jobs/requirements.ts): the skills
// the posting names, split into must have and nice to have, the years of
// experience it asks for, and what it says about visa sponsorship, each from the
// posting's own words. This module only turns that record into the list of
// statements a resume is checked against. It is plain code: no model call, no
// storage, and the same answer every time.
//
// A record that is missing, or too short to check anyone against, is "thin": the
// honest answer for that role is "cannot assess yet", never a guess.

import { RequirementsSchema, type Requirements } from '@/lib/jobs/requirements'

export const REQUIREMENT_KINDS = ['skill', 'experience', 'domain', 'education', 'credential', 'authorization', 'language', 'other'] as const
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number]

export interface Requirement {
  id: string
  text: string
  kind: RequirementKind
  mustHave: boolean
  /** The words in the posting the item comes from. */
  quote: string
  /** Who found it: the parser, or a model that read the posting's requirements for the reader. */
  origin: 'code' | 'model'
}

export type RequirementsOutcome =
  | { kind: 'ok'; requirements: Requirement[] }
  /** The posting says too little to check anyone against. Not an error. */
  | { kind: 'thin'; reason: string }

/** Fewest checkable statements for a posting to count as readable, work authorization aside. */
export const MIN_REQUIREMENTS = 2
const MAX_REQUIREMENTS = 12

export const NOT_READ_YET = 'Cello has not read what this posting asks for yet.'
export const TOO_FEW = 'The posting does not list what the role needs.'

function fold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** True when `quote` appears in `text`, ignoring case, spacing and curly punctuation. */
export function quoteIsIn(quote: string, text: string): boolean {
  const q = fold(quote)
  return q.length >= 6 && fold(text).includes(q)
}

/**
 * The statements to check a resume against, from the reader's stored requirements
 * (a jobs.requirements value of any shape). Must haves first, then nice to haves,
 * then the years of experience, then work authorization when the posting says it
 * does not sponsor; at most twelve.
 */
export function fromReaderRequirements(raw: unknown): RequirementsOutcome {
  const parsed = RequirementsSchema.safeParse(raw)
  if (!parsed.success) return { kind: 'thin', reason: NOT_READ_YET }
  const req: Requirements = parsed.data
  const origin: Requirement['origin'] = req.source === 'mixed' ? 'model' : 'code'

  const items: Omit<Requirement, 'id'>[] = []
  for (const text of req.must_have) items.push({ text, kind: 'skill', mustHave: true, quote: text, origin })
  if (req.years_experience.min != null && req.years_experience.min > 0) {
    const text = `${req.years_experience.min}+ years of experience`
    items.push({ text, kind: 'experience', mustHave: true, quote: text, origin: 'code' })
  }
  for (const text of req.nice_to_have) items.push({ text, kind: 'skill', mustHave: false, quote: text, origin })

  if (items.length < MIN_REQUIREMENTS) return { kind: 'thin', reason: TOO_FEW }

  const out = items.slice(0, MAX_REQUIREMENTS)
  // Authorization never moves the label (see chance.ts); it is listed so the person is told to confirm it.
  if (req.visa.sponsorship === 'not_offered') {
    const text = 'Work authorization without sponsorship'
    if (out.length >= MAX_REQUIREMENTS) out.pop()
    out.push({ text, kind: 'authorization', mustHave: true, quote: req.visa.evidence ?? text, origin: 'code' })
  }
  return { kind: 'ok', requirements: out.map((r, i) => ({ ...r, id: `r${i + 1}` })) }
}
