// Selection-aware Markdown edits for the resume toolbar.
//
// WHY THIS IS A SEPARATE, PURE MODULE
//   Every function here is (value, selection) -> (value, selection). No DOM, no
//   React, no textarea. That makes the fiddly part — "what does Bold do to THIS
//   selection?" — unit-testable without jsdom (which this repo has no test
//   environment for; see vitest.config.ts), and it lets the toolbar's
//   `aria-pressed` be derived from the SAME predicates the commands use.
//
//   That last point is the reason `activeMarks()` lives here rather than being
//   guessed in the component: a toggle button whose pressed state disagreed
//   with what pressing it does is worse than no pressed state at all. Every
//   `active*` predicate below answers exactly one question — "would running
//   this command REMOVE formatting rather than add it?" — so the button's
//   aria-pressed always predicts the next click. markdown-commands.test.ts
//   asserts that round-trip property directly.
//
// NO LOOKBEHIND ANYWHERE
//   `(?<=...)` is ES2018 and throws a *parse-time* SyntaxError on Safari < 16.4,
//   which would take down the whole page bundle rather than degrade one button.
//   All the scanning here is done with plain regexes and index arithmetic.

/** A textarea selection. `start === end` means a collapsed caret. */
export interface TextSelection {
  start: number
  end: number
}

/** The result of a command: the new text and where the caret/selection lands. */
export interface TextEdit {
  value: string
  selection: TextSelection
}

/** The inline marks a resume actually needs. Not a general rich-text model. */
export type InlineMark = 'bold' | 'italic'

const MARKERS: Record<InlineMark, string> = { bold: '**', italic: '*' }

/** Heading levels the block model renders (lib/resume/markdown.ts clamps 4-6 to 3). */
export type ToolbarHeadingLevel = 1 | 2 | 3

const HEADING_RE = /^(#{1,6})[ \t]+/
const BULLET_RE = /^[-*+][ \t]+/
const ORDERED_RE = /^\d+[.)][ \t]+/

// --- small helpers ---------------------------------------------------------

function normalize(sel: TextSelection): TextSelection {
  return { start: Math.min(sel.start, sel.end), end: Math.max(sel.start, sel.end) }
}

function lineStartAt(value: string, index: number): number {
  if (index <= 0) return 0
  const nl = value.lastIndexOf('\n', index - 1)
  return nl === -1 ? 0 : nl + 1
}

function lineEndAt(value: string, index: number): number {
  const nl = value.indexOf('\n', index)
  return nl === -1 ? value.length : nl
}

/** Leading whitespace (the nesting indent) and the line's content after any block marker. */
function splitLine(line: string): { indent: string; text: string } {
  const indent = /^[ \t]*/.exec(line)?.[0] ?? ''
  const rest = line.slice(indent.length)
  const text = rest.replace(HEADING_RE, '').replace(BULLET_RE, '').replace(ORDERED_RE, '')
  return { indent, text }
}

function isBlank(line: string): boolean {
  return line.trim().length === 0
}

/**
 * The lines a line-level command operates on: every line the selection touches,
 * expanded to whole lines. Returned with the offsets so the edit can be spliced
 * back in and the selection re-expressed against the new text.
 */
function selectedLines(
  value: string,
  sel: TextSelection
): { blockStart: number; blockEnd: number; lines: string[] } {
  const { start, end } = normalize(sel)
  const blockStart = lineStartAt(value, start)
  const blockEnd = lineEndAt(value, end)
  return { blockStart, blockEnd, lines: value.slice(blockStart, blockEnd).split('\n') }
}

/**
 * Apply a per-line transform to the selected lines and re-select the result.
 * Blank lines inside a multi-line selection are left alone (prefixing them
 * would emit `- ` bullets with nothing in them), unless EVERY selected line is
 * blank — the "caret on an empty line, start a list" case.
 */
function mapSelectedLines(
  value: string,
  sel: TextSelection,
  transform: (line: string, ordinalIndex: number) => string
): TextEdit {
  const { blockStart, blockEnd, lines } = selectedLines(value, sel)
  const anyContent = lines.some((line) => !isBlank(line))
  let ordinal = 0
  const next = lines.map((line) => {
    if (anyContent && isBlank(line)) return line
    const out = transform(line, ordinal)
    ordinal += 1
    return out
  })
  const replacement = next.join('\n')
  return {
    value: value.slice(0, blockStart) + replacement + value.slice(blockEnd),
    selection: { start: blockStart, end: blockStart + replacement.length },
  }
}

