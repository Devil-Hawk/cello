// Tests for the preview's pure half: the name/contact split and the
// TemplateSpec -> CSS arithmetic.
//
// splitResumeHeader() is the riskiest function in the studio UI: it decides
// which part of the document gets the template's 22pt name treatment. Get it
// wrong in one direction and a resume loses its header; wrong in the other and
// the first bullet of someone's job history is set across the top of the page.
// Every case below is a shape that actually arrives — an authored `# Name`, and
// the undesigned plain text that every resume in this product starts life as.
//
// No DOM: vitest.config.ts configures no jsdom environment (see
// components/copilot/observation-view.test.tsx's header), and none is needed —
// these are strings and style objects.

import { describe, expect, it } from 'vitest'
import { getTemplate, RESUME_TEMPLATES } from '@/lib/resume/templates'
import {
  PREVIEW_FONT_STACKS,
  PREVIEW_PX_PER_PT,
  pt,
  resumePreviewStyles,
  splitResumeHeader,
} from './template-preview-style'

describe('splitResumeHeader — authored Markdown', () => {
  it('takes an opening h1 as the name and the paragraph under it as contact', () => {
    const split = splitResumeHeader(
      '# Jane Doe\njane@example.com | +1 555 0100\n\n## Experience\n\n- Shipped things'
    )
    expect(split.name).toBe('Jane Doe')
    expect(split.contact).toBe('jane@example.com | +1 555 0100')
    expect(split.body).toBe('## Experience\n\n- Shipped things')
  })

  it('keeps multi-line contact details on separate lines (Markdown hard breaks)', () => {
    const split = splitResumeHeader('# Jane Doe\nSeattle, WA\njane@example.com\n\n## Experience')
    // Two trailing spaces before the newline is a hard break; without it these
    // three lines would be reflowed into one by any HTML renderer.
    expect(split.contact).toBe('Seattle, WA  \njane@example.com')
  })

  it('reports no contact when a section heading follows the name immediately', () => {
    const split = splitResumeHeader('# Jane Doe\n\n## Experience\n\n- Shipped things')
    expect(split.name).toBe('Jane Doe')
    expect(split.contact).toBeNull()
    expect(split.body).toBe('## Experience\n\n- Shipped things')
  })

  it('ignores blank lines before the name', () => {
    expect(splitResumeHeader('\n\n# Jane Doe\n\nBody').name).toBe('Jane Doe')
  })

  it('does not treat an h2 as the name — that is a section, not a person', () => {
    const split = splitResumeHeader('## Experience\n\n- Shipped things')
    expect(split.name).toBeNull()
    expect(split.body).toBe('## Experience\n\n- Shipped things')
  })
})

describe('splitResumeHeader — the plain text every stored resume actually is', () => {
  it('treats a short opening line as the name, with the block under it as contact', () => {
    const plain = 'JANE DOE\nSenior Engineer\njane@example.com\n\nEXPERIENCE\n\nAcme Corp'
    const split = splitResumeHeader(plain)
    expect(split.name).toBe('JANE DOE')
    expect(split.contact).toBe('Senior Engineer  \njane@example.com')
    expect(split.body).toBe('EXPERIENCE\n\nAcme Corp')
  })

  it('refuses to promote a paragraph of prose to a 22pt name', () => {
    const prose =
      'Experienced platform engineer with a decade of work across billing, identity and infrastructure.'
    expect(prose.length).toBeGreaterThan(60)
    const split = splitResumeHeader(prose)
    expect(split.name).toBeNull()
    expect(split.body).toBe(prose)
  })

  it('refuses to promote a bullet', () => {
    expect(splitResumeHeader('- Shipped the thing\n- Shipped another').name).toBeNull()
  })

  it('survives empty, whitespace-only and null input without throwing', () => {
    for (const input of ['', '   \n\n  ', null, undefined]) {
      const split = splitResumeHeader(input)
      expect(split.name).toBeNull()
      expect(split.contact).toBeNull()
    }
  })

  it('normalises CRLF so a Windows-authored upload splits the same way', () => {
    const split = splitResumeHeader('# Jane Doe\r\njane@example.com\r\n\r\n## Experience')
    expect(split.name).toBe('Jane Doe')
    expect(split.contact).toBe('jane@example.com')
    expect(split.body).toBe('## Experience')
  })

  it('never loses text: name + contact + body cover the whole document', () => {
    const source = 'JANE DOE\njane@example.com\n\nEXPERIENCE\n\n- Shipped things'
    const { name, contact, body } = splitResumeHeader(source)
    const roundTripped = [name, contact?.replace(/ {2}\n/g, '\n'), body].filter(Boolean).join('\n')
    // Same words, same order — the split only decides how they are STYLED.
    expect(roundTripped.replace(/\s+/g, ' ').trim()).toBe(source.replace(/\s+/g, ' ').trim())
  })
})

describe('resumePreviewStyles — every number comes from the spec', () => {
  it('scales points to px with one factor', () => {
    expect(pt(10)).toBe(`${10 * PREVIEW_PX_PER_PT}px`)
    expect(pt(0)).toBe('0px')
  })

  it('sets the page from the template’s own margins, size and colour', () => {
    for (const spec of RESUME_TEMPLATES) {
      const styles = resumePreviewStyles(spec)
      expect(styles.page.paddingTop).toBe(pt(spec.page.margins.top))
      expect(styles.page.paddingLeft).toBe(pt(spec.page.margins.left))
      expect(styles.page.fontSize).toBe(pt(spec.body.size))
      expect(styles.page.lineHeight).toBe(spec.body.lineHeight)
      expect(styles.page.color).toBe(spec.colors.text)
      expect(styles.page.fontFamily).toBe(PREVIEW_FONT_STACKS[spec.fonts.body])
    }
  })

  it('draws a rule exactly where the spec has one, and nowhere else', () => {
    for (const spec of RESUME_TEMPLATES) {
      const styles = resumePreviewStyles(spec)
      expect(Boolean(styles.header.borderBottom)).toBe(Boolean(spec.nameBlock.rule))
      for (const level of [1, 2, 3] as const) {
        expect(Boolean(styles.headings[level].borderBottom)).toBe(Boolean(spec.headings[level].rule))
      }
    }
  })

  it('uses the accent colour only where the spec asks for it', () => {
    const modern = resumePreviewStyles(getTemplate('modern'))
    expect(modern.headings[2].color).toBe(getTemplate('modern').colors.accent)
    // Classic is explicitly colourless: its accent IS its text colour.
    const classic = getTemplate('classic')
    expect(resumePreviewStyles(classic).headings[2].color).toBe(classic.colors.text)
  })

  it('publishes a bullet glyph per depth, quoted for CSS `content`', () => {
    for (const spec of RESUME_TEMPLATES) {
      const vars = resumePreviewStyles(spec).vars as unknown as Record<string, string>
      expect(vars['--rp-bullet-0']).toBe(`"${spec.bullets.glyphs[0]}"`)
      // Depth beyond the glyph list clamps to the last entry rather than blanking.
      expect(vars['--rp-bullet-2']).toBe(
        `"${spec.bullets.glyphs[Math.min(2, spec.bullets.glyphs.length - 1)]}"`
      )
    }
  })

  it('gives the four templates visibly different name treatments', () => {
    const signatures = RESUME_TEMPLATES.map((spec) => {
      const s = resumePreviewStyles(spec)
      return JSON.stringify([s.name.fontSize, s.name.textAlign, s.name.fontWeight, s.page.paddingLeft])
    })
    expect(new Set(signatures).size).toBe(RESUME_TEMPLATES.length)
  })
})
