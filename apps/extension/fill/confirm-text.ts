// How a confirmation is recognised. The patterns are data: the manual fill uses
// these defaults, an automatic send uses the host's own list from the server.

export const DEFAULT_CONFIRMATION: RegExp[] = [
  /thank you for (applying|your application)/i,
  /(your )?application (has been |was )?(submitted|received|sent)/i,
  /we(?:'|\u2019)?ve received your application/i,
  /we have received your application/i,
]

/** The sentence that matched, trimmed, or null. */
export function matchConfirmation(text: string, patterns: RegExp[] = DEFAULT_CONFIRMATION): string | null {
  for (const p of patterns) {
    const m = p.exec(text)
    if (m) {
      const start = Math.max(0, m.index - 40)
      return text.slice(start, Math.min(text.length, m.index + m[0].length + 80)).replace(/\s+/g, ' ').trim()
    }
  }
  return null
}

export function toPatterns(sources: string[]): RegExp[] {
  const out: RegExp[] = []
  for (const s of sources) {
    try {
      out.push(new RegExp(s, 'i'))
    } catch {
      /* a bad pattern from the server is skipped, never thrown */
    }
  }
  return out
}