/** The lines a predicate should look at: the non-blank ones, or all of them if none has content. */
function meaningfulLines(lines: string[]): string[] {
  const withContent = lines.filter((line) => !isBlank(line))
  return withContent.length > 0 ? withContent : lines
}

// --- inline marks ----------------------------------------------------------

/**
 * True when the selected text itself carries the markers ("**bold**" selected).
 * For italic, `**bold**` must NOT count — otherwise italicising a bold run
 * would silently strip one star from each side and demote it.
 */
function markersInside(inner: string, mark: InlineMark): boolean {
  const marker = MARKERS[mark]
  if (inner.length <= marker.length * 2) return false
  if (!inner.startsWith(marker) || !inner.endsWith(marker)) return false
  if (mark === 'italic' && (inner.startsWith('**') || inner.endsWith('**'))) return false
  return true
}

/** True when the markers sit just outside the selection ("bold" selected inside **bold**). */
function markersOutside(value: string, start: number, end: number, mark: InlineMark): boolean {
  const marker = MARKERS[mark]
  if (start - marker.length < 0 || end + marker.length > value.length) return false
  if (value.slice(start - marker.length, start) !== marker) return false
  if (value.slice(end, end + marker.length) !== marker) return false
  if (mark === 'italic' && (value.slice(start - 2, start) === '**' || value.slice(end, end + 2) === '**')) {
    return false
  }
  return true
}

/** Trim whitespace off the ends of a selection — `**bold **` is not emphasis in CommonMark. */
function tightenSelection(value: string, sel: TextSelection): TextSelection {
  const { start, end } = normalize(sel)
  let s = start
  let e = end
  while (s < e && /\s/.test(value[s])) s += 1
  while (e > s && /\s/.test(value[e - 1])) e -= 1
  return { start: s, end: e }
}

/** True when running `toggleInline` for this mark would REMOVE formatting. */
export function activeInline(value: string, sel: TextSelection, mark: InlineMark): boolean {
  const { start, end } = tightenSelection(value, sel)
  if (start === end) return false
  return markersInside(value.slice(start, end), mark) || markersOutside(value, start, end, mark)
}

/**
 * Bold / italic on the current selection.
 *   - collapsed caret -> insert an empty pair and put the caret between them
 *   - already marked   -> unwrap (whether the markers are inside or outside the selection)
 *   - otherwise        -> wrap, leaving any selected edge whitespace outside the markers
 * The returned selection always covers the words, never the markers, so a
 * second press round-trips back to the original text.
 */
export function toggleInline(value: string, sel: TextSelection, mark: InlineMark): TextEdit {
  const marker = MARKERS[mark]
  const raw = normalize(sel)
  const { start, end } = tightenSelection(value, sel)

  if (start === end) {
    const caret = raw.start + marker.length
    return {
      value: value.slice(0, raw.start) + marker + marker + value.slice(raw.end),
      selection: { start: caret, end: caret },
    }
  }

  const inner = value.slice(start, end)

  if (markersInside(inner, mark)) {
    const stripped = inner.slice(marker.length, inner.length - marker.length)
    return {
      value: value.slice(0, start) + stripped + value.slice(end),
      selection: { start, end: start + stripped.length },
    }
  }

  if (markersOutside(value, start, end, mark)) {
    return {
      value: value.slice(0, start - marker.length) + inner + value.slice(end + marker.length),
      selection: { start: start - marker.length, end: start - marker.length + inner.length },
    }
  }

  return {
    value: value.slice(0, start) + marker + inner + marker + value.slice(end),
    selection: { start: start + marker.length, end: end + marker.length },
  }
}

// --- headings --------------------------------------------------------------

/** True when running `toggleHeading` at this level would REMOVE the heading. */
export function activeHeading(value: string, sel: TextSelection, level: ToolbarHeadingLevel): boolean {
  const { lines } = selectedLines(value, sel)
  return meaningfulLines(lines).every((line) => {
    const match = HEADING_RE.exec(line.trimStart())
    return match?.[1].length === level
  })
}

/**
 * Set (or clear) the heading level of every line the selection touches.
 * Pressing H2 on a line that is already `## ` removes it — that is the toggle
 * `activeHeading` promises. Any existing heading or list marker on the line is
 * replaced, so H2 on a bullet turns it into a section instead of `## - text`.
 */
