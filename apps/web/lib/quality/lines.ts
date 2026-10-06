// Numbered source lines, so a model can cite what it relied on and code can
// check the citation.
//
// A resume becomes R1, R2, ...; a job posting J1, J2, ...; a goal G1, G2, ...
// The model is told to tie each claim to one or more of these ids. Code then
// drops any claim whose ids do not exist, or whose cited text shares no
// meaningful word with the claim. That is not a proof that the claim is
// right, but a claim that cites nothing real, or something unrelated, is
// caught without a second model call.

export type LinePrefix = 'R' | 'J' | 'G'

export interface Lines {
  /** The text to put in the prompt: `R1: ...` one per line. */
  block: string
  /** id -> the line's text, for checking citations. */
  byId: Map<string, string>
}

const MAX_LINE_CHARS = 300

/** Split long paragraphs at sentence ends into pieces of at most `max` characters. */
function pieces(paragraph: string, max: number): string[] {
  if (paragraph.length <= max) return [paragraph]
  const sentences = paragraph.split(/(?<=[.!?])\s+/)
  const out: string[] = []
  let current = ''
  for (const sentence of sentences) {
    if (sentence.length > max) {
      if (current) out.push(current)
      current = ''
      for (let i = 0; i < sentence.length; i += max) out.push(sentence.slice(i, i + max))
    } else if (current && current.length + 1 + sentence.length > max) {
      out.push(current)
      current = sentence
    } else current = current ? `${current} ${sentence}` : sentence
  }
  if (current) out.push(current)
  return out
}

/** Number the non-empty lines of `text`. Long paragraphs are split so every id points at something short. */
export function numberLines(text: string | null | undefined, prefix: LinePrefix, opts: { maxLines?: number } = {}): Lines {
  const maxLines = opts.maxLines ?? 120
  const byId = new Map<string, string>()
  const rows: string[] = []
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim()
    if (!line) continue
    for (const piece of pieces(line, MAX_LINE_CHARS)) {
      if (byId.size >= maxLines) break
      const id = `${prefix}${byId.size + 1}`
      byId.set(id, piece)
      rows.push(`${id}: ${piece}`)
    }
  }
  return { block: rows.join('\n'), byId }
}

/** Several sources behind one lookup. */
export function mergeLines(...sources: Lines[]): Map<string, string> {
  const all = new Map<string, string>()
  for (const s of sources) for (const [id, text] of s.byId) all.set(id, text)
  return all
}

const STOP = new Set(
  'a an and are as at be been but by can for from had has have he her his i if in into is it its of on or our she so that the their them they this to was we were will with you your not no than then there these those who which what when where while about also more most other over such only own same very just'.split(' ')
)

/** Lowercase words of 3+ letters or digits, minus common words. */
export function contentWords(text: string): Set<string> {
  const out = new Set<string>()
  for (const w of text.toLowerCase().match(/[a-z0-9][a-z0-9+#.]*/g) ?? []) {
    const word = w.replace(/\.+$/, '')
    if (word.length >= 3 && !STOP.has(word)) out.add(word)
  }
  return out
}

/** True when the two texts share at least one content word. */
export function sharesContentWord(a: string, b: string): boolean {
  const wa = contentWords(a)
  for (const w of contentWords(b)) if (wa.has(w)) return true
  return false
}

/** Cite ids as the model wrote them, normalised: upper case, trimmed, no duplicates. */
export function cleanCites(cites: unknown): string[] {
  if (!Array.isArray(cites)) return []
  const out: string[] = []
  for (const c of cites) {
    if (typeof c !== 'string') continue
    const id = c.trim().toUpperCase()
    if (/^[RJG]\d{1,3}$/.test(id) && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * Are the citations real? Every id must exist, and the claim must share a
 * content word with at least one of the lines it cites. An empty list is not a
 * citation.
 */
export function citesSupport(claim: string, cites: string[], byId: Map<string, string>): boolean {
  if (cites.length === 0) return false
  if (!cites.every((id) => byId.has(id))) return false
  return cites.some((id) => sharesContentWord(claim, byId.get(id) as string))
}
