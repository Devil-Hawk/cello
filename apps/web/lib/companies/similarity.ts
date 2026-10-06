// Lexical similarity between companies, over a tag vocabulary.
//
// WHY NOT EMBEDDINGS. The only embedding path in the app
// (lib/harness/providers/embeddings.ts) is locked to a paid model, and this
// feature must cost nothing to run for everyone every day. pgvector is
// available, but nothing free feeds it. So similarity is lexical: the
// vocabulary is the Y Combinator tags and industries in the directory, each
// with a document frequency, and two companies are alike when they share
// distinctive tags.
//
// A tag that a large share of companies carry ("B2B", "SaaS", "AI") says
// nothing about taste, so tags above GENERIC_DF are ignored. One shared tag is
// enough only when that tag is rare.

export const GENERIC_DF = 0.15
export const RARE_DF = 0.02

export interface Vocabulary {
  /** lowercase tag -> number of directory companies carrying it */
  df: Map<string, number>
  /** number of directory companies the counts are out of */
  n: number
}

export function buildVocabulary(rows: { tags: string[] | null }[]): Vocabulary {
  const df = new Map<string, number>()
  for (const row of rows) {
    for (const tag of new Set((row.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))) {
      df.set(tag, (df.get(tag) ?? 0) + 1)
    }
  }
  return { df, n: rows.length }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Vocabulary tags that appear in the text as whole words or phrases. */
export function tagsFromText(text: string, vocab: Vocabulary): Set<string> {
  const haystack = ` ${text.toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ')} `
  const found = new Set<string>()
  for (const tag of vocab.df.keys()) {
    const needle = tag.replace(/[^a-z0-9+#.]+/g, ' ').trim()
    if (needle.length < 2) continue
    if (new RegExp(`(?<![a-z0-9+#])${escapeRegExp(needle)}(?![a-z0-9+#])`).test(haystack)) found.add(tag)
  }
  return found
}

function share(tag: string, vocab: Vocabulary): number {
  return vocab.n > 0 ? (vocab.df.get(tag) ?? 0) / vocab.n : 1
}

/** Tags both sets carry, minus the generic ones, rarest first. */
export function sharedTags(a: Set<string>, b: Set<string>, vocab: Vocabulary): string[] {
  return [...a]
    .filter((t) => b.has(t) && vocab.df.has(t) && share(t, vocab) <= GENERIC_DF)
    .sort((x, y) => share(x, vocab) - share(y, vocab) || x.localeCompare(y))
}

/** Two or more shared tags, or one shared tag that is rare. */
export function isSimilar(shared: string[], vocab: Vocabulary): boolean {
  if (shared.length >= 2) return true
  return shared.length === 1 && share(shared[0], vocab) <= RARE_DF
}
