// Typeset a resume to PDF from the block model in ./markdown, styled entirely
// by a TemplateSpec from ./templates, with @react-pdf/renderer.
//
// Structure comes from `parseResumeMarkdown` (headings, lists, inline emphasis,
// rules) and every visual decision (page size, margins, font family per role,
// type sizes, casing, alignment, colour, rules, bullet glyphs, indents, spacing)
// is read off the TemplateSpec. Two templates produce visibly different
// documents from identical Markdown.
//
// ATS first: single column, no tables, no text boxes, no images. react-pdf
// draws in tree order, so a parser walking the page reads the resume in the
// order a person does. Fonts are the standard-14 families, so no font file is
// embedded and the file stays small.

import { createElement as h, type ComponentProps, type ReactElement } from 'react'
import type { DocumentProps } from '@react-pdf/renderer'

import { parseResumeMarkdown, splitResumeHeader, type ResumeBlock, type ResumeInlineLine } from './markdown'
import { resolveResumeMarkdown } from './resolve'
import {
  STANDARD_FONT_NAMES,
  getTemplate,
  type RuleSpec,
  type StandardFontFamily,
  type TemplateSpec,
  type TextAlign,
  type TextCasing,
} from './templates'
import { getResumeTemplateId, type ResumeContentJson } from './types'

// ---------------------------------------------------------------------------
// Character sanitising
// ---------------------------------------------------------------------------

/**
 * Word- and Google-Docs-authored resumes are full of characters that are not
 * in the standard PDF fonts. A glyph the font cannot draw is lost or garbled in
 * the text an employer's parser reads, so each one is folded to something the
 * font can draw (an arrow to `->`) before it reaches the page.
 *
 * THE RULE FOR THIS TABLE: it contains ONLY characters the standard-14 fonts
 * genuinely cannot encode (plus two spacing cases noted at the bottom).
 * Curly quotes, en and em dashes, the ellipsis, the bullet and the middle dot
 * ARE encodable and are deliberately absent, so `2021 — Present` and “smarter”
 * export with the author's own typography instead of being flattened to ASCII.
 * `pdf.test.ts` asserts that an em dash survives a round trip.
 *
 * Whatever survives this table is still checked by `sanitize()` against WinAnsi,
 * the encoding of the standard fonts, so an emoji degrades to a '?'.
 */
const CHAR_MAP: Record<string, string> = {
  // Quotes and primes with no standard-font glyph
  '‛': "'", // single high-reversed-9
  '′': "'", // prime
  '‟': '"', // double high-reversed-9
  '″': '"', // double prime
  // Dashes with no standard-font glyph (en/em dash are encodable — see above)
  '‐': '-', // hyphen
  '‑': '-', // non-breaking hyphen
  '‒': '-', // figure dash
  '―': '-', // horizontal bar
  '−': '-', // minus sign
  '﹘': '-',
  '﹣': '-',
  '－': '-', // fullwidth hyphen-minus
  // Bullet-ish glyphs people paste out of Word's list styles
  '●': '•',
  '○': '•',
  '▪': '•',
  '▫': '•',
  '■': '•',
  '▸': '•',
  '▶': '•',
  '‣': '•',
  '⁃': '•',
  '∙': '•',
  '➢': '•',
  '➤': '•',
  '❖': '•',
  '◦': '·',
  '⋅': '·',
  // Marks that show up in skills and certification lists
  '✓': '-', // check
  '✔': '-',
  '✗': 'x',
  '✘': 'x',
  '★': '*', // star
  '☆': '*',
  '✧': '*',
  // Arrows and maths, common in impact bullets ("2s -> 200ms")
  '→': '->',
  '←': '<-',
  '↔': '<->',
  '⇒': '=>',
  '⇐': '<=',
  '≥': '>=',
  '≤': '<=',
  '≠': '!=',
  '≈': '~',
  '∞': 'inf',
  // Ligatures a PDF-to-text extractor leaves behind, and misc symbols
  'ﬀ': 'ff',
  'ﬁ': 'fi',
  'ﬂ': 'fl',
  'ﬃ': 'ffi',
  'ﬄ': 'ffl',
  '⁄': '/', // fraction slash
  '№': 'No.',
  // Exotic spaces. Written as escapes on purpose: they are invisible in
  // source, and a duplicated literal key would be a silent no-op, not an error.
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ', // em space
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ', // figure space
  ' ': ' ',
  ' ': ' ', // thin space
  ' ': ' ',
  ' ': ' ', // narrow no-break space
  ' ': ' ',
  '　': ' ', // ideographic space
  '​': '', // zero-width space
  '‌': '',
  '‍': '',
  '⁠': '', // word joiner
  '﻿': '', // BOM
  // The two entries below fold characters that ARE encodable. Both are about
  // layout, not encoding: a no-break space would make "New York, NY" one
  // unbreakable token for the wrapper, and a soft hyphen would draw a real
  // hyphen mid-word because this renderer does not hyphenate.
  ' ': ' ',
  '­': '',
  '\t': '    ',
  '\v': ' ',
  '\f': ' ',
}

