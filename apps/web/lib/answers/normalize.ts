// A question's key: what two forms asking the same thing share. Lower case, punctuation and filler
// removed, spaces collapsed. Words that carry meaning are never removed (not, no, you, now, future,
// without, to, in), so a question and its opposite never share a key.

const FILLER = new Set(['a', 'an', 'the', 'please', 'kindly', 'required', 'optional', 'if', 'applicable'])

export function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .replace(/\(\s*(required|optional)\s*\)/g, ' ')
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/'/g, '')
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w))
    .join(' ')
    .slice(0, 500)
}

/** Trigrams as pg_trgm makes them: each word padded with two spaces before and one after. */
function trigrams(key: string): Set<string> {
  const out = new Set<string>()
  for (const w of key.split(/[^a-z0-9]+/).filter(Boolean)) {
    const p = `  ${w} `
    for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3))
  }
  return out
}

/** pg_trgm's similarity of two keys: shared trigrams over all trigrams. */
export function similarity(a: string, b: string): number {
  const x = trigrams(a)
  const y = trigrams(b)
  if (x.size === 0 || y.size === 0) return 0
  let shared = 0
  for (const t of x) if (y.has(t)) shared++
  return shared / (x.size + y.size - shared)
}
