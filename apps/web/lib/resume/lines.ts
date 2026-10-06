// Numbered lines for text a model must cite and code must check.
//
// A draft that says "led a team of 8" can only be checked against a source it
// can point at. Resume text becomes R1..Rn, a job post J1..Jn, company facts
// D1..Dn and past messages H1..Hn. The writer and every judge see the same
// numbered text, so an id in a model's answer either exists or it does not.

export interface NumberedLine {
  id: string
  text: string
}

const ENTITIES: Record<string, string> = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&rsquo;': "'" }

function decode(text: string): string {
  return text.replace(/&(nbsp|amp|lt|gt|quot|#39|rsquo);/g, (m) => ENTITIES[m] ?? m)
}

/** Split on newlines and bullet glyphs, trim, drop empties, keep order. */
function rawLines(text: string, splitLongSentences: boolean): string[] {
  const out: string[] = []
  for (const piece of decode(text).split(/\r?\n|[•▪◦·]/)) {
    const line = piece.replace(/^\s*[-*]\s+/, '').replace(/\s+/g, ' ').trim()
    if (!line) continue
    if (splitLongSentences && line.length > 260) {
      for (const sentence of line.split(/(?<=[.!?])\s+(?=[A-Z0-9])/)) {
        if (sentence.trim()) out.push(sentence.trim())
      }
    } else {
      out.push(line)
    }
  }
  return out
}

/**
 * Number the lines of `text` as `${prefix}1`, `${prefix}2`, ... in order, stopping
 * before the first line that would take the total past `maxChars`. A line is
 * never cut in half, so a quoted line is always something the source said.
 */
export function textLines(text: string | null | undefined, prefix: string, maxChars = 12_000, splitLongSentences = false): NumberedLine[] {
  const lines: NumberedLine[] = []
  let used = 0
  for (const line of rawLines(text ?? '', splitLongSentences)) {
    if (used + line.length > maxChars) break
    used += line.length + 1
    lines.push({ id: `${prefix}${lines.length + 1}`, text: line })
  }
  return lines
}

export function resumeLines(text: string | null | undefined, maxChars = 12_000): NumberedLine[] {
  return textLines(text, 'R', maxChars)
}

export function jobLines(text: string | null | undefined, maxChars = 8_000): NumberedLine[] {
  return textLines(text, 'J', maxChars, true)
}

/** `R1: text` per line, ready for a prompt block. */
export function formatLines(lines: NumberedLine[]): string {
  return lines.map((l) => `${l.id}: ${l.text}`).join('\n')
}

/** The lines whose ids appear in `ids`, in the order given; unknown ids are dropped. */
export function pickLines(lines: NumberedLine[], ids: unknown): NumberedLine[] {
  if (!Array.isArray(ids)) return []
  const byId = new Map(lines.map((l) => [l.id, l]))
  const out: NumberedLine[] = []
  for (const id of ids) {
    const hit = typeof id === 'string' ? byId.get(id.trim().toUpperCase()) : undefined
    if (hit && !out.includes(hit)) out.push(hit)
  }
  return out
}
