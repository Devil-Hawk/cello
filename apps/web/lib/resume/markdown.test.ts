import { describe, expect, it } from 'vitest'

import {
  blocksToPlainText,
  looksLikeMarkdown,
  markdownToPlainText,
  parseResumeMarkdown,
  type ResumeBlock,
  type ResumeInlineLine,
  type ResumeListBlock,
  type ResumeParagraphBlock,
} from './markdown'

function textOf(line: ResumeInlineLine): string {
  return line.map((run) => run.text).join('')
}

function firstOfType<T extends ResumeBlock['type']>(
  blocks: ResumeBlock[],
  type: T
): Extract<ResumeBlock, { type: T }> {
  const found = blocks.find((b) => b.type === type)
  if (!found) throw new Error(`no ${type} block in ${JSON.stringify(blocks)}`)
  return found as Extract<ResumeBlock, { type: T }>
}

describe('parseResumeMarkdown — inline runs', () => {
  it('turns **bold** into a bold run, not literal asterisks', () => {
    const [block] = parseResumeMarkdown('**Senior ML Engineer**')
    expect(block.type).toBe('paragraph')
    const runs = (block as ResumeParagraphBlock).lines[0]
    expect(runs).toEqual([{ text: 'Senior ML Engineer', bold: true }])
    expect(textOf(runs)).not.toContain('*')
  })

  it('carries bold, italic and bold-italic as separate runs on one line', () => {
    const blocks = parseResumeMarkdown('Plain **bold** *em* ***both*** end')
    const runs = (blocks[0] as ResumeParagraphBlock).lines[0]
    expect(runs.map((r) => [r.text, r.bold ?? false, r.italic ?? false])).toEqual([
      ['Plain ', false, false],
      ['bold', true, false],
      [' ', false, false],
      ['em', false, true],
      [' ', false, false],
      ['both', true, true],
      [' end', false, false],
    ])
  })

  it('carries inline code and links with their href', () => {
    const blocks = parseResumeMarkdown('Ships `kubectl` and see [Portfolio](https://jane.dev)')
    const runs = (blocks[0] as ResumeParagraphBlock).lines[0]
    expect(runs.find((r) => r.code)).toEqual({ text: 'kubectl', code: true })
    expect(runs.find((r) => r.href)).toEqual({ text: 'Portfolio', href: 'https://jane.dev' })
  })

  it('merges adjacent runs that share formatting', () => {
    // The dropped <b>/</b> would otherwise leave three separate plain runs.
    const blocks = parseResumeMarkdown('Before <b>bolded</b> after')
    const runs = (blocks[0] as ResumeParagraphBlock).lines[0]
    expect(runs).toEqual([{ text: 'Before bolded after' }])
  })

  it('keeps soft line breaks as separate lines in one paragraph', () => {
    const blocks = parseResumeMarkdown('Jane Doe\njane@example.com | 555-0100')
    expect(blocks).toHaveLength(1)
    const lines = (blocks[0] as ResumeParagraphBlock).lines
    expect(lines.map(textOf)).toEqual(['Jane Doe', 'jane@example.com | 555-0100'])
  })
})

describe('parseResumeMarkdown — blocks', () => {
  it('models headings 1-3 and clamps deeper ones', () => {
    const blocks = parseResumeMarkdown('# One\n\n## Two\n\n### Three\n\n#### Four')
    expect(blocks.map((b) => (b.type === 'heading' ? b.level : b.type))).toEqual([1, 2, 3, 3])
  })

  it('models a horizontal rule', () => {
    const blocks = parseResumeMarkdown('a\n\n---\n\nb')
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'rule', 'paragraph'])
  })

  it('keeps nested bullet depth', () => {
    const md = ['- Led platform team', '  - Hiring', '    - Ran 40 loops', '- Shipped v2'].join('\n')
    const list = firstOfType(parseResumeMarkdown(md), 'list')
    expect(list.items.map((i) => [i.depth, textOf(i.lines[0])])).toEqual([
      [0, 'Led platform team'],
      [1, 'Hiring'],
      [2, 'Ran 40 loops'],
      [0, 'Shipped v2'],
    ])
    expect(list.items.every((i) => i.ordered === false)).toBe(true)
  })

  it('numbers ordered items and tracks per-item orderedness for mixed nesting', () => {
    const md = ['1. First', '2. Second', '   - sub bullet', '3. Third'].join('\n')
    const list = firstOfType(parseResumeMarkdown(md), 'list') as ResumeListBlock
    expect(list.ordered).toBe(true)
    expect(list.items.map((i) => [i.depth, i.ordered, i.marker ?? null, textOf(i.lines[0])])).toEqual([
      [0, true, 1, 'First'],
      [0, true, 2, 'Second'],
      [1, false, null, 'sub bullet'],
      [0, true, 3, 'Third'],
    ])
  })

  it('respects an ordered list that does not start at 1', () => {
    const list = firstOfType(parseResumeMarkdown('5. Five\n6. Six'), 'list')
    expect(list.items.map((i) => i.marker)).toEqual([5, 6])
  })

  it('flattens a GFM table into one paragraph per row rather than rendering a grid', () => {
    const md = ['| Skill | Years |', '| --- | --- |', '| Go | 6 |'].join('\n')
    const blocks = parseResumeMarkdown(md)
    expect(blocks.every((b) => b.type === 'paragraph')).toBe(true)
    expect(blocks.map((b) => textOf((b as ResumeParagraphBlock).lines[0]))).toEqual([
      'Skill — Years',
      'Go — 6',
    ])
  })

  it('drops raw HTML instead of leaking tags', () => {
    const blocks = parseResumeMarkdown('Before <b>bolded</b> after')
    const runs = (blocks[0] as ResumeParagraphBlock).lines[0]
    expect(textOf(runs)).toBe('Before bolded after')
  })
})

