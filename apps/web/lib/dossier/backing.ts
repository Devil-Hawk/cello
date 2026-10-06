// Is a statement about a company backed by the excerpts it cites? Checked in
// code, not by a model: every number and proper name the statement uses has to
// appear in the cited text. A paraphrase passes; a figure, a named investor or a
// place that the excerpts never mention does not.
//
// This is not the candidate-claim check in lib/security/job-text.ts. That one is
// built to catch a made-up credential in a document sent under the user's name,
// and it reads "$35M" in a source and "$35M" in a sentence as different things.
// Company statements need numbers compared by value and names compared by
// spelling, nothing else.

const UNIT: Record<string, string> = { million: 'm', billion: 'b', thousand: 'k', percent: '%' }

const NUMBER = /[$€£]?\d[\d,]*(?:\.\d+)?\s?(?:%|percent|million|billion|thousand|[kKmMbB]\b)?/g

/** `$35M`, `35 million` and `35m` all become `35m`; `1,200` becomes `1200`. */
function normalizeNumber(raw: string): string {
  const compact = raw.replace(/[$€£,\s]/g, '').toLowerCase()
  const m = compact.match(/^([\d.]+)([a-z%]*)$/)
  if (!m) return compact
  return `${m[1].replace(/\.0+$/, '')}${UNIT[m[2]] ?? m[2]}`
}

function numbersIn(text: string): Set<string> {
  return new Set((text.match(NUMBER) ?? []).map(normalizeNumber))
}

/** Names of the places a statement may be attributed to; they need not be in the excerpt. */
const ATTRIBUTION = new Set(['wikipedia', 'github', 'hacker', 'news'])

/** Capitalised words that are not the first word of a sentence: names, products, places. */
function namesIn(text: string): string[] {
  const out: string[] = []
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const words = sentence.match(/[A-Za-z0-9+#&'-]+/g) ?? []
    words.forEach((w, i) => {
      if (i > 0 && /^[A-Z]/.test(w)) out.push(w)
    })
  }
  return out
}

/**
 * The numbers and names in `statement` that `support` does not contain.
 * `allow` lists names that need no support (the company itself).
 */
export function unbackedTokens(statement: string, support: string, allow: string[] = []): string[] {
  const supportNumbers = numbersIn(support)
  const supportLower = support.toLowerCase()
  const allowed = new Set(allow.flatMap((a) => a.toLowerCase().split(/\s+/)).filter(Boolean))

  const missing: string[] = []
  for (const raw of statement.match(NUMBER) ?? []) {
    if (!supportNumbers.has(normalizeNumber(raw))) missing.push(raw.trim())
  }
  for (const name of namesIn(statement)) {
    const lower = name.toLowerCase()
    if (allowed.has(lower) || ATTRIBUTION.has(lower)) continue
    if (!supportLower.includes(lower)) missing.push(name)
  }
  return [...new Set(missing)]
}
