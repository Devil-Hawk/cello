import { describe, expect, it } from 'vitest'
import { diffLines, diffStats, diffWords, toSplitRows } from './diff'
import type { DiffLine } from './diff'

// ---------------------------------------------------------------------------
// Reference implementation: the ORIGINAL hand-rolled classic-LCS diff that
// diff.ts used before it was swapped for `diff` (jsdiff). Kept here, in the
// test file only, purely as an oracle to prove the jsdiff-backed
// implementation is behaviorally equivalent. Do not import this from
// application code — it is intentionally frozen, not maintained.
// ---------------------------------------------------------------------------
function referenceDiffLines(before: string, after: string): DiffLine[] {
  const a = (before ?? '').split('\n')
  const b = (after ?? '').split('\n')
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const result: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ type: 'same', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: 'remove', text: a[i] })
      i++
    } else {
      result.push({ type: 'add', text: b[j] })
      j++
    }
  }
  while (i < n) {
    result.push({ type: 'remove', text: a[i] })
    i++
  }
  while (j < m) {
    result.push({ type: 'add', text: b[j] })
    j++
  }
  return result
}

function referenceStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.type === 'add') added++
    else if (line.type === 'remove') removed++
  }
  return { added, removed }
}

// Deterministic PRNG so failures are reproducible without a seed dependency.
function mulberry32(seed: number) {
  let a = seed
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const LINE_ALPHABET = ['apple', 'banana', 'cherry', 'date', 'egg']
const WORD_ALPHABET = ['the', 'quick', 'brown', 'fox', 'jumps', ' ', '  ', '\t']

function randomLineText(rng: () => number, lineCount: number): string {
  const lines: string[] = []
  for (let i = 0; i < lineCount; i++) {
    const len = 1 + Math.floor(rng() * 4)
    let s = ''
    for (let k = 0; k < len; k++) s += LINE_ALPHABET[Math.floor(rng() * LINE_ALPHABET.length)]
    lines.push(s)
  }
  return lines.join('\n')
}

function randomWordText(rng: () => number): string {
  const len = Math.floor(rng() * 10)
  let s = ''
  for (let i = 0; i < len; i++) {
    s += WORD_ALPHABET[Math.floor(rng() * WORD_ALPHABET.length)]
    if (rng() < 0.7) s += ' '
  }
  return s
}

describe('diffLines — concrete cases', () => {
  it('returns no diff for identical text', () => {
    const result = diffLines('a\nb\nc', 'a\nb\nc')
    expect(result).toEqual([
      { type: 'same', text: 'a' },
      { type: 'same', text: 'b' },
      { type: 'same', text: 'c' },
    ])
  })

  it('marks every line removed when after is empty', () => {
    expect(diffLines('a\nb', '')).toEqual([
      { type: 'remove', text: 'a' },
      { type: 'remove', text: 'b' },
      { type: 'add', text: '' },
    ])
  })

  it('marks every line added when before is empty', () => {
    expect(diffLines('', 'a\nb')).toEqual([
      { type: 'remove', text: '' },
      { type: 'add', text: 'a' },
      { type: 'add', text: 'b' },
    ])
  })

  it('detects a single changed line surrounded by unchanged context', () => {
    const result = diffLines('one\ntwo\nthree', 'one\nTWO\nthree')
    expect(result).toEqual([
      { type: 'same', text: 'one' },
      { type: 'remove', text: 'two' },
      { type: 'add', text: 'TWO' },
      { type: 'same', text: 'three' },
    ])
  })

  it('preserves split(\'\\n\') semantics for a trailing newline (trailing empty line)', () => {
    // 'a\nb\n'.split('\n') === ['a', 'b', ''] — the old hand-rolled version
    // diffed that trailing '' as a real line, and the jsdiff-backed version
    // must too (this is exactly why diffArrays is used instead of jsdiff's
    // own string-oriented diffLines, which does not produce a trailing '').
    const result = diffLines('a\nb\n', 'a\nb\n')
    expect(result).toEqual([
      { type: 'same', text: 'a' },
      { type: 'same', text: 'b' },
      { type: 'same', text: '' },
    ])
  })

  it('treats null/undefined-ish input the same as the old (before ?? "") guard', () => {
    // @ts-expect-error — exercising the runtime ?? guard for non-TS callers
    expect(diffLines(undefined, 'a')).toEqual([
      { type: 'remove', text: '' },
      { type: 'add', text: 'a' },
    ])
  })
})

describe('diffWords — concrete cases', () => {
  it('returns no diff for identical text', () => {
    expect(diffWords('hello world', 'hello world')).toEqual([{ type: 'same', text: 'hello world' }])
  })

  it('isolates a single changed word, merging adjacent same-type runs', () => {
    const result = diffWords('the quick fox', 'the slow fox')
    expect(result).toEqual([
      { type: 'same', text: 'the ' },
      { type: 'remove', text: 'quick' },
      { type: 'add', text: 'slow' },
      { type: 'same', text: ' fox' },
    ])
  })

  it('keeps whitespace as its own token stream so before/after reconstruct exactly', () => {
    const before = 'a  b\tc'
    const after = 'a  X\tc'
    const result = diffWords(before, after)
    const reconstructedBefore = result
      .filter((t) => t.type === 'same' || t.type === 'remove')
      .map((t) => t.text)
      .join('')
    const reconstructedAfter = result
      .filter((t) => t.type === 'same' || t.type === 'add')
      .map((t) => t.text)
      .join('')
    expect(reconstructedBefore).toBe(before)
    expect(reconstructedAfter).toBe(after)
  })
})

describe('toSplitRows / diffStats — unchanged consumers of the new engine', () => {
  it('splits a line diff into left/right columns', () => {
    const rows = toSplitRows(diffLines('a\nb', 'a\nc'))
    expect(rows).toEqual([
      { left: 'a', right: 'a', type: 'same' },
      { left: 'b', right: null, type: 'remove' },
      { left: null, right: 'c', type: 'add' },
    ])
  })

  it('counts added/removed lines', () => {
    expect(diffStats(diffLines('a\nb\nc', 'a\nX\nY'))).toEqual({ added: 2, removed: 2 })
  })
})

describe('parity with the pre-swap hand-rolled LCS implementation (fuzz)', () => {
  it('diffLines: diffStats(added/removed) counts always match the reference implementation', () => {
    const rng = mulberry32(20260728)
    for (let t = 0; t < 3000; t++) {
      const before = randomLineText(rng, Math.floor(rng() * 8))
      const after = randomLineText(rng, Math.floor(rng() * 8))
      const got = diffStats(diffLines(before, after))
      const want = referenceStats(referenceDiffLines(before, after))
      expect(got).toEqual(want)
    }
  })

  it('diffLines: same+remove entries always reconstruct `before`, same+add always reconstruct `after`', () => {
    const rng = mulberry32(4242)
    for (let t = 0; t < 3000; t++) {
      const before = randomLineText(rng, Math.floor(rng() * 8))
      const after = randomLineText(rng, Math.floor(rng() * 8))
      const result = diffLines(before, after)
      const reconstructedBefore = result
        .filter((l) => l.type === 'same' || l.type === 'remove')
        .map((l) => l.text)
        .join('\n')
      const reconstructedAfter = result
        .filter((l) => l.type === 'same' || l.type === 'add')
        .map((l) => l.text)
        .join('\n')
      expect(reconstructedBefore).toBe(before)
      expect(reconstructedAfter).toBe(after)
    }
  })

  it('diffLines: exact match against the reference implementation whenever inputs have no duplicate lines', () => {
    // Tie-breaking between the old DP table and jsdiff's Myers algorithm can
    // legitimately diverge only when a line value repeats (multiple valid
    // LCS alignments). With unique lines the LCS is unique, so the two
    // implementations must agree token-for-token.
    const rng = mulberry32(99)
    let compared = 0
    for (let t = 0; t < 3000; t++) {
      const beforeLines = Array.from({ length: Math.floor(rng() * 6) }, () => randomLineText(rng, 1))
      const afterLines = Array.from({ length: Math.floor(rng() * 6) }, () => randomLineText(rng, 1))
      const hasDup = (arr: string[]) => new Set(arr).size !== arr.length
      const combined = [...beforeLines, ...afterLines]
      if (hasDup(combined)) continue // ambiguous case, covered by the count/reconstruction tests above
      compared++
      const before = beforeLines.join('\n')
      const after = afterLines.join('\n')
      expect(diffLines(before, after)).toEqual(referenceDiffLines(before, after))
    }
    expect(compared).toBeGreaterThan(0)
  })

  it('diffWords: reconstruction property holds under fuzzing', () => {
    const rng = mulberry32(777)
    for (let t = 0; t < 3000; t++) {
      const before = randomWordText(rng)
      const after = randomWordText(rng)
      const result = diffWords(before, after)
      const reconstructedBefore = result
        .filter((t2) => t2.type === 'same' || t2.type === 'remove')
        .map((t2) => t2.text)
        .join('')
      const reconstructedAfter = result
        .filter((t2) => t2.type === 'same' || t2.type === 'add')
        .map((t2) => t2.text)
        .join('')
      expect(reconstructedBefore).toBe(before)
      expect(reconstructedAfter).toBe(after)
    }
  })
})
