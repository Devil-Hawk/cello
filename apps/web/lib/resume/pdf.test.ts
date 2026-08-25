// Structural tests for the PDF exporter.
//
// HOW THESE TESTS SEE INSIDE THE PDF
//   pdf-lib flate-compresses content streams, so grepping the output bytes for
//   "Jane Doe" proves nothing. Instead each test temporarily wraps
//   `PDFPage.prototype.drawText` / `drawLine` and records every draw call with
//   its x, y, size and FONT. That gives the real geometry — the same numbers
//   the viewer will use — so an assertion like "no drawn text crosses the
//   right margin" is measuring the document, not a proxy for it.
//
//   Nothing here is a byte snapshot. Snapshots of a PDF break on every
//   whitespace change in the source and prove nothing about layout.

import { PDFDocument, PDFPage, type PDFFont, type RGB } from 'pdf-lib'
import { afterEach, describe, expect, it } from 'vitest'
import { extractText, getDocumentProxy } from 'unpdf'

import { parseResumeMarkdown } from './markdown'
import { renderResumeBlocksPdf, renderResumePdf, renderResumeVersionPdf, splitResumeHeader } from './pdf'
import { RESUME_TEMPLATES, getTemplate, type TemplateSpec } from './templates'

// ---------------------------------------------------------------------------
// Draw-call recorder
// ---------------------------------------------------------------------------

interface TextDraw {
  /** Page index in draw order (the renderer only ever draws on the newest page). */
  page: number
  x: number
  y: number
  size: number
  font: PDFFont
  text: string
  color?: RGB
  /** x of the right edge of the drawn string, measured with its own font. */
  right: number
}

interface LineDraw {
  page: number
  x: number
  y: number
  width: number
  thickness: number
  color?: RGB
}

interface Capture {
  bytes: Uint8Array
  texts: TextDraw[]
  lines: LineDraw[]
  pageCount: number
}

const originalDrawText = PDFPage.prototype.drawText
const originalDrawLine = PDFPage.prototype.drawLine

afterEach(() => {
  PDFPage.prototype.drawText = originalDrawText
  PDFPage.prototype.drawLine = originalDrawLine
})

/** The subset of pdf-lib's draw options this recorder reads. */
interface TextOptions {
  x: number
  y: number
  size: number
  font: PDFFont
  color?: RGB
}
interface LineOptions {
  start: { x: number; y: number }
  end: { x: number; y: number }
  thickness: number
  color?: RGB
}

async function capture(render: () => Promise<Uint8Array>): Promise<Capture> {
  const texts: TextDraw[] = []
  const lines: LineDraw[] = []
  const pageIndex = new Map<unknown, number>()
  const pageOf = (page: unknown): number => {
    if (!pageIndex.has(page)) pageIndex.set(page, pageIndex.size)
    return pageIndex.get(page)!
  }

  PDFPage.prototype.drawText = function patched(this: PDFPage, text: string, opts?: unknown) {
    const options = opts as TextOptions
    const font = options.font
    texts.push({
      page: pageOf(this),
      x: options.x,
      y: options.y,
      size: options.size,
      font,
      text,
      color: options.color,
      right: options.x + font.widthOfTextAtSize(text, options.size),
    })
    return originalDrawText.call(this, text, opts as never)
  } as typeof originalDrawText

  PDFPage.prototype.drawLine = function patched(this: PDFPage, opts: unknown) {
    const options = opts as LineOptions
    lines.push({
      page: pageOf(this),
      x: options.start.x,
      y: options.start.y,
      width: options.end.x - options.start.x,
      thickness: options.thickness,
      color: options.color,
    })
    return originalDrawLine.call(this, opts as never)
  } as typeof originalDrawLine

  const bytes = await render()
  PDFPage.prototype.drawText = originalDrawText
  PDFPage.prototype.drawLine = originalDrawLine

  const loaded = await PDFDocument.load(bytes)
  return { bytes, texts, lines, pageCount: loaded.getPageCount() }
}

