// Unit tests for the resume toolbar's selection edits.
//
// These run without a DOM on purpose: vitest.config.ts configures no jsdom
// environment (see components/copilot/observation-view.test.tsx's header), and
// the interesting behaviour here is pure string/offset arithmetic anyway.
//
// The property that matters most is the last describe block: `aria-pressed` on
// every toolbar toggle is rendered from `activeMarks()`, so if a predicate ever
// disagreed with its command, the button would claim "on" and then turn the
// formatting on AGAIN. Those tests assert the two can't drift.

import { describe, expect, it } from 'vitest'
import {
  activeBulletList,
  activeHeading,
  activeInline,
  activeMarks,
  activeOrderedList,
  insertLink,
  LINK_PLACEHOLDER_URL,
  toggleBulletList,
  toggleHeading,
  toggleInline,
  toggleOrderedList,
  type TextSelection,
} from './markdown-commands'

/** Build a selection from a `|`-delimited fixture: 'a |bc| d' selects 'bc'. */
function fixture(marked: string): { value: string; selection: TextSelection } {
  const start = marked.indexOf('|')
  const end = marked.indexOf('|', start + 1)
  if (start === -1) throw new Error('fixture needs at least one |')
  if (end === -1) {
    const value = marked.replace('|', '')
    return { value, selection: { start, end: start } }
  }
  const value = marked.slice(0, start) + marked.slice(start + 1, end) + marked.slice(end + 1)
  return { value, selection: { start, end: end - 1 } }
}

/** Re-mark the result so assertions read like the fixtures. */
function show(edit: { value: string; selection: TextSelection }): string {
  const { value, selection } = edit
  if (selection.start === selection.end) return value.slice(0, selection.start) + '|' + value.slice(selection.start)
  return (
    value.slice(0, selection.start) +
    '|' +
    value.slice(selection.start, selection.end) +
    '|' +
    value.slice(selection.end)
  )
}

describe('toggleInline — bold/italic', () => {
  it('wraps the selection and keeps the words (not the markers) selected', () => {
    const { value, selection } = fixture('Led |migration| of billing')
    expect(show(toggleInline(value, selection, 'bold'))).toBe('Led **|migration|** of billing')
  })

  it('unwraps when the markers are inside the selection', () => {
    const { value, selection } = fixture('Led |**migration**| of billing')
    expect(show(toggleInline(value, selection, 'bold'))).toBe('Led |migration| of billing')
  })

  it('unwraps when the markers sit just outside the selection', () => {
    const { value, selection } = fixture('Led **|migration|** of billing')
    expect(show(toggleInline(value, selection, 'bold'))).toBe('Led |migration| of billing')
  })

  it('leaves trailing spaces outside the markers — `**bold **` is not emphasis in CommonMark', () => {
    // The selection here is "migration " — trailing space and all, the usual
    // result of a double-click drag.
    const { value, selection } = fixture('Led |migration |of billing')
    expect(value.slice(selection.start, selection.end)).toBe('migration ')
    expect(toggleInline(value, selection, 'bold').value).toBe('Led **migration** of billing')
  })

  it('inserts an empty pair with the caret between them when nothing is selected', () => {
    const { value, selection } = fixture('Led |of billing')
    expect(show(toggleInline(value, selection, 'bold'))).toBe('Led **|**of billing')
  })

  it('does not demote bold to italic when italicising an already-bold run', () => {
    const { value, selection } = fixture('Led |**migration**| of billing')
    // The bold markers must survive: italic wraps them rather than eating one star per side.
    expect(toggleInline(value, selection, 'italic').value).toBe('Led ***migration*** of billing')
  })

  it('round-trips: wrapping then unwrapping restores the original text and selection', () => {
    const { value, selection } = fixture('Led |migration| of billing')
    const on = toggleInline(value, selection, 'italic')
    const off = toggleInline(on.value, on.selection, 'italic')
    expect(off.value).toBe(value)
    expect(off.selection).toEqual(selection)
  })
})

describe('toggleHeading', () => {
  it('prefixes the touched line and re-selects it', () => {
    const { value, selection } = fixture('Experi|ence\nAcme Corp')
    expect(show(toggleHeading(value, selection, 2))).toBe('|## Experience|\nAcme Corp')
  })

  it('removes the heading when every selected line is already at that level', () => {
    const { value, selection } = fixture('## Experi|ence')
    expect(toggleHeading(value, selection, 2).value).toBe('Experience')
  })

  it('re-levels rather than stacking hashes', () => {
    const { value, selection } = fixture('### Acme |Corp')
    expect(toggleHeading(value, selection, 2).value).toBe('## Acme Corp')
  })

  it('replaces a bullet marker instead of producing `## - text`', () => {
    const { value, selection } = fixture('- Acme |Corp')
    expect(toggleHeading(value, selection, 3).value).toBe('### Acme Corp')
  })

  it('applies to every line a multi-line selection touches, skipping blank lines', () => {
    const { value, selection } = fixture('|Skills\n\nEducation|')
    expect(toggleHeading(value, selection, 2).value).toBe('## Skills\n\n## Education')
  })
})

