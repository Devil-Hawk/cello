// Structural tests for the DOCX exporter.
//
// A .docx is a ZIP of XML parts, so these tests open the produced package and
// assert on the parts themselves: that `word/document.xml` references the real
// Heading styles, that `word/styles.xml` defines those styles from the chosen
// template, that bullets go through `word/numbering.xml` rather than being
// literal glyph characters, and that links are real external relationships.
// That is the difference between "a .docx" and "a text dump inside a .docx",
// and it is not visible from the byte length of the file.
//
// The ZIP reader below is deliberately hand-rolled against the central
// directory: adding a zip dependency just to read our own output would mean
// the test could pass because both sides share a bug.

import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

import { parseResumeMarkdown } from './markdown'
import { renderResumeBlocksDocx, renderResumeDocx, renderResumeVersionDocx } from './docx'
import { RESUME_TEMPLATES, getTemplate } from './templates'

// ---------------------------------------------------------------------------
// Minimal ZIP reader (central directory -> local headers -> inflate)
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50

function unzip(bytes: Uint8Array): Map<string, Buffer> {
  const buf = Buffer.from(bytes)
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record')

  const entryCount = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const out = new Map<string, Buffer>()

  for (let n = 0; n < entryCount; n += 1) {
    if (buf.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new Error('corrupt central directory')
    const method = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const nameLength = buf.readUInt16LE(offset + 28)
    const extraLength = buf.readUInt16LE(offset + 30)
    const commentLength = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength)

    const localNameLength = buf.readUInt16LE(localOffset + 26)
    const localExtraLength = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const data = buf.subarray(dataStart, dataStart + compressedSize)
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data))

    offset += 46 + nameLength + extraLength + commentLength
  }
  return out
}

async function open(md: string, templateId?: string) {
  const bytes = await renderResumeDocx(md, templateId ? { templateId } : {})
  const parts = unzip(bytes)
  const read = (name: string): string => {
    const part = parts.get(name)
    if (!part) throw new Error(`missing package part ${name}; have ${[...parts.keys()].join(', ')}`)
    return part.toString('utf8')
  }
  return { bytes, parts, read, document: read('word/document.xml'), styles: read('word/styles.xml') }
}

