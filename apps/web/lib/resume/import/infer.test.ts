// The no-LLM path. Everything here runs with zero API keys configured, because
// that is the configuration these rules exist for: a user with no key must
// still get headings and bullets, just a less good guess at them.

import { describe, expect, it } from 'vitest'
import { inferResumeMarkdown, isKnownSectionTitle, isLikelyName, escapeInlineMarkdown } from './infer'
import { checkReformatFaithfulness } from './llm'
import { markdownToPlainText, parseResumeMarkdown } from '../markdown'

const PLAIN_RESUME = `Jane Q. Doe
jane.doe@example.com | 555-0100 | Seattle, WA

PROFESSIONAL SUMMARY

Backend engineer with eight years building payment systems.

EXPERIENCE

Senior Engineer, Northwind Payments
Mar 2019 - Present
• Led the migration of the ledger service to Postgres.
• Cut settlement latency from 900ms to 120ms.
    - Rewrote the batch reconciler.

Engineer, Contoso
2015 - 2019
* Built the refunds API.

Page 2 of 2

EDUCATION

B.S. Computer Science, University of Washington, 2015

Skills:
Go, Postgres, Kafka
`

describe('inferResumeMarkdown', () => {
  const markdown = inferResumeMarkdown(PLAIN_RESUME)

  it('promotes the first line to the name heading', () => {
    expect(markdown.split('\n')[0]).toBe('# Jane Q. Doe')
  })

  it('keeps the contact line attached to the name as its own paragraph', () => {
    expect(markdown).toContain('jane.doe@example.com | 555-0100 | Seattle, WA')
  })

  it('promotes ALL-CAPS and vocabulary section names to h2', () => {
    expect(markdown).toContain('## PROFESSIONAL SUMMARY')
    expect(markdown).toContain('## EXPERIENCE')
    expect(markdown).toContain('## EDUCATION')
    // "Skills:" — vocabulary match, trailing colon stripped.
    expect(markdown).toContain('## Skills')
  })

  it('converts every bullet glyph to a Markdown bullet', () => {
    expect(markdown).toContain('- Led the migration of the ledger service to Postgres.')
    expect(markdown).toContain('- Built the refunds API.')
  })

  it('indents a nested bullet rather than flattening it', () => {
    expect(markdown).toContain('  - Rewrote the batch reconciler.')
    const blocks = parseResumeMarkdown(markdown)
    const list = blocks.find((b) => b.type === 'list' && b.items.some((i) => i.depth === 1))
    expect(list).toBeTruthy()
  })

  it('joins a date-only line onto the role line above it and bolds the result', () => {
    expect(markdown).toContain('**Senior Engineer, Northwind Payments — Mar 2019 - Present**')
    expect(markdown).toContain('**Engineer, Contoso — 2015 - 2019**')
  })

  it('drops page furniture', () => {
    expect(markdown).not.toContain('Page 2 of 2')
  })

  it('produces a document the block model can render', () => {
    const blocks = parseResumeMarkdown(markdown)
    expect(blocks.filter((b) => b.type === 'heading').length).toBeGreaterThanOrEqual(4)
    expect(blocks.some((b) => b.type === 'list')).toBe(true)
  })

  it('never invents or loses words — the same check the LLM output has to pass', () => {
    const report = checkReformatFaithfulness(PLAIN_RESUME, markdownToPlainText(markdown))
    expect(report.reason).toBeNull()
    expect(report.ok).toBe(true)
    // Only the dropped page furniture ("page", "of") may go missing.
    expect(report.retention).toBeGreaterThan(0.95)
    expect(report.novelty).toBe(0)
  })

  it('returns nothing for empty input instead of throwing', () => {
    expect(inferResumeMarkdown('')).toBe('')
    expect(inferResumeMarkdown('   \n\n ')).toBe('')
    expect(inferResumeMarkdown(null)).toBe('')
    expect(inferResumeMarkdown(undefined)).toBe('')
  })

  it('does not let an underscore in an email turn into emphasis', () => {
    const md = inferResumeMarkdown('Contact\n\njane_q_doe@example.com')
    expect(markdownToPlainText(md)).toContain('jane_q_doe@example.com')
  })

  it('does not treat a role line that has words around its dates as a date-only line', () => {
    const md = inferResumeMarkdown('EXPERIENCE\n\nStaff Engineer, Acme (2019 - 2023)\n- Did the thing.')
    expect(md).toContain('**Staff Engineer, Acme (2019 - 2023)**')
  })

  it('keeps CRLF and form-feed page breaks from mangling the document', () => {
    const md = inferResumeMarkdown('Jane Doe\r\n\r\nEXPERIENCE\r\n\f\r\n- Shipped it.')
    expect(md).toContain('# Jane Doe')
    expect(md).toContain('## EXPERIENCE')
    expect(md).toContain('- Shipped it.')
  })

  it('converts a typed-out rule into a Markdown rule, not a table trigger', () => {
    const md = inferResumeMarkdown('Jane Doe\n\n--------\n\nSKILLS\n\nGo')
    expect(parseResumeMarkdown(md).some((b) => b.type === 'rule')).toBe(true)
  })
})

describe('isLikelyName', () => {
  it('accepts names and rejects everything that is not one', () => {
    expect(isLikelyName('Jane Q. Doe')).toBe(true)
    expect(isLikelyName('ADA LOVELACE')).toBe(true)
    expect(isLikelyName('jane.doe@example.com')).toBe(false)
    expect(isLikelyName('555-0100')).toBe(false)
    expect(isLikelyName('EXPERIENCE')).toBe(false)
    expect(isLikelyName('Senior Staff Engineer with 12 years of experience')).toBe(false)
  })
})

describe('isKnownSectionTitle', () => {
  it('matches regardless of casing, colon or decoration', () => {
    expect(isKnownSectionTitle('EXPERIENCE')).toBe(true)
    expect(isKnownSectionTitle('Work Experience')).toBe(true)
    expect(isKnownSectionTitle('Technical Skills:')).toBe(true)
    expect(isKnownSectionTitle('--- EDUCATION ---')).toBe(true)
    expect(isKnownSectionTitle('Awards & Honors')).toBe(true)
    expect(isKnownSectionTitle('Led the payments team')).toBe(false)
  })
})

describe('escapeInlineMarkdown', () => {
  it('escapes what Markdown would otherwise eat', () => {
    expect(escapeInlineMarkdown('a_b*c')).toBe('a\\_b\\*c')
    expect(escapeInlineMarkdown('# not a heading')).toBe('\\# not a heading')
    expect(escapeInlineMarkdown('2019. Graduated')).toBe('2019\\. Graduated')
  })
})
