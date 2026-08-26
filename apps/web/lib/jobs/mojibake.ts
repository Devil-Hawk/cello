// Detect and repair mojibake — text whose UTF-8 bytes were decoded as
// Latin-1/CP1252 somewhere upstream, so "9:00 AM – 6:00 PM" arrives as
// "9:00 AM â<U+0080><U+0093> 6:00 PM" and "·" arrives as "Â·".
//
// WHERE THIS COMES FROM. It is not Cello's own decode: fetchJson() reads bodies
// with Response.json(), which is a spec-mandated UTF-8 decode (verified: it
// still decodes UTF-8 correctly even when the server's Content-Type lies and
// claims charset=ISO-8859-1), and the Greenhouse HTML→text chain
// (unescapeDoubleEncodedHtml + html-to-text) round-trips "– · ’" byte-exactly.
// The corruption is in what the source *sends*: https://remoteok.com/api
// literally serves the JSON escapes "\u00e2\u0080\u0093" for an en dash — i.e. the
// aggregator already decoded the employer's UTF-8 as Latin-1 before we ever
// saw it. 57 of 101 live rows in one sample carried the signature, and every
// mojibake row stored in Cello came from that source. So this module repairs
// the SOURCE's mistake at ingest, rather than a bug in our transport.
//
// Note the corruption is Latin-1, not CP1252: the stored text holds
// U+00E2 U+0080 U+0093 (0x80/0x93 mapped straight through as C1 controls), not
// the "â€“" a CP1252 misread would produce. Both forms are reversed here — the
// CP1252 variant is the more common one in the wild, and costs one lookup
// table to also cover.
//
// Pure and framework-free (no next/*, no path aliases, no Node APIs) so it can
// run in a route handler, a client component, or a plain script alike — the
// same convention lib/jobs/classify.ts follows, which is what lets lib/ats/*
// import it directly.

/**
 * CP1252's printable characters for the bytes 0x80-0x9F. A byte in that range
 * has no Latin-1 letter, so a CP1252 misread renders it as one of these
 * instead of as the C1 control Latin-1 would give. Reversing the map turns
 * "â€™" back into the bytes E2 80 99.
 */
const CP1252_TO_BYTE = new Map<string, number>([
  ['€', 0x80], ['‚', 0x82], ['ƒ', 0x83], ['„', 0x84],
  ['…', 0x85], ['†', 0x86], ['‡', 0x87], ['ˆ', 0x88],
  ['‰', 0x89], ['Š', 0x8a], ['‹', 0x8b], ['Œ', 0x8c],
  ['Ž', 0x8e], ['‘', 0x91], ['’', 0x92], ['“', 0x93],
  ['”', 0x94], ['•', 0x95], ['–', 0x96], ['—', 0x97],
  ['˜', 0x98], ['™', 0x99], ['š', 0x9a], ['›', 0x9b],
  ['œ', 0x9c], ['ž', 0x9e], ['Ÿ', 0x9f],
])

/** The byte a character stands for under a Latin-1/CP1252 misread, or -1. */
function byteFor(ch: string | undefined): number {
  if (!ch) return -1
  const cp = ch.codePointAt(0) as number
  if (cp <= 0xff) return cp
  return CP1252_TO_BYTE.get(ch) ?? -1
}

/**
 * Unicode blocks a repaired sequence is allowed to decode into.
 *
 * This is the guard that keeps the repair from eating legitimate text. Any
 * accented capital followed by a punctuation character is *structurally* a
 * valid two-byte UTF-8 sequence — Spanish «JOSÉ» ends with "É»", which decodes
 * to U+02BB — so structure alone is not evidence of mojibake. Real mojibake
 * decodes to characters people actually write: accented letters, dashes and
 * curly quotes, currency symbols, arrows/checkmarks, CJK, emoji. A decode
 * landing outside those blocks (IPA extensions, spacing modifiers, combining
 * marks, private use) is far more likely to be two innocent characters that
 * happened to sit next to each other, so we leave them alone.
 */