/** Codepoints we drop silently rather than turning into a visible '?'. */
function isInvisible(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) || // combining marks
    (code >= 0x200b && code <= 0x200f) || // zero-width / bidi
    (code >= 0x202a && code <= 0x202e) || // bidi overrides
    (code >= 0xfe00 && code <= 0xfe0f) || // variation selectors
    code < 0x20 // stray control characters
  )
}

/** The WinAnsi block at 0x80 to 0x9F, as Unicode: the euro, the curly quotes, the dashes, the bullet and the rest. */
const WIN_ANSI_HIGH = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
])

/** True for the characters the standard fonts can draw: ASCII, Latin-1 and the block above. */
function encodable(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_HIGH.has(code)
}

/** Folds what the standard fonts cannot draw to something they can, or to a '?'. */
function sanitize(text: string): string {
  let out = ''
  for (const ch of text) {
    for (const mch of CHAR_MAP[ch] ?? ch) {
      if (encodable(mch)) out += mch
      else if (!isInvisible(mch.codePointAt(0) ?? 0x3f)) out += '?'
    }
  }
  return out
}

/**
 * A word wider than a whole line (a pasted 400-character address) is cut into line-sized pieces on
 * their own lines, so nothing runs off the page and no character is lost or added.
 * ponytail: the piece length assumes an average glyph width of 0.62em; measure with the font's
 * metrics if an all-capitals word ever overflows.
 */
