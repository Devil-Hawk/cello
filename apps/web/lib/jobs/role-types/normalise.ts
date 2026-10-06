// normaliseTitle: the key under which one judgement of a title is kept (title_types.title_norm) and the
// level it states (blueprint 6.1). Code only: the same raw title gives the same answer for ever.
//
//   "Sr. Forward Deployed Engineer - NYC (Hybrid)"  ->  "forward deployed engineer", level senior
//
// NFKC and lower case; abbreviations spelled out; level words lifted out into `level` (classify.ts owns
// what a level is); a tail after a separator (" - ", ",", "(", "|", "/", "@") cut when it is a place,
// remote, hybrid or an id, and kept when it is a team ("Data Engineer, ML Platform"); punctuation dropped;
// spaces collapsed. Letters of every language are kept: a title tier 1 cannot read goes on untyped.

import { classifyJob, parseLocation, type Seniority } from '../classify'
import { AMBIGUOUS_TITLES } from './taxonomy'

export interface NormalisedTitle {
  /** The key. Empty when nothing but level words was left ("Lead"). */
  title_norm: string
  /** The level classify.ts reads from the raw title. */
  level: Seniority
}

const MAX_RAW_CHARS = 300
const MAX_NORM_CHARS = 120
const ABBREVIATIONS: Record<string, string> = {
  sr: 'senior',
  jr: 'junior',
  eng: 'engineer',
  engr: 'engineer',
  swe: 'software engineer',
  sde: 'software engineer',
  mle: 'machine learning engineer',
  fde: 'forward deployed engineer',
}
const LEVEL_WORDS = new Set(['intern', 'internship', 'junior', 'senior', 'staff', 'principal', 'lead'])
const NUMERALS = new Set(['i', 'ii', 'iii', 'iv', 'v'])

const SEPARATORS = /\s[-–—]\s|[,()|/@]/
const REMOTE = /^(fully |100 )?(remote|hybrid|on ?site|in ?office|office|work from home|wfh)\b/
const PLACE_ABBREVIATIONS = /^(nyc|sf|la|dc|bay area|emea|apac|latam|amer|nam|us|usa|uk|eu|global|worldwide|anywhere)\b/
const REQUISITION = /^((req|r|job|jr|id|ref|requisition)[ #:-]*)?\d{3,}[a-z0-9]*$/
const GENDER = /^([mwfdxi]|all genders|gn|m f d|m w d|f m x|w m d|m f x)$/
// A segment that names a job is a team or a specialty, never a place, whatever country code its letters spell.
const JOB_WORD = /\b(engineer|developer|scientist|manager|analyst|designer|architect|researcher|platform|infrastructure|software|data|backend|frontend|product|security|devops|sre|cloud|mobile|ios|android|embedded|machine learning|ml|ai)\b/

function squash(s: string): string {
  return s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/** A tail that is where, how or which requisition, not what. */
function isNoise(segment: string): boolean {
  const s = squash(segment)
  if (!s) return true
  if (REMOTE.test(s) || PLACE_ABBREVIATIONS.test(s) || REQUISITION.test(s) || GENDER.test(s)) return true
  if (JOB_WORD.test(s)) return false
  const geo = parseLocation(s)
  return geo.country !== null || geo.isRemote
}

export function normaliseTitle(raw: string): NormalisedTitle {
  const text = (typeof raw === 'string' ? raw : '').normalize('NFKC').toLowerCase().slice(0, MAX_RAW_CHARS)
  const level = classifyJob({ title: text }).seniority

  const [head, ...tails] = text.split(SEPARATORS)
  let words = squash([head, ...tails.filter((t) => !isNoise(t))].join(' ')).split(' ').filter(Boolean)
  words = words.flatMap((w) => (ABBREVIATIONS[w] ?? w).split(' '))

  // "tech lead" is an engineer who leads: the level (manager) comes from classify.ts, the field stays
  const phrase = ` ${words.join(' ')} `.replace(/ (tech|technical) lead /g, ' engineer ')
  words = phrase.trim().split(' ').filter(Boolean)

  const kept = words.filter((w, i) => {
    if (LEVEL_WORDS.has(w)) return w === 'staff' && words[i - 1] === 'technical'
    if (NUMERALS.has(w)) return i !== words.length - 1
    return !/^l[3-7]$/.test(w)
  })
  return { title_norm: kept.join(' ').slice(0, MAX_NORM_CHARS).trim(), level }
}

/** The department or team, written the same way (never a level word lifted out of it). */
export function normaliseDept(raw: string | null | undefined): string {
  return squash((typeof raw === 'string' ? raw : '').normalize('NFKC').toLowerCase().slice(0, MAX_RAW_CHARS)).slice(0, 80).trim()
}

/** The key of one judgement: the department only counts for a title that names no particular job. */
export function titleKey(titleNorm: string, deptNorm: string): { title_norm: string; dept_norm: string } {
  return { title_norm: titleNorm, dept_norm: AMBIGUOUS_TITLES.includes(titleNorm) ? deptNorm : '' }
}