export function toggleHeading(value: string, sel: TextSelection, level: ToolbarHeadingLevel): TextEdit {
  const remove = activeHeading(value, sel, level)
  const hashes = '#'.repeat(level)
  return mapSelectedLines(value, sel, (line) => {
    const { indent, text } = splitLine(line)
    return remove ? indent + text : `${indent}${hashes} ${text}`
  })
}

// --- lists -----------------------------------------------------------------

/** True when running `toggleBulletList` would REMOVE the bullets. */
export function activeBulletList(value: string, sel: TextSelection): boolean {
  const { lines } = selectedLines(value, sel)
  return meaningfulLines(lines).every((line) => BULLET_RE.test(line.trimStart()))
}

/** True when running `toggleOrderedList` would REMOVE the numbering. */
export function activeOrderedList(value: string, sel: TextSelection): boolean {
  const { lines } = selectedLines(value, sel)
  return meaningfulLines(lines).every((line) => ORDERED_RE.test(line.trimStart()))
}

/** Turn the selected lines into `- ` bullets, or strip the bullets if they all already are. */
export function toggleBulletList(value: string, sel: TextSelection): TextEdit {
  const remove = activeBulletList(value, sel)
  return mapSelectedLines(value, sel, (line) => {
    const { indent, text } = splitLine(line)
    return remove ? indent + text : `${indent}- ${text}`
  })
}

/**
 * Turn the selected lines into `1. `, `2. `… or strip the numbering.
 * Numbering restarts at 1 for the selection and counts only lines that get a
 * marker, so a blank line in the middle does not burn an ordinal.
 */
export function toggleOrderedList(value: string, sel: TextSelection): TextEdit {
  const remove = activeOrderedList(value, sel)
  return mapSelectedLines(value, sel, (line, index) => {
    const { indent, text } = splitLine(line)
    return remove ? indent + text : `${indent}${index + 1}. ${text}`
  })
}

// --- links -----------------------------------------------------------------

/** The href a fresh link starts with — selected so the user types straight over it. */
export const LINK_PLACEHOLDER_URL = 'https://'
const LINK_PLACEHOLDER_LABEL = 'link text'

/**
 * Wrap the selection in a Markdown link.
 *   - with a selection: the selected words become the LABEL and the caret lands
 *     on the URL, because the label is the part the user already wrote.
 *   - without one: insert `[link text](https://)` and select the label.
 * (lib/resume/markdown.ts keeps only the LABEL in the ATS plain text, so the
 * label is the load-bearing half either way.)
 */
export function insertLink(value: string, sel: TextSelection): TextEdit {
  const { start, end } = tightenSelection(value, sel)
  const raw = normalize(sel)

  if (start === end) {
    const snippet = `[${LINK_PLACEHOLDER_LABEL}](${LINK_PLACEHOLDER_URL})`
    return {
      value: value.slice(0, raw.start) + snippet + value.slice(raw.end),
      selection: { start: raw.start + 1, end: raw.start + 1 + LINK_PLACEHOLDER_LABEL.length },
    }
  }

  const label = value.slice(start, end)
  const snippet = `[${label}](${LINK_PLACEHOLDER_URL})`
  const urlStart = start + label.length + 3 // '[' + label + ']('
  return {
    value: value.slice(0, start) + snippet + value.slice(end),
    selection: { start: urlStart, end: urlStart + LINK_PLACEHOLDER_URL.length },
  }
}

// --- toolbar state ---------------------------------------------------------

/**
 * Everything the toolbar needs for `aria-pressed`, derived from the same
 * predicates the commands run. `heading` is the level that would be REMOVED by
 * pressing its button — i.e. the level the selection is already at.
 */
export interface ActiveMarks {
  bold: boolean
  italic: boolean
  heading: ToolbarHeadingLevel | null
  bulletList: boolean
  orderedList: boolean
}

export function activeMarks(value: string, sel: TextSelection): ActiveMarks {
  const heading = ([1, 2, 3] as const).find((level) => activeHeading(value, sel, level)) ?? null
  return {
    bold: activeInline(value, sel, 'bold'),
    italic: activeInline(value, sel, 'italic'),
    heading,
    bulletList: activeBulletList(value, sel),
    orderedList: activeOrderedList(value, sel),
  }
}