function chunkLong(text: string, max: number): string {
  return text.replace(/\S+/gu, (word) => (word.length > max ? (word.match(new RegExp(`.{1,${max}}`, 'gu')) ?? [word]).join('\n') : word))
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RenderResumePdfOptions {
  /**
   * A version label (e.g. "Tailored for Acme"), NOT the candidate's name.
   * Rendered only when the resume does not open with its own name line,
   * because stacking a version label on top of the candidate's name is
   * exactly the "this looks broken" output this exporter exists to avoid.
   */
  title?: string | null
  /** Id from content_json.templateId. Unknown ids degrade via getTemplate(). */
  templateId?: string | null
  /** An explicit spec, which wins over `templateId`. Used by tests and previews. */
  template?: TemplateSpec | null
}

/** Render resume Markdown (or plain text, which is valid Markdown) to a single-column PDF. */
export async function renderResumePdf(
  source: string | null | undefined,
  opts: RenderResumePdfOptions = {}
): Promise<Uint8Array> {
  return renderResumeBlocksPdf(parseResumeMarkdown(source), opts)
}

/**
 * Convenience for callers holding a resume_documents row: reads the authored
 * Markdown and the stored template id through the persistence contract, so no
 * call site has to remember that `content` is the derived plain text and
 * `content_json.markdown` is the authored source.
 */
export async function renderResumeVersionPdf(
  doc: { content: string; content_json: ResumeContentJson | null; title?: string | null },
  opts: RenderResumePdfOptions = {}
): Promise<Uint8Array> {
  return renderResumePdf(resolveResumeMarkdown(doc), {
    title: doc.title ?? null,
    templateId: getResumeTemplateId(doc.content_json),
    ...opts,
  })
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

type Pdf = typeof import('@react-pdf/renderer')
type Sty = NonNullable<ComponentProps<Pdf['View']>['style']>

/** Only these schemes become a clickable link: a malformed or odd href is plain text instead. */
const SAFE_HREF = /^(https?:|mailto:|tel:)/i

/**
 * The document as react-pdf elements, built from the block model and styled entirely by the
 * TemplateSpec. Single column, no tables, no images: react-pdf draws in tree order, so a parser
 * walking the page reads the resume in the order a person does.
 */
function buildDocument(pdf: Pdf, blocks: readonly ResumeBlock[], tpl: TemplateSpec, title: string | null): ReactElement<DocumentProps> {
  const { Document, Link, Page, Text, View } = pdf
  const font = (family: StandardFontFamily, bold: boolean, italic: boolean) =>
    STANDARD_FONT_NAMES[family][bold && italic ? 'boldItalic' : bold ? 'bold' : italic ? 'italic' : 'regular']

  interface Style {
    family: StandardFontFamily
    bold: boolean
    italic: boolean
    size: number
    color: string
    casing: TextCasing
    align: TextAlign
  }

  /** One authored line as a block of text. Emphasis, code and links are nested runs. */
  const line = (runs: ResumeInlineLine, s: Style, width = column): ReactElement | null => {
    const parts = runs.flatMap((run) => {
      const text = chunkLong(sanitize(s.casing === 'uppercase' ? run.text.toUpperCase() : run.text), Math.max(8, Math.floor(width / (s.size * 0.62))))
      if (!text) return []
      const style = { fontFamily: font(run.code ? tpl.fonts.mono : s.family, s.bold || run.bold === true, s.italic || run.italic === true) } as Sty
      // A link keeps the template's colour, with no underline: the address is never printed beside it.
      const linkStyle = { ...style, color: s.color, textDecoration: 'none' } as Sty
      return [run.href && SAFE_HREF.test(run.href.trim()) ? h(Link, { src: run.href.trim(), style: linkStyle }, text) : h(Text, { style }, text)]
    })
    if (parts.length === 0) return null
    const style = { fontFamily: font(s.family, s.bold, s.italic), fontSize: s.size, lineHeight: tpl.body.lineHeight, color: s.color, textAlign: s.align } as Sty
    return h(Text, { style }, ...parts)
  }

  const lines = (all: readonly ResumeInlineLine[], s: Style, width = column) => all.map((l) => line(l, s, width)).filter((x): x is ReactElement => x !== null)

  const rule = (spec: RuleSpec, align: TextAlign) =>
    h(View, {
      style: {
        marginTop: spec.gap,
        width: `${Math.round(Math.min(Math.max(spec.widthFactor, 0), 1) * 100)}%`,
        alignSelf: align === 'center' ? 'center' : 'flex-start',
        borderBottomWidth: spec.thickness,
        borderBottomColor: spec.accent ? tpl.colors.accent : tpl.colors.text,
      } as Sty,
    })

  const column = tpl.page.width - tpl.page.margins.left - tpl.page.margins.right
  const body: Style = { family: tpl.fonts.body, bold: false, italic: false, size: tpl.body.size, color: tpl.colors.text, casing: 'none', align: 'left' }
  const bodyLeading = tpl.body.size * tpl.body.lineHeight
  const children: ReactElement[] = []

  const list = [...blocks]
  const header = splitResumeHeader(list)

  if (title && !header.name) {
    const h2 = tpl.headings[2]
    children.push(
      h(View, { style: { marginBottom: tpl.body.paragraphSpacing } as Sty }, ...lines([[{ text: title }]], { family: tpl.fonts.heading, bold: tpl.nameBlock.nameBold, italic: false, size: h2.size, color: tpl.colors.muted, casing: h2.casing, align: 'left' }))
    )
  }

  if (header.name) {
    const nb = tpl.nameBlock
    children.push(
      h(
        View,
        { style: { marginBottom: nb.spaceAfter } as Sty },
        ...lines([header.name], { family: tpl.fonts.heading, bold: nb.nameBold, italic: false, size: nb.nameSize, color: nb.nameAccent ? tpl.colors.accent : tpl.colors.text, casing: nb.nameCasing, align: nb.nameAlign }),
        ...lines(header.contact, { family: tpl.fonts.body, bold: false, italic: false, size: nb.contactSize, color: nb.contactMuted ? tpl.colors.muted : tpl.colors.text, casing: 'none', align: nb.contactAlign }),
        ...(nb.rule ? [rule(nb.rule, nb.nameAlign)] : [])
      )
    )
  }

  for (const block of list.slice(header.bodyStart)) {
    if (block.type === 'heading') {
      const hs = tpl.headings[block.level]
      children.push(
        h(
          // A heading never stands alone at the foot of a page: it stays with the next lines.
          View,
          { minPresenceAhead: bodyLeading * 2, style: { marginTop: hs.spaceBefore, marginBottom: hs.spaceAfter } as Sty },
          ...lines(block.lines, { family: tpl.fonts.heading, bold: hs.bold, italic: hs.italic, size: hs.size, color: hs.accent ? tpl.colors.accent : tpl.colors.text, casing: hs.casing, align: hs.align }),
          ...(hs.rule ? [rule(hs.rule, hs.align)] : [])
        )
      )
    } else if (block.type === 'paragraph') {
      children.push(h(View, { style: { marginBottom: tpl.body.paragraphSpacing } as Sty }, ...lines(block.lines, body)))
    } else if (block.type === 'list') {
      const b = tpl.bullets
      const items = block.items.map((item, index) => {
        // Clamp so that a pathologically deep list still leaves a readable column.
        const indent = Math.min(item.depth * b.indent, Math.max(column - b.hangingIndent - 40, 0))
        const glyph = item.ordered ? `${item.marker ?? index + 1}.` : (b.glyphs[Math.min(item.depth, b.glyphs.length - 1)] ?? '•')
        return h(
          View,
          { style: { flexDirection: 'row', marginLeft: indent, marginTop: index > 0 ? b.itemSpacing : 0 } as Sty },
          h(View, { style: { width: b.hangingIndent } as Sty }, line([{ text: glyph }], body)),
          h(View, { style: { flex: 1 } as Sty }, ...lines(item.lines, body, column - indent - b.hangingIndent))
        )
      })
      children.push(h(View, { style: { marginBottom: tpl.body.paragraphSpacing } as Sty }, ...items))
    } else {
      children.push(h(View, { style: { marginBottom: tpl.body.paragraphSpacing } as Sty }, rule(tpl.rule, 'left')))
    }
  }

  const m = tpl.page.margins
  const page = h(
    Page,
    {
      size: [tpl.page.width, tpl.page.height] as [number, number],
      style: { paddingTop: m.top, paddingRight: m.right, paddingBottom: m.bottom, paddingLeft: m.left, fontFamily: font(tpl.fonts.body, false, false), fontSize: tpl.body.size, color: tpl.colors.text } as Sty,
    },
    ...children
  )
  return h(Document, { creator: 'Cello', producer: 'Cello', ...(title ? { title } : {}) }, page) as ReactElement<DocumentProps>
}

let hyphenationOff = false

/** The block-model entry point. Everything above funnels into this. */
export async function renderResumeBlocksPdf(
  blocks: readonly ResumeBlock[],
  opts: RenderResumePdfOptions = {}
): Promise<Uint8Array> {
  // Loaded here, not at the top: yoga and fontkit are heavy and only an export needs them.
  const pdf = await import('@react-pdf/renderer')
  if (!hyphenationOff) {
    // A hyphenated word reads back as two, so the text an employer's parser sees would differ from the resume.
    pdf.Font.registerHyphenationCallback((word) => [word])
    hyphenationOff = true
  }
  const tpl = opts.template ?? getTemplate(opts.templateId)
  return new Uint8Array(await pdf.renderToBuffer(buildDocument(pdf, blocks, tpl, opts.title?.trim() || null)))
}
