// Which thing each fact is about (blueprint 5.3). The loop's final answer is structured: parts, each about zero or
// more things, and optionally the one role or company the turn turns on (its subject). Code checks every part
// before it is stored or shown, so a model that moves a fact onto the wrong role is caught here and not by a reader.
//
// A part passes when:
//   - every thing it is about is attached to the chat or was returned by a tool in this turn;
//   - every number, date and quoted phrase in it appears in a command result for one of those things
//     (for a part about nothing in particular, in any result of this turn).
// A cello:<kind>/<id> link survives only for a thing the part is about or this turn returned; otherwise the words
// stay and the link goes. A failing part goes back to the model once; failing again, it is dropped and the answer
// says so. A passing subject adds one card part whose fields code reads from the stored row later.

import { z } from 'zod'
import { ATTACH_KINDS, TABLE_OF, type AttachKind, type ObjectRef, type Part, type TurnLink } from './types'

export const AnswerSchema = z.object({
  /** The one role or company this turn turns on. Code checks it like `about` and builds its card. */
  subject: z.object({ kind: z.enum(['role', 'company']), id: z.string().max(200) }).optional(),
  parts: z
    .array(
      z.object({
        about: z.array(z.object({ kind: z.enum(ATTACH_KINDS), id: z.string().max(200) })).max(6),
        text: z.string().min(1).max(4000),
      })
    )
    .max(20),
})
export type ModelAnswer = z.infer<typeof AnswerSchema>

/** What one command returned in this turn, and the thing it was about (null for a result about nothing in particular). */
export interface TurnResult {
  object: ObjectRef | null
  text: string
  /** Set when the result is something recalled from an earlier chat (chat.recall): where it came from. */
  recalled?: { chat_id: string; turn_id: string }
}

export interface CheckInput {
  /** The tiles the chat holds now. */
  attached: ObjectRef[]
  results: TurnResult[]
}

export interface PartFailure {
  /** Position in the answer, from 1. */
  part: number
  reason: string
}

export const LEFT_OUT = 'Cello left out one statement it could not tie to the right role.'

const key = (o: ObjectRef) => `${o.kind}:${o.ref}`

// --- what a text states: dates, numbers, quotations -------------------------------------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DATE = new RegExp(`\\b(${MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+\\d{4})?|\\b\\d{4}-(\\d{2})-(\\d{2})\\b`, 'gi')
const NUMBER = /(^|[^\w.])(\d[\d,]*(?:\.\d+)?)/g
const QUOTE = /"([^"]{4,200})"|“([^”]{4,200})”/g

/** Markdown links keep their words; URLs and bare cello: references hold digits that are not claims. */
function prose(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\bcello:[a-z]+\/\S+/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/^\s*\d+[.)]\s/gm, '')
}

const squash = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim()

/** What a text states. For a claim, numbers inside a quotation are left to the quotation check; evidence keeps them. */
function facts(text: string, claim = true): { dates: Set<string>; numbers: Set<string>; quotes: string[] } {
  let rest = prose(text)
  const dates = new Set<string>()
  rest = rest.replace(DATE, (_m, mon: string | undefined, day: string | undefined, isoMonth: string | undefined, isoDay: string | undefined) => {
    dates.add(mon ? `${mon.toLowerCase()} ${Number(day)}` : `${MONTHS[Number(isoMonth) - 1]} ${Number(isoDay)}`)
    return ' '
  })
  const quotes = claim ? [...rest.matchAll(QUOTE)].map((m) => squash(m[1] ?? m[2] ?? '').replace(/[.,;:!?]+$/, '')) : []
  const numbers = new Set([...(claim ? rest.replace(QUOTE, ' ') : rest).matchAll(NUMBER)].map((m) => m[2].replace(/,/g, '').replace(/\.$/, '')))
  return { dates, numbers, quotes }
}

/** The numbers, dates and quotations in `text` that none of the `evidence` texts state, worded for a failure line. */
export function unsupported(text: string, evidence: string[]): string[] {
  const have = evidence.map((e) => facts(e, false))
  const haystack = squash(evidence.join('\n'))
  const stated = facts(text)
  return [
    ...[...stated.numbers].filter((n) => !have.some((h) => h.numbers.has(n))).map((n) => `the number ${n}`),
    ...[...stated.dates].filter((d) => !have.some((h) => h.dates.has(d))).map((d) => `the date ${d}`),
    ...stated.quotes.filter((q) => !haystack.includes(q)).map((q) => `the quotation "${q.slice(0, 60)}"`),
  ]
}

// --- the check ----------------------------------------------------------------------------------------

export interface Checked {
  /** Parts that passed, in order, with the card part first when the subject passed. */
  parts: Part[]
  failures: PartFailure[]
  links: TurnLink[]
}

