// .docx -> Markdown. This is the format that carries REAL structure, so the
// assertions here are about structure surviving, not about structure being
// guessed: a Heading 1 must arrive as an h1, a bold run as `**bold**`, and a
// level-2 list item as a nested bullet.
//
// THE FIXTURE
//   DOCX_FIXTURE_BASE64 below is a real (tiny) .docx, built as a zip of
//   [Content_Types].xml, _rels/.rels, word/document.xml and word/numbering.xml.
//   It is checked in as base64 rather than as a binary file so the test has no
//   fixture-loading path to get wrong, and so what the document CONTAINS is
//   readable in the diff: name (Heading1), contact line, "Experience"
//   (Heading2), a bold role line, a bullet with a nested sub-bullet, "Skills"
//   (Heading2) and a skills line.

import { describe, expect, it } from 'vitest'
import { docxToMarkdown, promoteUnstyledHeadings } from './docx'
import { importResumeFile } from './index'
import { markdownToPlainText, parseResumeMarkdown } from '../markdown'

const DOCX_FIXTURE_BASE64 =
  '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'

const fixture = () => Buffer.from(DOCX_FIXTURE_BASE64, 'base64')

describe('docxToMarkdown', () => {
  it('turns Word heading styles into Markdown headings', async () => {
    const { markdown } = await docxToMarkdown(fixture())
    expect(markdown).toContain('# Ada Lovelace')
    expect(markdown).toContain('## Experience')
    expect(markdown).toContain('## Skills')
  })

  it('keeps a bold role line bold', async () => {
    const { markdown } = await docxToMarkdown(fixture())
    expect(markdown).toContain('**Analytical Engine Programmer, Babbage Ltd (1842 - 1843)**')
  })

  it('keeps Word list levels as nested bullets', async () => {
    const { markdown } = await docxToMarkdown(fixture())
    const list = parseResumeMarkdown(markdown).find((b) => b.type === 'list')
    expect(list?.type).toBe('list')
    if (list?.type !== 'list') throw new Error('no list block')
    expect(list.items.map((i) => i.depth)).toEqual([0, 1])
    expect(list.items[1].lines[0][0].text).toContain('Bernoulli')
  })

  it('renders the block model the templates consume', async () => {
    const { markdown } = await docxToMarkdown(fixture())
    const blocks = parseResumeMarkdown(markdown)
    const headings = blocks.filter((b) => b.type === 'heading')
    expect(headings.map((h) => (h.type === 'heading' ? h.level : 0))).toEqual([1, 2, 2])
    // The bold role line survives as a run flag, never as literal asterisks.
    expect(markdownToPlainText(markdown)).not.toContain('**')
    expect(markdownToPlainText(markdown)).toContain('Analytical Engine Programmer')
  })

  it('rejects a file that is not a readable .docx instead of storing an empty resume', async () => {
    await expect(docxToMarkdown(Buffer.from('this is not a zip at all'))).rejects.toMatchObject({
      code: 'docx_unreadable',
    })
  })
})

describe('importResumeFile (.docx)', () => {
  it('imports the fixture end to end and derives the plain text from the Markdown', async () => {
    const result = await importResumeFile({ filename: 'ada.docx', bytes: fixture() })
    expect(result.format).toBe('docx')
    expect(result.structurePreserved).toBe(true)
    expect(result.method).toBe('Word formatting preserved')
    expect(result.plainText).toBe(markdownToPlainText(result.markdown))
    expect(result.plainText).toContain('Ada Lovelace')
    expect(result.warnings).toEqual([])
  })

  it('recognises a .docx by MIME type when the filename has no extension', async () => {
    const result = await importResumeFile({
      filename: 'resume',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: fixture(),
    })
    expect(result.format).toBe('docx')
  })
})

describe('promoteUnstyledHeadings', () => {
  // Plenty of Word resumes use no styles at all — the section names are just
  // bold text. Promoting those uses the document's own words and its own
  // emphasis; it is not the .txt inference in disguise.
  it('promotes a bold section name and a leading name when the file declared no headings', () => {
    const out = promoteUnstyledHeadings('**Ada Lovelace**\n\n**EXPERIENCE**\n\n- Wrote it.')
    expect(out).toContain('# Ada Lovelace')
    expect(out).toContain('## EXPERIENCE')
  })

  it('leaves a document that declared its own headings completely alone', () => {
    const source = '# Ada Lovelace\n\n**EXPERIENCE**\n\n- Wrote it.'
    expect(promoteUnstyledHeadings(source)).toBe(source)
  })

  it('does not promote bold text that is not a section name', () => {
    const out = promoteUnstyledHeadings('**Ada Lovelace**\n\n**Analytical Engine Programmer**')
    expect(out).toContain('# Ada Lovelace')
    expect(out).toContain('**Analytical Engine Programmer**')
  })
})
