// Deterministic text chunker for the knowledge base.
//
// PURE AND DEPENDENCY-FREE on purpose: no imports, no I/O, no randomness, no
// Date. It runs identically in a route handler, in the harness, in a cron job,
// and in vitest. See ./chunk.test.ts.
//
// STRATEGY — split on the largest natural boundary that fits, never mid-word:
//   1. paragraphs (blank-line separated)
//   2. sentences, for a paragraph that alone exceeds the target
//   3. words, for a sentence that alone exceeds the target
//   4. a hard character cut, only for a single "word" longer than the target
//      (base64 blobs, minified JSON, URLs with no spaces)
// Atoms produced by that cascade are then packed greedily up to `targetChars`,
// with the tail of the previous chunk repeated as `overlap` so a fact sitting on
// a chunk seam is still retrievable from one chunk alone.
//
// Regex note: no lookbehind/lookahead assertions anywhere. tsconfig targets
// ES2017 and TypeScript errors on lookbehind below ES2018, so sentence
// splitting is a hand-rolled scan instead.

/** One chunk, ready to insert into public.kb_chunks. */
export interface TextChunk {
  /** 0-based position within the source document. */
  ord: number
  content: string
}

export interface ChunkOptions {
  /**
   * Soft maximum characters per chunk. Clamped to 200..20000.
   * 1200 chars is roughly 300 tokens — big enough to hold a whole resume bullet
   * or job-description paragraph, small enough that a retrieval hit is precise.
   */
  targetChars?: number
  /**
   * Characters of the previous chunk repeated at the start of the next one.
   * Clamped to 0..floor(targetChars / 2). Snapped forward to a word boundary,
   * so an overlap never begins mid-word.
   */
  overlap?: number
}

export const DEFAULT_TARGET_CHARS = 1200
export const DEFAULT_OVERLAP = 150

/** Characters that can terminate a sentence. */
const TERMINATORS = '.!?'
/** Closing punctuation allowed to trail a terminator: he said "stop!" */
const CLOSERS = '"\')]}’”'

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/**
 * Normalize line endings and collapse runs of 3+ blank lines to a single blank
 * line, so paragraph detection is stable across CRLF/LF and pasted text.
 */
function normalize(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Split a paragraph into sentences by scanning for terminator runs followed by
 * whitespace or end-of-string. A bare newline also ends a sentence, which is
 * what makes bullet lists (one bullet per line, no blank lines) split cleanly.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = []
  let start = 0

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const isNewline = ch === '\n'
    if (!isNewline && !TERMINATORS.includes(ch)) continue

    // Consume a run of terminators ("..." / "?!") then any closing punctuation.
    let end = i
    if (!isNewline) {
      while (end + 1 < text.length && TERMINATORS.includes(text[end + 1])) end++
      while (end + 1 < text.length && CLOSERS.includes(text[end + 1])) end++
    }

    const after = end + 1
    // A terminator only ends a sentence when whitespace or EOS follows it.
    // This keeps "3.5x", "node.js" and "e.g." from splitting mid-token.
    if (!isNewline && after < text.length && !/\s/.test(text[after])) {
      i = end
      continue
    }

    const piece = text.slice(start, after).trim()
    if (piece) out.push(piece)
    start = after
    i = after - 1
  }

  const rest = text.slice(start).trim()
  if (rest) out.push(rest)
  return out.length ? out : [text.trim()]
}

/**
 * Pack whitespace-separated words into pieces of at most `limit` chars. A single
 * word longer than `limit` is hard-cut — the only place this module ever splits
 * mid-word, and only when there is no alternative.
 */
function packWords(text: string, limit: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const out: string[] = []
  let cur = ''

  for (const word of words) {
    if (word.length > limit) {
      if (cur) {
        out.push(cur)
        cur = ''
      }
      for (let i = 0; i < word.length; i += limit) {
        out.push(word.slice(i, i + limit))
      }
      continue
    }
    const candidate = cur ? `${cur} ${word}` : word
    if (candidate.length <= limit) {
      cur = candidate
    } else {
      out.push(cur)
      cur = word
    }
  }
  if (cur) out.push(cur)
  return out
}