describe('parseResumeMarkdown — degenerate input', () => {
  it.each([['', 'empty'], ['   ', 'spaces'], ['\n\n\t\n', 'whitespace only']])(
    'returns [] for %j (%s) instead of throwing',
    (input) => {
      expect(parseResumeMarkdown(input)).toEqual([])
    }
  )

  it('tolerates null and undefined', () => {
    expect(parseResumeMarkdown(null)).toEqual([])
    expect(parseResumeMarkdown(undefined)).toEqual([])
  })

  it('produces empty plain text for empty input', () => {
    expect(markdownToPlainText('')).toBe('')
    expect(markdownToPlainText('   \n  ')).toBe('')
    expect(blocksToPlainText([])).toBe('')
  })
})

// The fixture that matters: every markdown construct a resume might contain,
// all of which must be invisible to an applicant tracking system.
const LEAKY_FIXTURE = [
  '# Jane Doe',
  '',
  '**Senior ML Engineer** — *Seattle, WA*',
  '',
  '## Experience',
  '',
  '### Acme Corp',
  '',
  '- Shipped `kube-scheduler` patches',
  '  - Cut p99 by ***40%***',
  '- See [Portfolio](https://jane.dev)',
  '',
  '---',
  '',
  '1. First',
  '2. Second',
].join('\n')

describe('markdownToPlainText — no markdown punctuation reaches an ATS', () => {
  const out = markdownToPlainText(LEAKY_FIXTURE)

  it('leaks no emphasis markers', () => {
    expect(out).not.toMatch(/\*/)
    expect(out).not.toMatch(/`/)
  })

  it('leaks no heading hashes', () => {
    expect(out).not.toMatch(/#/)
  })

  it('leaks no link syntax and keeps the label', () => {
    expect(out).not.toMatch(/\]\(/)
    expect(out).not.toMatch(/https:\/\//)
    expect(out).toContain('See Portfolio')
  })

  it('keeps the words', () => {
    expect(out).toContain('Jane Doe')
    expect(out).toContain('Senior ML Engineer — Seattle, WA')
    expect(out).toContain('Experience')
    expect(out).toContain('Cut p99 by 40%')
  })

  it('renders bullets with a clean ASCII prefix and two-space nesting', () => {
    expect(out).toContain('- Shipped kube-scheduler patches')
    expect(out).toContain('  - Cut p99 by 40%')
    expect(out).toContain('1. First')
    expect(out).toContain('2. Second')
  })

  it('renders a horizontal rule as blank space, never a row of dashes', () => {
    expect(out).not.toMatch(/^-{2,}$/m)
  })

  it('never emits three consecutive newlines', () => {
    expect(out).not.toMatch(/\n{3}/)
  })
})

describe('plain-text resumes round-trip', () => {
  // Every resume already stored in this product looks like this.
  const PLAIN = [
    'JANE DOE',
    'jane@example.com | 555-0100 | Seattle, WA',
    '',
    'EXPERIENCE',
    '',
    'Acme Corp - Senior Engineer (2020-2024)',
    '- Built the ingest pipeline',
    '- Led a team of 6',
    '',
    'EDUCATION',
    '',
    'BS Computer Science, State University',
  ].join('\n')

  it('survives parse -> plain text unchanged', () => {
    expect(markdownToPlainText(PLAIN)).toBe(PLAIN.trim())
  })

  it('is idempotent, so re-saving a version cannot drift', () => {
    const once = markdownToPlainText(PLAIN)
    expect(markdownToPlainText(once)).toBe(once)
  })

  it('preserves the contact block as separate lines', () => {
    const blocks = parseResumeMarkdown(PLAIN)
    const lines = (blocks[0] as ResumeParagraphBlock).lines
    expect(lines.map(textOf)).toEqual([
      'JANE DOE',
      'jane@example.com | 555-0100 | Seattle, WA',
    ])
  })
})

describe('looksLikeMarkdown', () => {
  it('detects headings, bold and bullets', () => {
    expect(looksLikeMarkdown('## Experience')).toBe(true)
    expect(looksLikeMarkdown('**Senior Engineer**')).toBe(true)
    expect(looksLikeMarkdown('- Did a thing')).toBe(true)
  })

  it('does not claim undesigned plain text is markdown', () => {
    expect(looksLikeMarkdown('JANE DOE\njane@example.com')).toBe(false)
    expect(looksLikeMarkdown('')).toBe(false)
    expect(looksLikeMarkdown(null)).toBe(false)
  })
})
