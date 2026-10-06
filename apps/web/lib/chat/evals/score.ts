// S21: answers about many things. On the scripted asks, the share of answer parts whose `about` names the right
// objects, and the facts (numbers, dates, quotations) tied to the wrong object. The bar is at least 0.95 of parts
// right and no fact on the wrong object. Plain code over the answer and what the commands returned: no model judges it.

import { unsupported } from '../answer'

export interface S21Case {
  id: string
  /** What each expected part is about, as the owner labelled it: one list of object keys per part. */
  expected: string[][]
  /** What the commands returned for each object key. */
  evidence: Record<string, string>
  /** What the model answered, with `about` as object keys. */
  answer: { about: string[]; text: string }[]
}

export interface S21Score {
  parts: number
  right: number
  /** Parts right over parts; 0 when there are no parts. */
  share: number
  /** Facts a part states that only another attached object's results hold. */
  wrongObjectFacts: number
  passed: boolean
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x))

export function scoreS21(cases: S21Case[]): S21Score {
  let parts = 0
  let right = 0
  let wrongObjectFacts = 0
  for (const c of cases) {
    for (const part of c.answer) {
      parts++
      if (c.expected.some((e) => sameSet(e, part.about))) right++
      if (part.about.length === 0) continue
      const own = part.about.map((k) => c.evidence[k] ?? '')
      const others = Object.keys(c.evidence).filter((k) => !part.about.includes(k)).map((k) => c.evidence[k])
      const stray = unsupported(part.text, others)
      // Missing from this part's own objects but stated by another one: the fact is on the wrong object.
      wrongObjectFacts += unsupported(part.text, own).filter((f) => !stray.includes(f)).length
    }
  }
  const share = parts === 0 ? 0 : right / parts
  return { parts, right, share, wrongObjectFacts, passed: parts > 0 && share >= 0.95 && wrongObjectFacts === 0 }
}