export function checkAnswer(answer: ModelAnswer, input: CheckInput): Checked {
  const known = new Set([...input.attached, ...input.results.flatMap((r) => (r.object ? [r.object] : []))].map(key))
  const returned = new Set(input.results.flatMap((r) => (r.object ? [key(r.object)] : [])))
  const parts: Part[] = []
  const failures: PartFailure[] = []
  const named = new Map<string, ObjectRef>()
  // Things known only from an earlier chat: a part that uses one must carry its link, which names the source.
  const heldNow = new Set([...input.attached.map(key), ...input.results.filter((r) => r.object && !r.recalled).map((r) => key(r.object as ObjectRef))])
  const recalled = new Map<string, { chat_id: string; turn_id: string }>()
  for (const r of input.results) if (r.object && r.recalled && !heldNow.has(key(r.object))) recalled.set(key(r.object), r.recalled)

  answer.parts.forEach((p, i) => {
    const about: ObjectRef[] = p.about.map((a) => ({ kind: a.kind, ref: a.id }))
    const strays = about.filter((a) => !known.has(key(a)))
    if (strays.length) {
      failures.push({ part: i + 1, reason: `it is about ${strays.map((a) => `${a.kind} ${a.ref}`).join(', ')}, which is neither attached nor returned by a tool in this turn` })
      return
    }
    const aboutKeys = new Set(about.map(key))
    const evidence = input.results.filter((r) => (about.length ? r.object !== null && aboutKeys.has(key(r.object)) : true)).map((r) => r.text)
    const missing = unsupported(p.text, evidence)
    if (missing.length) {
      failures.push({ part: i + 1, reason: `${missing.slice(0, 5).join(', ')} not in the results for ${about.length ? about.map((a) => `${a.kind} ${a.ref}`).join(', ') : 'this turn'}` })
      return
    }
    const unlinked = about.filter((a) => recalled.has(key(a)) && !p.text.includes(`cello:${a.kind}/${a.ref}`))
    if (unlinked.length) {
      failures.push({ part: i + 1, reason: `it uses an earlier chat's ${unlinked.map((a) => `${a.kind} ${a.ref}`).join(', ')} without its link` })
      return
    }
    // A link to a thing this part is not about and no tool returned loses the link and keeps its words.
    // A markdown image is a request the browser makes with no click, so it keeps only its alt text.
    const text = p.text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\(cello:([a-z]+)\/([^)\s]+)\)/gi, (whole, label: string, kind: string, id: string) =>
      aboutKeys.has(`${kind}:${id}`) || returned.has(`${kind}:${id}`) ? whole : label
    )
    about.forEach((a) => named.set(key(a), a))
    parts.push({ about, text })
  })

  const s = answer.subject
  const subject: ObjectRef | null = s && known.has(`${s.kind}:${s.id}`) ? { kind: s.kind, ref: s.id } : null
  if (subject) named.set(key(subject), subject)
  return {
    parts: subject ? [{ card: subject }, ...parts] : parts,
    failures,
    links: [...named.values()].map((o): TurnLink => {
      const source = recalled.get(key(o))
      return { kind: o.kind, table: TABLE_OF[o.kind], id: o.ref, role: source ? 'recalled' : 'named', ...(source ? { source } : {}) }
    }),
  }
}

/** An answer whose parts are about two or more attached things is a comparison; code saves it as one. */
export function isComparison(parts: Part[], attached: ObjectRef[]): boolean {
  const held = new Set(attached.map(key))
  const about = new Set(parts.flatMap((p) => ('about' in p ? p.about : [])).map(key).filter((k) => held.has(k)))
  return about.size >= 2
}

// --- one retry ------------------------------------------------------------------------------------------

export interface Settled {
  parts: Part[]
  /** The answer as Markdown: the passed parts, then the line about what was left out. */
  text: string
  links: TurnLink[]
  dropped: number
}

/**
 * `ask(null)` is the model's first answer; `ask(feedback)` asks again with what failed.
 * A failing part goes back once. If the second ask itself fails, the first answer's passing parts stand.
 */
export async function settleAnswer(ask: (feedback: string | null) => Promise<ModelAnswer>, inputOf: CheckInput | (() => CheckInput)): Promise<Settled> {
  // The results a turn checks against are the ones its tools returned, so they are read after each ask, not before.
  const input = () => (typeof inputOf === 'function' ? inputOf() : inputOf)
  let checked = checkAnswer(await ask(null), input())
  if (checked.failures.length) {
    const feedback = [
      'Some statements were not tied to the right thing. Fix each or remove it. Use only numbers, dates and quotations from the command results for the thing a part is about.',
      ...checked.failures.map((f) => `Part ${f.part}: ${f.reason}.`),
    ].join('\n')
    try {
      checked = checkAnswer(await ask(feedback), input())
    } catch {
      // Keep the first answer's passing parts rather than lose the turn.
    }
  }
  const dropped = checked.failures.length
  const left = dropped === 0 ? [] : [dropped === 1 ? LEFT_OUT : `Cello left out ${dropped} statements it could not tie to the right role.`]
  const text = [...checked.parts.flatMap((p) => ('text' in p ? [p.text] : [])), ...left].join('\n\n')
  return { parts: checked.parts, text, links: checked.links, dropped }
}
