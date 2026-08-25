// Line- and word-level diff helpers for the resume studio's before/after
// preview.
//
// The edit-script computation is delegated to `diff` (jsdiff), a mature,
// battle-tested LCS/Myers diff library — not reinvented here. This file only
// adapts jsdiff's `diffArrays` output into Cello's existing DiffLine shape,
// so every consumer (resume-diff.tsx, observation-view.tsx) keeps working
// unchanged.
//
// `diffArrays` (rather than jsdiff's string-oriented `diffLines`/`diffWords`)
// is used deliberately: it's given the exact same pre-split token arrays
// (`split('\n')` / `split(/(\s+)/)`) the old hand-rolled LCS used, which
// preserves the old function's exact splitting semantics (e.g. a trailing
// newline still produces a trailing empty-string "line", matching
// `'a\n'.split('\n') === ['a', '']`). jsdiff's own `diffLines` instead keeps
// the newline attached to each line's value and does not produce that
// trailing empty entry, which would have been an observable behavior change.
//
// Note: when the input has duplicate lines/words, there can be more than one
// equally-short edit script (LCS ties). jsdiff's Myers implementation may
// pick a different one of those ties than the old DP table did (e.g. which
// occurrence of a repeated line is marked "same" vs "removed"). This does
// not change any observable output: diffStats() counts are identical, and
// concatenating the same+remove entries always reconstructs `before` exactly
// while same+add entries always reconstruct `after` exactly (verified by
// fuzz testing in diff.test.ts), so the rendered before/after panes are
// byte-identical either way.

import { diffArrays } from 'diff'

export type DiffLineType = 'add' | 'remove' | 'same'

export interface DiffLine {
  type: DiffLineType
  text: string
}

/**
 * Diff `before` against `after` line by line and return the edit script as a
 * flat sequence of {type, text}. Consumers render 'same' lines on both sides
 * of a split view, 'remove' lines on the left only, and 'add' lines on the
 * right only.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = (before ?? '').split('\n')
  const b = (after ?? '').split('\n')
  const chunks = diffArrays(a, b)

  const result: DiffLine[] = []
  for (const chunk of chunks) {
    const type: DiffLineType = chunk.added ? 'add' : chunk.removed ? 'remove' : 'same'
    for (const text of chunk.value) result.push({ type, text })
  }
  return result
}

/**
 * Diff `before` against `after` word by word and return the edit script as a
 * flat sequence of {type, text}, with adjacent tokens of the same type
 * merged into one entry. Whitespace runs are kept as their own tokens (via
 * the capturing group in the split regex) so concatenating every token's
 * text in order reproduces the original string exactly — that's what makes
 * this suitable for an inline "only these words changed" highlight, as
 * opposed to diffLines()'s whole-line granularity.
 */
export function diffWords(before: string, after: string): DiffLine[] {
  const a = (before ?? '').split(/(\s+)/).filter((t) => t.length > 0)
  const b = (after ?? '').split(/(\s+)/).filter((t) => t.length > 0)
  const chunks = diffArrays(a, b)

  const tokens: DiffLine[] = []
  for (const chunk of chunks) {
    const type: DiffLineType = chunk.added ? 'add' : chunk.removed ? 'remove' : 'same'
    for (const text of chunk.value) tokens.push({ type, text })
  }

  // Merge adjacent same-type tokens into one entry. Whitespace tokens are
  // already separate elements in the token stream, so '' is the correct join.
  const merged: DiffLine[] = []
  for (const tok of tokens) {
    const last = merged[merged.length - 1]
    if (last && last.type === tok.type) {
      last.text += tok.text
    } else {
      merged.push({ type: tok.type, text: tok.text })
    }
  }
  return merged
}

/** Row shape for a side-by-side (split) diff render — one row per line pair. */
export interface DiffSplitRow {
  left: string | null
  right: string | null
  type: DiffLineType
}

/**
 * Reshape a flat diffLines() script into rows for a two-column view: 'same'
 * lines occupy both columns, 'remove' lines occupy the left column only, and
 * 'add' lines occupy the right column only (the opposite column renders a
 * blank placeholder for that row).
 */
export function toSplitRows(lines: DiffLine[]): DiffSplitRow[] {
  return lines.map((line) => {
    if (line.type === 'same') return { left: line.text, right: line.text, type: line.type }
    if (line.type === 'remove') return { left: line.text, right: null, type: line.type }
    return { left: null, right: line.text, type: line.type }
  })
}

/** Quick add/remove line counts — handy for a compact "+N -M" summary chip. */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.type === 'add') added++
    else if (line.type === 'remove') removed++
  }
  return { added, removed }
}