describe('toggleBulletList / toggleOrderedList', () => {
  it('bullets every selected line', () => {
    const { value, selection } = fixture('|Shipped X\nShipped Y|')
    expect(toggleBulletList(value, selection).value).toBe('- Shipped X\n- Shipped Y')
  })

  it('removes bullets when every selected line already has one', () => {
    const { value, selection } = fixture('|- Shipped X\n- Shipped Y|')
    expect(toggleBulletList(value, selection).value).toBe('Shipped X\nShipped Y')
  })

  it('numbers from 1 and does not burn an ordinal on a blank line', () => {
    const { value, selection } = fixture('|Shipped X\n\nShipped Y|')
    expect(toggleOrderedList(value, selection).value).toBe('1. Shipped X\n\n2. Shipped Y')
  })

  it('converts bullets to numbers in place', () => {
    const { value, selection } = fixture('|- Shipped X\n- Shipped Y|')
    expect(toggleOrderedList(value, selection).value).toBe('1. Shipped X\n2. Shipped Y')
  })

  it('preserves the nesting indent', () => {
    const { value, selection } = fixture('  |Nested detail|')
    expect(toggleBulletList(value, selection).value).toBe('  - Nested detail')
  })

  it('starts a list from a caret on an empty line', () => {
    const { value, selection } = fixture('|')
    expect(toggleBulletList(value, selection).value).toBe('- ')
  })
})

describe('insertLink', () => {
  it('keeps the selected words as the label and selects the URL to type over', () => {
    const { value, selection } = fixture('See my |portfolio| for more')
    const edit = insertLink(value, selection)
    expect(edit.value).toBe(`See my [portfolio](${LINK_PLACEHOLDER_URL}) for more`)
    expect(edit.value.slice(edit.selection.start, edit.selection.end)).toBe(LINK_PLACEHOLDER_URL)
  })

  it('inserts a placeholder label and selects it when nothing is selected', () => {
    const { value, selection } = fixture('See |')
    const edit = insertLink(value, selection)
    expect(edit.value).toBe(`See [link text](${LINK_PLACEHOLDER_URL})`)
    expect(edit.value.slice(edit.selection.start, edit.selection.end)).toBe('link text')
  })
})

describe('activeMarks — the toolbar’s aria-pressed always predicts the next click', () => {
  const cases: Array<{ name: string; marked: string }> = [
    { name: 'plain words', marked: 'Led |migration| of billing' },
    { name: 'bold, markers inside the selection', marked: 'Led |**migration**| of billing' },
    { name: 'bold, markers outside the selection', marked: 'Led **|migration|** of billing' },
    { name: 'italic', marked: 'Led *|migration|* of billing' },
    { name: 'an h2 line', marked: '## Experi|ence' },
    { name: 'a bullet line', marked: '- Shipped |X' },
    { name: 'a numbered line', marked: '1. Shipped |X' },
    { name: 'a multi-line bullet selection', marked: '|- one\n- two|' },
  ]

  // The invariant: running a command flips its own predicate. A button that
  // reads "pressed" must turn the formatting OFF, and one that reads
  // "not pressed" must turn it ON — measured by re-running the predicate on
  // the result, not by guessing from the text length (re-levelling `## x` to
  // `- x` legitimately shortens the line while switching formatting on).
  for (const { name, marked } of cases) {
    it(`bold on ${name}: pressing flips the predicate`, () => {
      const { value, selection } = fixture(marked)
      if (selection.start === selection.end) return // collapsed caret: inserts an empty pair, nothing to unwrap yet
      const before = activeInline(value, selection, 'bold')
      const after = toggleInline(value, selection, 'bold')
      expect(activeInline(after.value, after.selection, 'bold')).toBe(!before)
    })

    it(`bullets on ${name}: pressing flips the predicate`, () => {
      const { value, selection } = fixture(marked)
      const before = activeBulletList(value, selection)
      const after = toggleBulletList(value, selection)
      expect(activeBulletList(after.value, after.selection)).toBe(!before)
    })

    it(`numbering on ${name}: pressing flips the predicate`, () => {
      const { value, selection } = fixture(marked)
      const before = activeOrderedList(value, selection)
      const after = toggleOrderedList(value, selection)
      expect(activeOrderedList(after.value, after.selection)).toBe(!before)
    })

    it(`heading on ${name}: the reported level is the one that toggles off`, () => {
      const { value, selection } = fixture(marked)
      const level = activeMarks(value, selection).heading
      if (level === null) return
      const after = toggleHeading(value, selection, level)
      expect(activeHeading(after.value, after.selection, level)).toBe(false)
    })
  }

  it('reports the exact heading level, not just "is a heading"', () => {
    const { value, selection } = fixture('### Acme |Corp')
    expect(activeMarks(value, selection).heading).toBe(3)
  })

  it('reports nothing on an empty document', () => {
    expect(activeMarks('', { start: 0, end: 0 })).toEqual({
      bold: false,
      italic: false,
      heading: null,
      bulletList: false,
      orderedList: false,
    })
  })
})