/** Group draws into visual lines: same page, same baseline. */
function visualLines(texts: readonly TextDraw[]): TextDraw[][] {
  const byLine = new Map<string, TextDraw[]>()
  for (const draw of texts) {
    const key = `${draw.page}:${draw.y.toFixed(3)}`
    const bucket = byLine.get(key)
    if (bucket) bucket.push(draw)
    else byLine.set(key, [draw])
  }
  return [...byLine.values()]
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Deliberately mixes weights, styles and code MID-LINE, and includes a URL
 *  far longer than any column, which is the case that used to run off the page. */
const RESUME = `# Jane Doe
Senior Platform Engineer | jane@example.com | [portfolio](https://jane.dev) | 555-0100

## Summary

Engineer with **eleven years of production experience** across *distributed storage*, \`io_uring\` and everything in between, who has repeatedly **taken a system from "nobody wants to be on call for this" to boring**.

## Experience

### Staff Engineer, Acme Corp
2021 — Present

- Led the migration of **47 services** onto one deployment pipeline, cutting median release lead time from *six days* to **forty minutes** and removing \`kubectl apply\` from the release runbook entirely.
  - Wrote the rollback controller in \`Go\`; it has fired 19 times in production.
  - Ran the training programme for 30 engineers.
- Reduced infrastructure spend by **$1.2M/yr** without reducing headroom.

### Engineer, Globex

1. First numbered achievement, which is long enough to need wrapping onto a second line so that the hanging indent is actually exercised by this test.
2. Second numbered achievement.

---

## Links

https://example.com/an/extremely/long/path/that/no/resume/column/could/ever/hope/to/contain/without/being/broken/somewhere

## Education

B.S. Computer Science, State University
`

function longResume(sections: number): string {
  const parts: string[] = ['# Jane Doe', 'jane@example.com | 555-0100', '']
  for (let i = 1; i <= sections; i += 1) {
    parts.push(`## Section ${i}`, '')
    parts.push(`Some introductory prose for section ${i} that runs long enough to wrap at least once on a US Letter page with ordinary margins.`, '')
    for (let b = 1; b <= 4; b += 1) {
      parts.push(`- Bullet ${b} of section ${i}, describing an outcome in enough words that it wraps onto a second line.`)
    }
    parts.push('')
  }
  return parts.join('\n')
}

const EPSILON = 0.5

// ---------------------------------------------------------------------------

describe('renderResumePdf', () => {
  it('produces a loadable single-page PDF for a normal resume', async () => {
    const { bytes, pageCount } = await capture(() => renderResumePdf(RESUME, { templateId: 'modern' }))
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-')
    expect(pageCount).toBe(1)
  })

  it('renders empty, whitespace-only and null input without throwing', async () => {
    for (const input of ['', '   \n\n  ', null, undefined]) {
      const bytes = await renderResumePdf(input)
      const doc = await PDFDocument.load(bytes)
      expect(doc.getPageCount()).toBe(1)
    }
  })

  it('reads the authored markdown and template id off a stored version', async () => {
    const { texts } = await capture(() =>
      renderResumeVersionPdf({
        title: 'Tailored — Acme',
        content: 'Jane Doe\njane@example.com',
        content_json: { markdown: '# Jane Doe\n\n## Skills\n\n- Rust', templateId: 'compact' },
      })
    )
    // 'compact' upper-cases the name and sets it at 15pt; the plain-text
    // `content` column must NOT be what got rendered.
    expect(texts.map((t) => t.text)).toContain('JANE DOE')
    expect(texts.some((t) => t.text === 'Rust')).toBe(true)
  })

  it('never stacks a version label on top of the candidate name', async () => {
    // Authored resume with an h1 name...
    const authored = await capture(() =>
      renderResumePdf('# Jane Doe\n\n## Skills\n\n- Rust', { title: 'Tailored — Acme' })
    )
    expect(authored.texts.map((t) => t.text)).not.toContain('Tailored — Acme')

    // ...and an undesigned plain-text upload whose first line we promote.
    const plain = await capture(() =>
      renderResumePdf('Jane Doe\njane@example.com\n\nSUMMARY\n\nDid things.', {
        title: 'Tailored — Acme',
      })
    )
    expect(plain.texts.map((t) => t.text)).not.toContain('Tailored — Acme')
  })

  it('does render the version label when there is no name line at all', async () => {
    const { texts } = await capture(() =>
      renderResumePdf(
        'Experienced platform engineer with a decade of production ownership behind them.',
        { title: 'Tailored — Acme' }
      )
    )
    expect(texts.map((t) => t.text)).toContain('TAILORED — ACME') // modern h2 casing
  })
})

describe('line breaking', () => {
  it.each(RESUME_TEMPLATES.map((t) => [t.id, t] as const))(
    'keeps every drawn string inside the %s template margins',
    async (_id, tpl: TemplateSpec) => {
      const { texts } = await capture(() => renderResumePdf(RESUME, { template: tpl }))
      expect(texts.length).toBeGreaterThan(20)

      const rightEdge = tpl.page.width - tpl.page.margins.right
      const overflowing = texts.filter((t) => t.right > rightEdge + EPSILON)
      expect(
        overflowing.map((t) => `${t.text} -> ${t.right.toFixed(1)} > ${rightEdge}`)
      ).toEqual([])

      for (const draw of texts) {
        expect(draw.x).toBeGreaterThanOrEqual(tpl.page.margins.left - EPSILON)
        // Baseline plus ascender must clear the top margin...
        expect(draw.y + draw.size * 0.8).toBeLessThanOrEqual(
          tpl.page.height - tpl.page.margins.top + EPSILON
        )
        // ...and baseline minus descender must clear the bottom margin.
        expect(draw.y - draw.size * 0.25).toBeGreaterThanOrEqual(
          tpl.page.margins.bottom - EPSILON
        )
      }
    }
  )

  it('actually exercises multiple fonts on a single line', async () => {
    // Guards the test above from passing vacuously: if the fixture never mixed
    // fonts mid-line, the per-font measuring bug could not be caught.
    const { texts } = await capture(() => renderResumePdf(RESUME, { templateId: 'modern' }))
    const mixed = visualLines(texts).filter(
      (line) => new Set(line.map((d) => d.font.name)).size > 1
    )
    expect(mixed.length).toBeGreaterThan(0)
    const names = new Set(texts.map((d) => d.font.name))
    expect(names).toContain('Helvetica')
    expect(names).toContain('Helvetica-Bold')
    expect(names).toContain('Helvetica-Oblique')
    expect(names).toContain('Courier')
  })

  it('does not overflow when a whole wrapped line is set in a wider font', async () => {
    // The regression this file exists for: Courier and Helvetica-Bold are both
    // wider than Helvetica at the same size. Measuring with the body font and
    // drawing in the bold/mono one silently runs past the margin.
    const bold = `# Jane Doe\n\n## Skills\n\n**${'Distributed Systems Reliability Engineering '.repeat(6).trim()}**\n\n\`${'kubectl_rollout_status_deployment '.repeat(6).trim()}\`\n`
    const tpl = getTemplate('modern')
    const { texts } = await capture(() => renderResumePdf(bold, { template: tpl }))
    const rightEdge = tpl.page.width - tpl.page.margins.right
    expect(texts.filter((t) => t.right > rightEdge + EPSILON)).toEqual([])
    expect(texts.some((t) => t.font.name === 'Helvetica-Bold')).toBe(true)
    expect(texts.some((t) => t.font.name === 'Courier')).toBe(true)
  })

  it('breaks a single word that is wider than the whole column', async () => {
    const tpl = getTemplate('minimal') // narrowest column of the four
    const { texts } = await capture(() =>
      renderResumePdf(`# Jane Doe\n\nhttps://example.com/${'segment/'.repeat(40)}end\n`, {
        template: tpl,
      })
    )
    const rightEdge = tpl.page.width - tpl.page.margins.right
    expect(texts.filter((t) => t.right > rightEdge + EPSILON)).toEqual([])
    // The URL survived: reassembling every drawn fragment contains it.
    expect(texts.map((t) => t.text).join('')).toContain('https://example.com/segment/')
  })
})

describe('pagination', () => {
  it('flows a long document onto multiple pages', async () => {
    const { texts, pageCount } = await capture(() =>
      renderResumePdf(longResume(14), { templateId: 'modern' })
    )
    expect(pageCount).toBeGreaterThan(1)
    expect(new Set(texts.map((t) => t.page)).size).toBe(pageCount)
  })

  it('never strands a section heading alone at the foot of a page', async () => {
    const tpl = getTemplate('modern')
    const { texts, pageCount } = await capture(() =>
      renderResumePdf(longResume(14), { template: tpl })
    )
    expect(pageCount).toBeGreaterThan(1)

    const headings = new Set(
      Array.from({ length: 14 }, (_unused, i) => `SECTION ${i + 1}`) // h2 casing is uppercase
    )
    for (let page = 0; page < pageCount - 1; page += 1) {
      const onPage = texts.filter((t) => t.page === page)
      const last = onPage[onPage.length - 1]
      expect(last && headings.has(last.text)).toBe(false)
    }
  })
})

describe('character handling', () => {
  const HOSTILE = [
    '# Jané Doe™',
    '',
    'Résumé built in Word: “smart quotes”, an em—dash, an ellipsis…, a soft­hyphen,',
    'a no break space, a zero​width space, an emoji 🚀, an arrow → and a check ✓.',
    '',
    '## Skills',
    '',
    '- 中文 characters and ★ stars',
    '- Ligatures: ﬁle, ﬂow, oﬀice',
    '',
  ].join('\n')

  it.each(RESUME_TEMPLATES.map((t) => [t.id, t] as const))(
    'never throws and never draws an unencodable glyph (%s)',
    async (_id, tpl: TemplateSpec) => {
      const { texts } = await capture(() => renderResumePdf(HOSTILE, { template: tpl }))
      expect(texts.length).toBeGreaterThan(0)
      for (const draw of texts) {
        const supported = new Set(draw.font.getCharacterSet())
        const bad = [...draw.text].filter((ch) => !supported.has(ch.codePointAt(0)!))
        expect({ text: draw.text, bad }).toEqual({ text: draw.text, bad: [] })
      }
    }
  )

  it('preserves typography the standard fonts CAN render', async () => {
    // Em dashes and curly quotes are encodable, so folding them to ASCII would
    // be gratuitous damage to a Word-authored resume.
    const { texts } = await capture(() =>
      renderResumePdf('# Jane Doe\n\n2021 — Present, a “real” quote and an ellipsis…\n', {
        templateId: 'modern',
      })
    )
    const joined = texts.map((t) => t.text).join(' ')
    expect(joined).toContain('—')
    expect(joined).toContain('“')
    expect(joined).toContain('…')
  })

  it('draws emphasis as fonts, never as literal markdown syntax', async () => {
    const { texts } = await capture(() => renderResumePdf(RESUME, { templateId: 'modern' }))
    for (const draw of texts) {
      expect(draw.text).not.toContain('**')
      expect(draw.text).not.toContain('`')
      expect(draw.text).not.toMatch(/\]\(http/)
    }
    // ...and the bold words are present, in a bold font.
    const boldRun = texts.find((t) => t.text.includes('47 services'))
    expect(boldRun?.font.name).toBe('Helvetica-Bold')
  })
})

describe('templates change the document', () => {
  it('produces visibly different geometry and typography for classic vs compact', async () => {
    const classic = await capture(() => renderResumePdf(RESUME, { templateId: 'classic' }))
    const compact = await capture(() => renderResumePdf(RESUME, { templateId: 'compact' }))

    // Different font families...
    expect(new Set(classic.texts.map((t) => t.font.name))).toContain('Times-Roman')
    expect(new Set(compact.texts.map((t) => t.font.name))).toContain('Helvetica')
    expect([...new Set(classic.texts.map((t) => t.font.name))]).not.toContain('Helvetica')

    // ...different margins...
    expect(Math.min(...classic.texts.map((t) => t.x))).toBe(72)
    expect(Math.min(...compact.texts.map((t) => t.x))).toBe(40)

    // ...different casing of the name...
    expect(classic.texts.map((t) => t.text)).toContain('Jane Doe')
    expect(compact.texts.map((t) => t.text)).toContain('JANE DOE')

    // ...and different bytes.
    expect(Buffer.from(classic.bytes).equals(Buffer.from(compact.bytes))).toBe(false)
  })

  it('gives every shipped template a distinct set of drawn text sizes or positions', async () => {
    const signatures = new Set<string>()
    for (const tpl of RESUME_TEMPLATES) {
      const { texts } = await capture(() => renderResumePdf(RESUME, { template: tpl }))
      signatures.add(
        JSON.stringify([
          [...new Set(texts.map((t) => t.font.name))].sort(),
          [...new Set(texts.map((t) => t.size))].sort((a, b) => a - b),
          Math.min(...texts.map((t) => t.x)),
          texts[0]?.text,
        ])
      )
    }
    expect(signatures.size).toBe(RESUME_TEMPLATES.length)
  })

  it('draws rules only where the template asks for them', async () => {
    const noRules = '# Jane Doe\njane@example.com\n\n## Experience\n\nDid things.\n'
    const modern = await capture(() => renderResumePdf(noRules, { templateId: 'modern' }))
    const minimal = await capture(() => renderResumePdf(noRules, { templateId: 'minimal' }))

    // Modern rules the name block and every h2, in the accent colour.
    expect(modern.lines.length).toBe(2)
    expect(modern.lines[0]!.color).toEqual({
      type: 'RGB',
      red: 0x1d / 255,
      green: 0x4e / 255,
      blue: 0xd8 / 255,
    })
    // Minimal has no rules at all in its name block or headings.
    expect(minimal.lines).toEqual([])
  })

  it('honours a horizontal rule block with the template rule spec', async () => {
    const tpl = getTemplate('minimal')
    const { lines } = await capture(() =>
      renderResumePdf('# Jane Doe\n\nOne\n\n---\n\nTwo\n', { template: tpl })
    )
    expect(lines).toHaveLength(1)
    const textWidth = tpl.page.width - tpl.page.margins.left - tpl.page.margins.right
    expect(lines[0]!.width).toBeCloseTo(textWidth * tpl.rule.widthFactor, 5)
    expect(lines[0]!.thickness).toBe(tpl.rule.thickness)
  })

  it('degrades an unknown or missing template id to the default', async () => {
    const unknown = await capture(() => renderResumePdf(RESUME, { templateId: 'not-a-template' }))
    const fallback = await capture(() => renderResumePdf(RESUME, { templateId: null }))
    const modern = await capture(() => renderResumePdf(RESUME, { templateId: 'modern' }))
    const shape = (c: Awaited<ReturnType<typeof capture>>) =>
      c.texts.map((t) => `${t.text}@${t.x.toFixed(2)},${t.y.toFixed(2)},${t.size}`)
    expect(shape(unknown)).toEqual(shape(modern))
    expect(shape(fallback)).toEqual(shape(modern))
  })
})

describe('lists', () => {
  it('draws the template glyph and hangs wrapped text under the text, not the glyph', async () => {
    const tpl = getTemplate('modern')
    const md = [
      '# Jane Doe',
      '',
      '- A top level bullet whose text is long enough that it certainly must wrap onto a second visual line inside the column, because it keeps going well past the point where any reasonable person would have stopped writing.',
      '  - A nested bullet that also wraps, because it too says quite a lot of words in a row here and then carries on saying rather more of them until the column runs out.',
      '',
    ].join('\n')
    const { texts } = await capture(() => renderResumePdf(md, { template: tpl }))

    const top = texts.find((t) => t.text === tpl.bullets.glyphs[0])
    const nested = texts.find((t) => t.text === tpl.bullets.glyphs[1])
    expect(top).toBeDefined()
    expect(nested).toBeDefined()

    // The glyph sits at the item's indent; text starts one hangingIndent right.
    expect(top!.x).toBeCloseTo(tpl.page.margins.left, 5)
    expect(nested!.x).toBeCloseTo(tpl.page.margins.left + tpl.bullets.indent, 5)

    const textAfter = (glyph: TextDraw) =>
      texts.filter((t) => t.page === glyph.page && t.y < glyph.y + 0.01 && t !== glyph)
    const firstTop = texts.find((t) => t.y === top!.y && t !== top)
    expect(firstTop!.x).toBeCloseTo(top!.x + tpl.bullets.hangingIndent, 5)

    // The wrapped continuation of the first bullet aligns with its text, not
    // with the glyph — that is what "hanging indent" means.
    const continuation = textAfter(top!).find((t) => t.y < top!.y - 0.01)
    expect(continuation!.x).toBeCloseTo(top!.x + tpl.bullets.hangingIndent, 5)
  })

  it('numbers ordered lists from the source, with the same hanging indent', async () => {
    const tpl = getTemplate('modern')
    const { texts } = await capture(() =>
      renderResumePdf('# Jane Doe\n\n1. alpha\n2. beta\n3. gamma\n', { template: tpl })
    )
    const markers = texts.filter((t) => /^\d+\.$/.test(t.text)).map((t) => t.text)
    expect(markers).toEqual(['1.', '2.', '3.'])
    const alpha = texts.find((t) => t.text === 'alpha')!
    const marker = texts.find((t) => t.text === '1.')!
    expect(alpha.x).toBeCloseTo(marker.x + tpl.bullets.hangingIndent, 5)
  })

  it('emits the bullet glyph before its own text in the content stream', async () => {
    // Content-stream order is the order an ATS reads the document in. If the
    // marker were drawn after the line it belongs to, extraction produces
    // "...to 40• minutes" — the glyph spliced into the middle of a sentence.
    const bytes = await renderResumePdf('# Jane Doe\n\n- Led the migration of 47 services\n', {
      templateId: 'modern',
    })
    const pdf = await getDocumentProxy(new Uint8Array(bytes))
    const { text } = await extractText(pdf, { mergePages: true })
    expect(text).toContain('• Led the migration')
  })
})

describe('links', () => {
  it('attaches a real clickable annotation instead of pasting the URL as text', async () => {
    const bytes = await renderResumePdf(
      '# Jane Doe\n\nSee my [portfolio](https://jane.dev/work) for details.\n',
      { templateId: 'modern' }
    )
    const doc = await PDFDocument.load(bytes)
    const annots = doc.getPage(0).node.Annots()
    expect(annots).toBeDefined()
    expect(annots!.size()).toBe(1)
    // Annots holds indirect references; resolve the first one to see the dict.
    const annot = doc.context.lookup(annots!.get(0))!.toString()
    expect(annot).toContain('/Link')
    expect(annot).toContain('/URI')
    expect(annot).toContain('https://jane.dev/work')

    // The visible text is the label only — no "(https://...)" pasted beside it.
    const { texts } = await capture(() =>
      renderResumePdf('# Jane Doe\n\nSee my [portfolio](https://jane.dev/work) for details.\n', {
        templateId: 'modern',
      })
    )
    expect(texts.map((t) => t.text).join(' ')).not.toContain('jane.dev')
  })

  it('ignores a non-http scheme rather than emitting a bogus annotation', async () => {
    const bytes = await renderResumePdf(
      '# Jane Doe\n\n[click](javascript:alert(1)) here\n',
      { templateId: 'modern' }
    )
    const doc = await PDFDocument.load(bytes)
    const annots = doc.getPage(0).node.Annots()
    // pdf-lib normalises a page to carry an (empty) Annots array on load, so
    // "no annotation" means size 0, not an absent key.
    expect(annots?.size() ?? 0).toBe(0)
  })
})

describe('splitResumeHeader', () => {
  it('treats an h1 plus the following paragraph as the name and contact block', () => {
    const blocks = parseResumeMarkdown('# Jane Doe\n\njane@example.com | 555-0100\n\n## Skills\n')
    const split = splitResumeHeader(blocks)
    expect(split.name?.map((r) => r.text).join('')).toBe('Jane Doe')
    expect(split.contact).toHaveLength(1)
    expect(split.bodyStart).toBe(2)
  })

  it('promotes the first line of an undesigned plain-text upload to the name', () => {
    const blocks = parseResumeMarkdown('Jane Doe\njane@example.com | 555-0100\n\nSUMMARY\n')
    const split = splitResumeHeader(blocks)
    expect(split.name?.map((r) => r.text).join('')).toBe('Jane Doe')
    expect(split.contact.map((l) => l.map((r) => r.text).join(''))).toEqual([
      'jane@example.com | 555-0100',
    ])
    expect(split.bodyStart).toBe(1)
  })

  it('does not blow a summary sentence up to 22pt', () => {
    const blocks = parseResumeMarkdown(
      'Experienced platform engineer with a decade of production ownership.\nMore prose.\n'
    )
    expect(splitResumeHeader(blocks)).toEqual({ name: null, contact: [], bodyStart: 0 })
  })

  it('returns an empty split for an empty document', () => {
    expect(splitResumeHeader([])).toEqual({ name: null, contact: [], bodyStart: 0 })
  })
})

describe('renderResumeBlocksPdf', () => {
  it('accepts a pre-parsed block model and matches the string entry point', async () => {
    const viaString = await capture(() => renderResumePdf(RESUME, { templateId: 'classic' }))
    const viaBlocks = await capture(() =>
      renderResumeBlocksPdf(parseResumeMarkdown(RESUME), { templateId: 'classic' })
    )
    const shape = (c: Capture) => c.texts.map((t) => `${t.text}@${t.x.toFixed(3)},${t.y.toFixed(3)}`)
    expect(shape(viaBlocks)).toEqual(shape(viaString))
  })
})