/** A packable unit plus the separator that should precede it. */
interface Atom {
  text: string
  /** '' for the first atom, '\n\n' across paragraphs, ' ' within one. */
  sep: string
}

/** Break one string down until every piece is <= limit. */
function atomize(text: string, limit: number, sep: string): Atom[] {
  if (text.length <= limit) return [{ text, sep }]

  const sentences = splitSentences(text)
  if (sentences.length > 1) {
    const out: Atom[] = []
    sentences.forEach((sentence, i) => {
      out.push(...atomize(sentence, limit, i === 0 ? sep : ' '))
    })
    return out
  }

  // One oversized sentence: fall through to words.
  return packWords(text, limit).map((piece, i) => ({
    text: piece,
    sep: i === 0 ? sep : ' ',
  }))
}

/**
 * The trailing `n` characters of `text`, snapped forward to a word boundary so
 * the overlap never starts mid-word. Returns '' when no clean overlap exists.
 *
 * Skipped entirely when `text` is shorter than 2n: overlapping most of a short
 * chunk would store the same sentence twice and skew ts_rank_cd.
 */
function overlapTail(text: string, n: number): string {
  if (n <= 0 || text.length < n * 2) return ''
  const tail = text.slice(-n)
  const cut = tail.search(/\s/)
  if (cut === -1) return ''
  return tail.slice(cut + 1).trim()
}

/**
 * Split `content` into overlapping, boundary-aligned chunks.
 *
 * Guarantees:
 *   - returns [] for empty/whitespace-only input
 *   - returns exactly one chunk when the content fits in `targetChars`
 *   - `ord` is 0-based and contiguous
 *   - every chunk is non-empty and trimmed, and no chunk exceeds `targetChars`
 *     (a single unbreakable token longer than the target is hard-cut to fit)
 *   - never splits inside a word, except for that hard cut
 *   - the concatenation of all chunks covers the whole normalized input; with
 *     overlap > 0 the seams repeat text, so chunks are a cover, not a partition
 */
export function chunkText(content: string, opts: ChunkOptions = {}): TextChunk[] {
  const targetChars = clamp(opts.targetChars ?? DEFAULT_TARGET_CHARS, 200, 20_000)
  const overlap = clamp(
    opts.overlap ?? DEFAULT_OVERLAP,
    0,
    Math.floor(targetChars / 2)
  )

  const text = normalize(typeof content === 'string' ? content : '')
  if (!text) return []
  if (text.length <= targetChars) return [{ ord: 0, content: text }]

  // 1. Paragraphs, each broken down until it fits.
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  const atoms: Atom[] = []
  paragraphs.forEach((paragraph, i) => {
    atoms.push(...atomize(paragraph, targetChars, i === 0 ? '' : '\n\n'))
  })

  // 2. Greedy pack. Each atom is consumed exactly once, so this always advances.
  const chunks: string[] = []
  let cur = ''

  for (const atom of atoms) {
    if (!cur) {
      cur = atom.text
      continue
    }
    const candidate = cur + atom.sep + atom.text
    if (candidate.length <= targetChars) {
      cur = candidate
      continue
    }

    chunks.push(cur)

    // Seed the next chunk with the previous tail — but only if the atom still
    // fits alongside it, otherwise we would emit a chunk that is mostly a copy.
    const tail = overlapTail(cur, overlap)
    cur =
      tail && tail.length + 1 + atom.text.length <= targetChars
        ? `${tail} ${atom.text}`
        : atom.text
  }
  if (cur) chunks.push(cur)

  // 3. Number them. No content-based dedupe here on purpose: two chunks CAN hold
  // identical text (a repeated boilerplate paragraph, a run of the same token
  // from a hard cut) while still being different positions in the document.
  // Dropping them by string equality/containment silently deleted real content.
  // Chunks are guaranteed non-empty already — every chunk starts from an atom,
  // so none is overlap-only.
  return chunks
    .filter((c) => c.length > 0)
    .map((c, ord) => ({ ord, content: c }))
}