function isPlausibleRepair(cp: number): boolean {
  return (
    (cp >= 0x00a0 && cp <= 0x017f) || // Latin-1 supplement + Latin Extended-A
    (cp >= 0x0370 && cp <= 0x04ff) || // Greek + Cyrillic
    (cp >= 0x2000 && cp <= 0x206f) || // general punctuation: – — ‘ ’ “ ” … •
    (cp >= 0x20a0 && cp <= 0x20bf) || // currency symbols: € ₹ ₽
    (cp >= 0x2100 && cp <= 0x214f) || // letterlike symbols: ™ №
    (cp >= 0x2190 && cp <= 0x2bff) || // arrows, math, misc symbols: → ✓ ★
    (cp >= 0x3000 && cp <= 0x30ff) || // CJK punctuation + kana
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK ideographs
    cp === 0xfe0f || // emoji variation selector
    (cp >= 0x1f000 && cp <= 0x1faff) // emoji
  )
}

interface Sequence {
  /** The code point the mis-decoded bytes originally encoded. */
  cp: number
  /** How many characters of the input the sequence occupies. */
  length: number
}

/**
 * If a well-formed, plausible UTF-8 sequence starts at `i`, decode it.
 * Deliberately strict: overlong encodings, surrogates, out-of-range values and
 * implausible decodes (see isPlausibleRepair) all return null, so a lone "â"
 * or "Â" in otherwise-correct text is never touched.
 */
function decodeSequenceAt(text: string, i: number): Sequence | null {
  const lead = byteFor(text[i])
  // 0xC0/0xC1 are never valid UTF-8 leads (they can only encode overlongs),
  // and 0xF5-0xFF are above the U+10FFFF ceiling — both are skipped here.
  const continuations = lead >= 0xc2 && lead <= 0xdf ? 1 : lead >= 0xe0 && lead <= 0xef ? 2 : lead >= 0xf0 && lead <= 0xf4 ? 3 : 0
  if (continuations === 0) return null
  if (i + continuations >= text.length) return null

  let cp = lead & (continuations === 1 ? 0x1f : continuations === 2 ? 0x0f : 0x07)
  for (let k = 1; k <= continuations; k += 1) {
    const b = byteFor(text[i + k])
    if (b < 0x80 || b > 0xbf) return null
    cp = (cp << 6) | (b & 0x3f)
  }

  const minimum = continuations === 1 ? 0x80 : continuations === 2 ? 0x800 : 0x10000
  if (cp < minimum) return null // overlong encoding — not what a real encoder emits
  if (cp > 0x10ffff) return null
  if (cp >= 0xd800 && cp <= 0xdfff) return null // lone surrogate
  if (!isPlausibleRepair(cp)) return null
  return { cp, length: continuations + 1 }
}

/**
 * True when `text` carries the UTF-8-as-Latin-1 signature — at least one
 * well-formed, plausible mis-decoded sequence. Correct text (including text
 * that merely contains "Â", "â", "é" or "€") reports clean.
 */
export function hasMojibake(text: string | null | undefined): boolean {
  if (!text) return false
  for (let i = 0; i < text.length; i += 1) {
    if (decodeSequenceAt(text, i)) return true
  }
  return false
}

/**
 * Reverse the mis-decode: re-read each mojibake sequence as the bytes it
 * really is and decode those as UTF-8. A no-op (returns the input unchanged,
 * by identity) on text that does not carry the signature, so it is safe to
 * call on every string at ingest, and idempotent — repairing repaired text
 * changes nothing.
 */
export function repairMojibake(text: string): string
export function repairMojibake(text: string | undefined): string | undefined
export function repairMojibake(text: string | null): string | null
export function repairMojibake(text: string | null | undefined): string | null | undefined
export function repairMojibake(text: string | null | undefined): string | null | undefined {
  if (!text || !hasMojibake(text)) return text

  let out = ''
  for (let i = 0; i < text.length; ) {
    const seq = decodeSequenceAt(text, i)
    if (seq) {
      out += String.fromCodePoint(seq.cp)
      i += seq.length
      continue
    }
    // Orphaned "Â" before a space. A non-breaking space is C2 A0, and any
    // whitespace-collapsing step that ran on the already-corrupted text
    // (lib/sources/util.ts stripHtml does `\s+` -> ' ', and U+00A0 matches
    // \s) rewrote the A0 half as a plain space — leaving "Â" stranded, which
    // is what "Â  Â  Â  Design, build" in the stored descriptions is. The
    // sequence can no longer be decoded, but inside a string already proven
    // to be mojibake a "Â" glued to a space is that lost NBSP, so drop it
    // rather than show it. Only reachable behind the hasMojibake() gate.
    if (text[i] === 'Â' && (text[i + 1] === ' ' || text[i + 1] === '\t' || text[i + 1] === '\n')) {
      i += 1
      continue
    }
    out += text[i]
    i += 1
  }
  return out
}
