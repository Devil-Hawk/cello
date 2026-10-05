import { describe, expect, it } from 'vitest'
import { markdownToPlainText, parseResumeMarkdown } from './markdown'
import { formatDates, resumeFactText, resumeToMarkdown, resumeToPlainText } from './render'
import { ResumeSchema, type Resume } from './schema'
import { CANONICAL_RESUME } from './test-fixtures'

function withWork(over: Partial<Resume['work'][number]>): Resume {
  return ResumeSchema.parse({
    basics: { name: 'Ada Lovelace' },
    work: [{ name: 'Acme', position: 'Engineer', highlights: [], ...over }],
  })
}

describe('resumeToMarkdown', () => {
  const md = resumeToMarkdown(CANONICAL_RESUME)

  it('has fixed levels: one #, sections ##, entries ###', () => {
    const headings = parseResumeMarkdown(md).filter((b) => b.type === 'heading')
    const levels = headings.map((h) => (h.type === 'heading' ? h.level : 0))
    expect(levels.filter((l) => l === 1)).toHaveLength(1)
    expect(md).toMatch(/^# Jordan Rivera$/m)
    expect(md).toMatch(/^## Experience$/m)
    expect(md).toMatch(/^### Senior Software Engineer, Northwind Analytics$/m)
    expect(md).toMatch(/^## Education$/m)
  })

  it('never writes an em dash', () => {
    expect(md).not.toContain('—')
  })

  it('omits empty sections and respects sectionOrder', () => {
    expect(md).not.toMatch(/## Projects/)
    const ordered = ResumeSchema.parse({
      ...CANONICAL_RESUME,
      meta: { cello: { sectionOrder: ['skills', 'education', 'work'] } },
    })
    const out = resumeToMarkdown(ordered)
    expect(out.indexOf('## Skills')).toBeLessThan(out.indexOf('## Education'))
    expect(out.indexOf('## Education')).toBeLessThan(out.indexOf('## Experience'))
  })

  it('prints a lone start date alone, with no Present', () => {
    expect(formatDates({ startDate: '2019' })).toBe('2019')
    expect(resumeToMarkdown(withWork({ startDate: '2019' }))).not.toMatch(/Present/)
  })

  it('prints Present only when current is set', () => {
    expect(formatDates({ startDate: '2021-03', current: true })).toBe('Mar 2021 - Present')
    expect(formatDates({ startDate: '2021-03', endDate: '2023-06' })).toBe('Mar 2021 - Jun 2023')
    expect(formatDates({ startDate: '2021-03' })).toBe('Mar 2021')
  })

  it('prints an education end date alone and a dateLabel verbatim', () => {
    expect(md).toMatch(/^\*2016\*$/m)
    expect(formatDates({ dateLabel: 'Summer 2019', startDate: '2019' })).toBe('Summer 2019')
  })

  it.each(['# x', '- x', '+ x', '---', '***', '1. x', '| a | b |', '> q'])(
    'keeps the highlight %j literal inside its bullet',
    (highlight) => {
      const blocks = parseResumeMarkdown(resumeToMarkdown(withWork({ highlights: [highlight, 'next'] })))
      const list = blocks.find((b) => b.type === 'list')
      expect(list?.type).toBe('list')
      if (list?.type !== 'list') return
      expect(list.items.map((i) => i.lines[0][0].text)).toEqual([highlight, 'next'])
      expect(list.items.every((i) => i.depth === 0)).toBe(true)
      // nothing else leaked out as a heading, rule or table-row paragraph
      expect(blocks.filter((b) => b.type === 'rule')).toHaveLength(0)
    }
  )

  it('keeps a setext-looking paragraph in the summary as text', () => {
    const r = ResumeSchema.parse({ basics: { name: 'Ada', summary: 'First line\n\n===\n\n---' } })
    const blocks = parseResumeMarkdown(resumeToMarkdown(r))
    expect(blocks.filter((b) => b.type === 'heading')).toHaveLength(2) // name + Summary only
    expect(markdownToPlainText(resumeToMarkdown(r))).toContain('First line\n\n===\n\n---')
  })
})

describe('skills', () => {
  it('keeps each group on its own line, even where soft breaks fold into spaces', () => {
    const md = resumeToMarkdown(CANONICAL_RESUME)
    const para = parseResumeMarkdown(md).find(
      (b) => b.type === 'paragraph' && b.lines[0]?.[0]?.text.startsWith('Languages')
    )
    expect(para?.type === 'paragraph' && para.lines).toHaveLength(2)
    expect(md).toContain('**Languages:** Go, TypeScript, SQL  \n**Platforms:**')
  })
})

describe('plain text and fact text', () => {
  it('plain text is the Markdown without markup', () => {
    const text = resumeToPlainText(CANONICAL_RESUME)
    expect(text).toContain('Senior Software Engineer, Northwind Analytics')
    expect(text).toContain('Seattle, WA | Mar 2021 - Present')
    expect(text).toContain('- Led a team of 6 engineers.')
    expect(text).not.toMatch(/[#*]/)
  })

  it('fact text holds authored strings only: no Present, no section titles, no normalised dates', () => {
    const facts = resumeFactText(CANONICAL_RESUME)
    expect(facts).toContain('Northwind Analytics')
    expect(facts).not.toMatch(/Present|Experience|Education|2021-03/)
  })
})