/** The `<w:style ...>` element with the given styleId, or undefined. */
function styleElement(styles: string, id: string): string | undefined {
  const match = new RegExp(`<w:style [^>]*w:styleId="${id}">[\\s\\S]*?</w:style>`).exec(styles)
  return match?.[0]
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const RESUME = `# Jane Doe
Senior Platform Engineer | jane@example.com | [portfolio](https://jane.dev) | 555-0100

## Summary

Engineer with **eleven years** of *production* experience and a working \`io_uring\` implementation.

## Experience

### Staff Engineer, Acme Corp
2021 — Present

- Led the migration of **47 services** onto one deployment pipeline.
  - Wrote the rollback controller in \`Go\`.
- Reduced infrastructure spend by $1.2M/yr.

### Engineer, Globex

1. First numbered achievement.
2. Second numbered achievement.

---

## Education

B.S. Computer Science, State University
`

// ---------------------------------------------------------------------------

describe('package structure', () => {
  it('produces a valid ZIP carrying every part Word needs', async () => {
    const { bytes, parts } = await open(RESUME, 'modern')
    expect(Buffer.from(bytes.slice(0, 2)).toString('latin1')).toBe('PK')
    for (const part of [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/styles.xml',
      'word/numbering.xml',
      'word/_rels/document.xml.rels',
    ]) {
      expect([...parts.keys()]).toContain(part)
    }
  })

  it('takes its page size and margins from the template', async () => {
    for (const tpl of RESUME_TEMPLATES) {
      const { document } = await open(RESUME, tpl.id)
      // OOXML geometry is in twips: 20 per PDF point.
      expect(document).toContain(
        `<w:pgSz w:w="${tpl.page.width * 20}" w:h="${tpl.page.height * 20}"`
      )
      expect(document).toContain(
        `<w:pgMar w:top="${tpl.page.margins.top * 20}" w:right="${tpl.page.margins.right * 20}" w:bottom="${tpl.page.margins.bottom * 20}" w:left="${tpl.page.margins.left * 20}"`
      )
    }
  })

  it('renders empty, whitespace-only and null input without throwing', async () => {
    for (const input of ['', '   \n\n ', null, undefined]) {
      const bytes = await renderResumeDocx(input)
      expect(unzip(bytes).has('word/document.xml')).toBe(true)
    }
  })

  it('accepts a pre-parsed block model', async () => {
    const viaBlocks = await renderResumeBlocksDocx(parseResumeMarkdown(RESUME), {
      templateId: 'classic',
    })
    expect(unzip(viaBlocks).get('word/document.xml')!.toString('utf8')).toContain(
      'B.S. Computer Science, State University'
    )
  })

  it('reads the authored markdown and template id off a stored version', async () => {
    const bytes = await renderResumeVersionDocx({
      title: 'Tailored — Acme',
      content: 'Jane Doe\njane@example.com',
      content_json: { markdown: '# Jane Doe\n\n## Skills\n\n- Rust', templateId: 'classic' },
    })
    const parts = unzip(bytes)
    expect(parts.get('word/document.xml')!.toString('utf8')).toContain('Rust')
    // classic = serif, which the plain-text `content` fallback could not know.
    expect(parts.get('word/styles.xml')!.toString('utf8')).toContain('Times New Roman')
  })
})

describe('live styles, not a text dump', () => {
  it('uses the built-in Heading styles for section and role headings', async () => {
    const { document } = await open(RESUME, 'modern')
    expect(document).toContain('<w:pStyle w:val="Heading2"/>')
    expect(document).toContain('<w:pStyle w:val="Heading3"/>')
    // The heading text is a plain run — the `##` never leaks into the document.
    expect(document).toContain('SUMMARY')
    expect(document).not.toContain('## ')
  })

  it('defines those heading styles from the template', async () => {
    const modern = await open(RESUME, 'modern')
    const heading2 = styleElement(modern.styles, 'Heading2')!
    expect(heading2).toBeDefined()
    // modern h2: 11pt -> 22 half-points, Arial, accent #1d4ed8, ruled underneath.
    expect(heading2).toContain('<w:sz w:val="22"/>')
    expect(heading2).toContain('w:ascii="Arial"')
    expect(heading2).toContain('<w:color w:val="1D4ED8"/>')
    expect(heading2).toContain('<w:pBdr>')
    // Word's own orphan control, so a heading cannot end a page alone.
    expect(heading2).toContain('<w:keepNext/>')
  })

  it('gives the name and contact lines named styles rather than direct formatting', async () => {
    const { document, styles } = await open(RESUME, 'classic')
    expect(document).toContain('<w:pStyle w:val="ResumeName"/>')
    expect(document).toContain('<w:pStyle w:val="ResumeContact"/>')
    const name = styleElement(styles, 'ResumeName')!
    expect(name).toContain('<w:basedOn w:val="Heading1"/>')
    // classic centres the name at 20pt and rules the block underneath.
    expect(name).toContain('<w:jc w:val="center"/>')
    expect(name).toContain('<w:sz w:val="40"/>')
    expect(styleElement(styles, 'ResumeContact')).toContain('<w:pBdr>')
  })

  it('promotes the first line of an undesigned plain-text resume to the name style', async () => {
    const { document } = await open('Jane Doe\njane@example.com | 555-0100\n\nSUMMARY\n\nDid things.\n')
    expect(document).toContain('<w:pStyle w:val="ResumeName"/>')
    expect(document).toContain('<w:pStyle w:val="ResumeContact"/>')
  })
})

describe('runs', () => {
  it('emits bold and italic as real run properties, not asterisks', async () => {
    const { document } = await open(RESUME, 'modern')
    expect(document).toContain('<w:rPr><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">47 services</w:t>')
    expect(document).toContain('<w:i/>')
    expect(document).not.toContain('**')
    expect(document).not.toContain('`')
  })

  it('renders inline code in the template mono font via a character style', async () => {
    const { document, styles } = await open(RESUME, 'modern')
    expect(document).toContain('<w:rStyle w:val="ResumeCode"/>')
    const code = styleElement(styles, 'ResumeCode')!
    expect(code).toContain('w:ascii="Courier New"')
    expect(code).toContain('w:type="character"')
  })

  it('keeps the author-typed lines of one paragraph together with soft breaks', async () => {
    const { document } = await open('Jane Doe\njane@example.com\n555-0100\n')
    // One paragraph, two <w:br/> — not three paragraphs, and not one run-on line.
    const contact = /<w:pStyle w:val="ResumeContact"\/>[\s\S]*?<\/w:p>/.exec(document)![0]
    expect(contact.match(/<w:br\/>/g)).toHaveLength(1)
    expect(contact).toContain('jane@example.com')
    expect(contact).toContain('555-0100')
  })
})

describe('numbering', () => {
  it('uses real Word numbering for bullets, with the template glyph and indents', async () => {
    const tpl = getTemplate('modern')
    const { document, read } = await open(RESUME, 'modern')
    expect(document).toContain('<w:numPr>')
    expect(document).toContain('<w:ilvl w:val="0"/>')
    expect(document).toContain('<w:ilvl w:val="1"/>') // the nested bullet

    const numbering = read('word/numbering.xml')
    expect(numbering).toContain(`<w:lvlText w:val="${tpl.bullets.glyphs[0]}"/>`)
    expect(numbering).toContain(`<w:lvlText w:val="${tpl.bullets.glyphs[1]}"/>`)
    // Level 0 hangs by hangingIndent; level 1 adds one `indent` on top.
    expect(numbering).toContain(
      `<w:ind w:left="${tpl.bullets.hangingIndent * 20}" w:hanging="${tpl.bullets.hangingIndent * 20}"/>`
    )
    expect(numbering).toContain(
      `<w:ind w:left="${(tpl.bullets.indent + tpl.bullets.hangingIndent) * 20}" w:hanging="${tpl.bullets.hangingIndent * 20}"/>`
    )
    // The glyph is never a literal character in the body text.
    expect(document).not.toContain(`<w:t xml:space="preserve">${tpl.bullets.glyphs[0]}`)
  })

  it('numbers ordered lists with a decimal format on its own numId', async () => {
    const { document, read } = await open(RESUME, 'modern')
    const numbering = read('word/numbering.xml')
    expect(numbering).toContain('<w:numFmt w:val="decimal"/>')
    expect(numbering).toContain('<w:lvlText w:val="%1."/>')
    // Ordered items must not share the bullet numId, or they inherit bullets.
    const ids = [...document.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1])
    expect(new Set(ids).size).toBe(2)
    // ...and the literal "1." from the source is never drawn as text.
    expect(document).not.toContain('<w:t xml:space="preserve">1. ')
  })

  it('restarts a second ordered list at 1 instead of continuing the first', async () => {
    const { document } = await open(
      '# Jane Doe\n\n1. one\n2. two\n\nSome prose.\n\n1. one again\n2. two again\n'
    )
    const ids = [...document.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1])
    // Two distinct ordered numIds means Word restarts the second list.
    expect(new Set(ids).size).toBe(2)
  })
})

