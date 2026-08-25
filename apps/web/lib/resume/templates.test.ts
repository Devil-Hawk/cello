import { PDFDocument, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_TEMPLATE_ID,
  RESUME_TEMPLATES,
  STANDARD_FONT_NAMES,
  getTemplate,
  isTemplateId,
  listTemplates,
  type TemplateSpec,
} from './templates'

describe('registry', () => {
  it('ships at least four templates with unique ids', () => {
    expect(RESUME_TEMPLATES.length).toBeGreaterThanOrEqual(4)
    const ids = RESUME_TEMPLATES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('resolves every shipped id', () => {
    for (const template of RESUME_TEMPLATES) {
      expect(getTemplate(template.id).id).toBe(template.id)
    }
  })

  it('degrades to the default for an unknown, null or empty id', () => {
    for (const bad of ['nope', '', 'CLASSIC', 'two-column', null, undefined]) {
      expect(getTemplate(bad).id).toBe(DEFAULT_TEMPLATE_ID)
    }
  })

  it('has a default that is itself a shipped template', () => {
    expect(RESUME_TEMPLATES.map((t) => t.id)).toContain(DEFAULT_TEMPLATE_ID)
  })

  it('guards ids', () => {
    expect(isTemplateId('classic')).toBe(true)
    expect(isTemplateId('nope')).toBe(false)
    expect(isTemplateId(7)).toBe(false)
    // Prototype keys must not resolve as templates.
    expect(isTemplateId('toString')).toBe(false)
    expect(getTemplate('constructor').id).toBe(DEFAULT_TEMPLATE_ID)
  })

  it('lists every template for a picker', () => {
    expect(listTemplates().map((t) => t.id)).toEqual(RESUME_TEMPLATES.map((t) => t.id))
    for (const summary of listTemplates()) {
      expect(summary.name.length).toBeGreaterThan(0)
      expect(summary.description.length).toBeGreaterThan(0)
    }
  })
})

describe('templates are visibly different', () => {
  // Fields a reader would actually notice on the page. If two templates agree
  // on all of these they are the same design with two names, which is the
  // exact bug this feature exists to fix ("any type of resume retains the
  // same format!").
  function signature(t: TemplateSpec): string {
    return JSON.stringify([
      t.fonts.body,
      t.fonts.heading,
      t.page.margins.left,
      t.page.margins.top,
      t.body.size,
      t.body.lineHeight,
      t.headings[1].size,
      t.headings[1].align,
      t.headings[2].size,
      t.headings[2].casing,
      t.headings[2].accent,
      t.headings[2].rule !== null,
      t.nameBlock.nameSize,
      t.nameBlock.nameAlign,
      t.nameBlock.rule !== null,
      t.bullets.glyphs[0],
      t.bullets.indent,
      t.colors.accent,
    ])
  }

  it('no two templates share a visual signature', () => {
    const seen = new Map<string, string>()
    for (const template of RESUME_TEMPLATES) {
      const sig = signature(template)
      const clash = seen.get(sig)
      expect(clash, `${template.id} is visually identical to ${clash}`).toBeUndefined()
      seen.set(sig, template.id)
    }
  })

  it('differs on the specific things each template promises', () => {
    const classic = getTemplate('classic')
    const modern = getTemplate('modern')
    const compact = getTemplate('compact')
    const minimal = getTemplate('minimal')

    // Classic is the only serif, and centres the name.
    expect(classic.fonts.body).toBe('times')
    expect(classic.nameBlock.nameAlign).toBe('center')
    expect(modern.fonts.body).toBe('helvetica')

    // Modern is the only one with a coloured accent used on section headings.
    expect(modern.headings[2].accent).toBe(true)
    expect(modern.colors.accent).not.toBe(modern.colors.text)

    // Compact really is the densest: smallest type, tightest leading,
    // narrowest margins, least space between bullets.
    for (const other of [classic, modern, minimal]) {
      expect(compact.body.size).toBeLessThan(other.body.size)
      expect(compact.body.lineHeight).toBeLessThan(other.body.lineHeight)
      expect(compact.page.margins.left).toBeLessThan(other.page.margins.left)
      expect(compact.bullets.itemSpacing).toBeLessThan(other.bullets.itemSpacing)
    }

    // Minimal really is the airiest, and draws no rules at all.
    for (const other of [classic, modern, compact]) {
      expect(minimal.page.margins.left).toBeGreaterThan(other.page.margins.left)
      expect(minimal.body.lineHeight).toBeGreaterThan(other.body.lineHeight)
    }
    expect(minimal.nameBlock.rule).toBeNull()
    expect(minimal.headings[1].rule).toBeNull()
    expect(minimal.headings[2].rule).toBeNull()
    expect(minimal.headings[3].rule).toBeNull()
  })
})

describe('ATS + renderer constraints', () => {
  it('is single column everywhere', () => {
    for (const template of RESUME_TEMPLATES) {
      expect(template.page.columns).toBe(1)
    }
  })

  it('leaves a usable text column on US Letter', () => {
    for (const template of RESUME_TEMPLATES) {
      expect(template.page.width).toBe(612)
      expect(template.page.height).toBe(792)
      const column = template.page.width - template.page.margins.left - template.page.margins.right
      expect(column, template.id).toBeGreaterThan(360)
    }
  })

  it('maps every font family to a real pdf-lib StandardFonts value', () => {
    const known = new Set<string>(Object.values(StandardFonts))
    for (const [family, styles] of Object.entries(STANDARD_FONT_NAMES)) {
      for (const [style, name] of Object.entries(styles)) {
        expect(known.has(name), `${family}.${style} = ${name}`).toBe(true)
      }
    }
  })

  it('every template font family is one the renderer can embed', async () => {
    const doc = await PDFDocument.create()
    for (const template of RESUME_TEMPLATES) {
      for (const family of [template.fonts.heading, template.fonts.body, template.fonts.mono]) {
        for (const name of Object.values(STANDARD_FONT_NAMES[family])) {
          const font = await doc.embedFont(name as StandardFonts)
          expect(font.name.length).toBeGreaterThan(0)
        }
      }
    }
  })

  it('every bullet glyph is encodable by the standard fonts, not silently a "?"', async () => {
    const doc = await PDFDocument.create()
    const charSets = new Map<string, Set<number>>()
    for (const family of ['helvetica', 'times', 'courier'] as const) {
      const font = await doc.embedFont(STANDARD_FONT_NAMES[family].regular as StandardFonts)
      charSets.set(family, new Set(font.getCharacterSet()))
    }
    for (const template of RESUME_TEMPLATES) {
      expect(template.bullets.glyphs.length).toBeGreaterThan(0)
      const supported = charSets.get(template.fonts.body)
      expect(supported).toBeDefined()
      for (const glyph of template.bullets.glyphs) {
        for (const ch of glyph) {
          expect(
            supported?.has(ch.codePointAt(0) ?? 0),
            `${template.id}: glyph ${JSON.stringify(glyph)} is not in the ${template.fonts.body} character set`
          ).toBe(true)
        }
      }
    }
  })

  it('uses well-formed hex colours', () => {
    for (const template of RESUME_TEMPLATES) {
      for (const value of Object.values(template.colors)) {
        expect(value, template.id).toMatch(/^#[0-9a-f]{6}$/i)
      }
    }
  })

  it('has positive, finite metrics a renderer can lay out with', () => {
    for (const t of RESUME_TEMPLATES) {
      expect(t.body.size).toBeGreaterThan(0)
      expect(t.body.lineHeight).toBeGreaterThan(1)
      expect(t.bullets.hangingIndent).toBeGreaterThan(0)
      for (const level of [1, 2, 3] as const) {
        const h = t.headings[level]
        expect(h.size, `${t.id} h${level}`).toBeGreaterThanOrEqual(t.body.size - 1.5)
        expect(h.spaceBefore).toBeGreaterThanOrEqual(0)
        expect(h.spaceAfter).toBeGreaterThanOrEqual(0)
        if (h.rule) {
          expect(h.rule.thickness).toBeGreaterThan(0)
          expect(h.rule.widthFactor).toBeGreaterThan(0)
          expect(h.rule.widthFactor).toBeLessThanOrEqual(1)
        }
      }
    }
  })
})
