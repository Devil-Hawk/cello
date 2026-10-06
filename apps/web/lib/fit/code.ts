// The code tier (K17b): each requirement read against the person's own material, with no model.
//
// A requirement's terms are the skills the posting names in it and the significant words of its text.
// A match outside a negated phrase is a Strength with the line it was found in as its quote. A term
// found only inside a negated phrase ("No Kubernetes experience yet") is not a strength and is not
// "not found" either: it stays unknown, because only a model or the person may call it a gap. No term
// anywhere is Not found, a fact about where code looked.
//
// ponytail: whole-word matching on lowercase text, a four-word negation window, and for a requirement
// with no skills a line must hold two of its words (one when it has only one, or when the requirement says "or"). A synonym ("k8s") is not
// matched; the model step reads those. Upgrade path: a synonym list per skill from the skills taxonomy.

import type { FitEvidence, FitItem, FitRequirement } from './types'
import type { MaterialSource } from './material'

const STOP = new Set(
  (
    'a an and are as at be been but by can could do does for from had has have if in into is it its may more most must need not of on or our ' +
    'should so such than that the their them then there these they this those to up us was we were what when where which while who will with would you your ' +
    'experience experienced years year strong stronger ability able knowledge working work worked team teams skills skill proven excellent good great ' +
    'including include using use used related relevant plus preferred required requirements requirement ideally minimum least etc other any all both each ' +
    'demonstrated understanding familiarity familiar comfortable background expertise solid deep hands practical'
  ).split(' ')
)

/** Words that turn a nearby term into a statement of what the person lacks. */
const NEGATORS = new Set(['no', 'not', 'without', 'yet', 'never', 'lack', 'lacking', 'none', "don't", "haven't", "hasn't"])

const NEGATION_WINDOW = 4

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The words and phrases a requirement is looked for by, lowercase and deduplicated. */
export function termsOf(req: FitRequirement): { skills: string[]; words: string[] } {
  const skills = [...new Set(req.skills.map((s) => s.trim().toLowerCase()).filter(Boolean))]
  // A capitalised two-letter word is a skill ("Go", "AI", "R"), a lowercase one is grammar.
  const tokens = req.text.match(/[A-Za-z][A-Za-z0-9+#.]*[A-Za-z0-9+#]|[A-Za-z]/g) ?? []
  const words = [
    ...new Set(
      tokens
        .filter((w) => !STOP.has(w.toLowerCase()) && (w.length >= 3 || /^[A-Z]/.test(w)))
        .map((w) => w.toLowerCase())
    ),
  ]
  return { skills, words }
}

/** A matcher for one term as a whole word or phrase (so "go" never matches "good", and "c++" works). */
function matcher(term: string): RegExp {
  return new RegExp(`(^|[^a-z0-9+#])${escape(term)}(?=$|[^a-z0-9+#])`, 'g')
}

/** True when a negating word stands within four words before the match, or "yet" or "never" within three after it. */
export function isNegated(line: string, index: number, length: number): boolean {
  const before = line.slice(0, index).toLowerCase().match(/[a-z']+/g) ?? []
  if (before.slice(-NEGATION_WINDOW).some((w) => NEGATORS.has(w))) return true
  const after = line.slice(index + length).toLowerCase().match(/[a-z']+/g) ?? []
  return after.slice(0, 3).some((w) => w === 'yet' || w === 'never')
}

/** The lines of a source, which is what a quote is cut from. */
export function linesOf(text: string): string[] {
  return text
    .split(/\n|•|;/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length >= 4)
}

const clip = (line: string) => (line.length > 240 ? `${line.slice(0, 237)}...` : line)

interface Found {
  strength: FitEvidence | null
  negated: boolean
}

/** Looks for one requirement's terms in every source, in order. */
function findIn(sources: readonly MaterialSource[], terms: string[], needed: number): Found {
  const out: Found = { strength: null, negated: false }
  for (const s of sources) {
    for (const line of linesOf(s.text)) {
      const lower = line.toLowerCase()
      let hits = 0
      let allNegated = true
      for (const term of terms) {
        const re = matcher(term)
        let m: RegExpExecArray | null
        while ((m = re.exec(lower))) {
          const at = m.index + m[1].length
          if (isNegated(lower, at, term.length)) {
            out.negated = true
            continue
          }
          hits++
          allNegated = false
          break
        }
      }
      if (hits >= needed && !allNegated) {
        out.strength = { source: s.source, ref: s.ref, quote: clip(line) }
        return out
      }
    }
  }
  return out
}

/** The code verdict for one requirement. Authorization is the person's to confirm, never read from text. */
export function codeVerdict(req: FitRequirement, sources: readonly MaterialSource[], isAuthorization = false): FitItem {
  const base = { requirementId: req.id, requirement: req.text, origin: 'code' as const }
  if (isAuthorization) return { ...base, verdict: 'unknown', evidence: [] }
  const { skills, words } = termsOf(req)
  // Skills the posting names are looked for one at a time. With none, a line must hold two of the words
  // (one when the requirement has only one significant word).
  const terms = skills.length > 0 ? skills : words
  if (terms.length === 0) return { ...base, verdict: 'unknown', evidence: [], notFound: true }
  // "Go or Java" is satisfied by either; otherwise two of the words on one line, so "systems" alone settles nothing.
  const alternatives = /\bor\b|\//i.test(req.text)
  const needed = skills.length > 0 || alternatives ? 1 : Math.min(2, terms.length)
  const found = findIn(sources, terms, needed)
  if (found.strength) return { ...base, verdict: 'strength', evidence: [found.strength] }
  return { ...base, verdict: 'unknown', evidence: [], ...(found.negated ? {} : { notFound: true }) }
}

export function codeVerdicts(reqs: readonly FitRequirement[], sources: readonly MaterialSource[], authorizationIds: ReadonlySet<string> = new Set()): FitItem[] {
  return reqs.map((r) => codeVerdict(r, sources, authorizationIds.has(r.id)))
}