describe('links', () => {
  it('creates a real external hyperlink relationship', async () => {
    const { document, read } = await open(RESUME, 'modern')
    const rels = read('word/_rels/document.xml.rels')
    expect(rels).toContain('Target="https://jane.dev"')
    expect(rels).toContain('TargetMode="External"')

    const id = /Id="([^"]+)"[^>]*Target="https:\/\/jane\.dev"/.exec(rels)![1]
    expect(document).toContain(`<w:hyperlink w:history="1" r:id="${id}"`)
    // Only the label is visible; the URL is never pasted next to it.
    expect(document).toContain('portfolio')
    expect(document).not.toContain('<w:t xml:space="preserve">https://jane.dev</w:t>')
  })
})

describe('character handling', () => {
  const HOSTILE = [
    '# Jané Doe™',
    '',
    'Word punctuation: “smart quotes”, an em—dash, an ellipsis…, an emoji 🚀,',
    `an arrow →, a check ✓, 中文 and a zero${'\u200b'}width space.`,
    '',
  ].join('\n')

  it('keeps Unicode intact — .docx is UTF-8, so nothing needs folding', async () => {
    const { document } = await open(HOSTILE, 'modern')
    for (const ch of ['Jané', '™', '“', '”', '—', '…', '🚀', '→', '✓', '中文']) {
      expect(document).toContain(ch)
    }
  })

  it('strips characters that XML cannot carry', async () => {
    const bell = '\u0007'
    const verticalTab = '\u000b'
    const { document } = await open(`# Jane Doe\n\nBell:${bell} and vertical tab:${verticalTab} done.\n`)
    expect(document).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/)
    expect(document).toContain('done.')
  })
})

describe('templates change the document', () => {
  it('gives each shipped template a distinct styles part', async () => {
    const seen = new Set<string>()
    for (const tpl of RESUME_TEMPLATES) {
      const { styles } = await open(RESUME, tpl.id)
      seen.add(styles)
    }
    expect(seen.size).toBe(RESUME_TEMPLATES.length)
  })

  it('changes font, size, colour and alignment between classic and compact', async () => {
    const classic = await open(RESUME, 'classic')
    const compact = await open(RESUME, 'compact')

    expect(classic.styles).toContain('Times New Roman')
    expect(classic.styles).not.toContain('w:ascii="Arial"')
    expect(compact.styles).toContain('w:ascii="Arial"')

    // classic h2 is 11.5pt (23 half-points); compact h2 is 9.5pt (19).
    expect(styleElement(classic.styles, 'Heading2')).toContain('<w:sz w:val="23"/>')
    expect(styleElement(compact.styles, 'Heading2')).toContain('<w:sz w:val="19"/>')

    // classic centres the name; compact left-aligns and upper-cases it.
    expect(styleElement(classic.styles, 'ResumeName')).toContain('<w:jc w:val="center"/>')
    expect(compact.document).toContain('JANE DOE')
    expect(classic.document).toContain('Jane Doe')
  })

  it('omits heading rules for a template that has none', async () => {
    const minimal = await open(RESUME, 'minimal')
    expect(styleElement(minimal.styles, 'Heading2')).not.toContain('<w:pBdr>')
    expect(styleElement(minimal.styles, 'ResumeContact')).not.toContain('<w:pBdr>')
    // ...but modern, which does have them, keeps them.
    const modern = await open(RESUME, 'modern')
    expect(styleElement(modern.styles, 'Heading2')).toContain('<w:pBdr>')
  })
})
