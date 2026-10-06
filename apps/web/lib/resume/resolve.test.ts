import { describe, expect, it } from 'vitest'
import { getDocumentProxy } from 'unpdf'
import { renderResumeVersionDocx } from './docx'
import { docxToMarkdown } from './import/docx'
import { renderResumeVersionPdf } from './pdf'
import { deriveResumeColumns } from './store'
import { resolveResume, resolveResumeMarkdown } from './resolve'
import { CANONICAL_RESUME, LEGACY_TAILORED_TEXT } from './test-fixtures'

/** A tailored row written by the old optimizer: plain text, content_json null. */
const legacyRow = { content: LEGACY_TAILORED_TEXT, content_json: null, title: 'Tailored' }

describe('resolveResume', () => {
  it('returns the stored resume when there is one', () => {
    const row = { content: 'ignored', content_json: deriveResumeColumns(CANONICAL_RESUME).content_json }
    expect(resolveResume(row)).toEqual(CANONICAL_RESUME)
  })

  it('converts a legacy plain-text row and marks it legacy', () => {
    const r = resolveResume(legacyRow)
    expect(r.meta.cello.parsedFrom).toBe('legacy')
    expect(r.work.map((w) => w.name)).toEqual(['Northwind Analytics', 'Contoso Health'])
    expect(r.work[0]).toMatchObject({ startDate: '2021-03', current: true, location: 'Seattle, WA' })
  })

  it('infers structure from a legacy markdown cache that is really plain text', () => {
    const r = resolveResume({
      content: LEGACY_TAILORED_TEXT,
      content_json: { markdown: LEGACY_TAILORED_TEXT, templateId: 'classic' },
    })
    expect(r.work).toHaveLength(2)
    expect(r.meta.cello.templateId).toBe('classic')
  })

  it('gives every row sections and entries at fixed levels', () => {
    const md = resolveResumeMarkdown(legacyRow)
    expect(md).toMatch(/^# Jordan Rivera$/m)
    expect(md).toMatch(/^## Experience$/m)
    expect(md).toMatch(/^### Senior Software Engineer, Northwind Analytics$/m)
    expect(md).toMatch(/^## Skills$/m)
  })
})

describe('legacy rows export structured', () => {
  it('DOCX uses Heading 2 for sections and Heading 3 for entries', async () => {
    const bytes = await renderResumeVersionDocx(legacyRow)
    const { markdown } = await docxToMarkdown(Buffer.from(bytes))
    // The template upper-cases section titles; the heading levels are what matter.
    expect(markdown).toMatch(/^## Experience$/im)
    expect(markdown).toMatch(/^### Senior Software Engineer, Northwind Analytics$/m)
  })

  it('PDF puts each section title on its own line', async () => {
    const bytes = await renderResumeVersionPdf(legacyRow)
    const pdf = await getDocumentProxy(new Uint8Array(bytes))
    const content = await (await pdf.getPage(1)).getTextContent()
    const items = content.items as Array<{ str: string; fontName: string }>
    const body = items.find((i) => i.str.includes('Led a team'))!
    for (const title of ['summary', 'experience', 'education', 'skills']) {
      const item = items.find((i) => i.str.trim().toLowerCase() === title)
      // its own text run, set in the heading font rather than the body font
      expect(item, title).toBeDefined()
      expect(item!.fontName, title).not.toBe(body.fontName)
    }
  })
})
