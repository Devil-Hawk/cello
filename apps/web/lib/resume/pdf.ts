// Typeset a resume to PDF from the block model in ./markdown, styled entirely
// by a TemplateSpec from ./templates.
//
// WHAT CHANGED AND WHY
//   The previous version of this file took a plain string, wrapped it in
//   Helvetica 10.5 and drew line after line. That is why every resume in this
//   product downloaded looking identical no matter what the user wrote or
//   picked: the exporter had no idea what a heading was, no idea what bold
//   meant, and its styling was a block of `const`s at the top of this file.
//
//   Now: structure comes from `parseResumeMarkdown` (headings, lists, inline
//   emphasis, rules) and every visual decision — page size, margins, font
//   family per role, type sizes, casing, alignment, colour, rules, bullet
//   glyphs, indents, spacing — is read off the TemplateSpec. There are no
//   layout constants in this file that a template could reasonably want to
//   own. Two templates therefore produce visibly different documents from
//   identical Markdown, which is the acceptance test.
//
// STILL ATS-FIRST
//   Single column, no tables, no text boxes, no images, no headless browser.
//   pdf-lib writes the content stream directly and we emit it in reading
//   order, top to bottom, so a parser walking the stream sees the resume in
//   the order a human reads it.
//
// THE THING THAT IS EASY TO GET WRONG
//   pdf-lib's `drawText` takes exactly ONE font, and `widthOfTextAtSize` is a
//   method ON a font. A line like "**Senior Engineer** — Acme" is three
//   different fonts. If you measure the whole line with the regular font and
//   draw it in pieces, the bold piece is wider than you budgeted and the line
//   silently runs past the right margin. So wrapping here is done over TOKENS
//   that each carry their own font, and each token is measured with that font.
//   `pdf.test.ts` asserts the invariant directly.

import {
  PDFDocument,
  PDFName,
  PDFString,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
  type RGB,
} from 'pdf-lib'

import {
  parseResumeMarkdown,
  type ResumeBlock,
  type ResumeHeadingLevel,
  type ResumeInlineLine,
} from './markdown'
import {
  STANDARD_FONT_NAMES,
  getTemplate,
  type FontStyleKey,
  type RuleSpec,
  type StandardFontFamily,
  type TemplateSpec,
  type TextAlign,
  type TextCasing,
} from './templates'
import { getResumeTemplateId, resolveResumeMarkdown, type ResumeContentJson } from './types'

// ---------------------------------------------------------------------------
// Character sanitising
// ---------------------------------------------------------------------------

/**
 * Word- and Google-Docs-authored resumes are full of characters that are not
 * in the standard PDF fonts. This is not a cosmetic concern: pdf-lib THROWS
 * from `drawText` when a glyph is missing from the embedded font's encoding,
 * so one stray arrow or check-mark in a bullet fails the entire download.
 *
 * THE RULE FOR THIS TABLE: it contains ONLY characters the standard-14 fonts
 * genuinely cannot encode (plus two spacing cases noted at the bottom).
 * Curly quotes, en and em dashes, the ellipsis, the bullet and the middle dot
 * ARE encodable and are deliberately absent, so `2021 — Present` and “smarter”
 * export with the author's own typography instead of being flattened to ASCII.
 * `pdf.test.ts` asserts both halves of that: nothing in here is encodable, and
 * an em dash survives a round trip.
 *
 * Whatever survives this table is still checked by `sanitizerFor()` against
 * the specific embedded font's real character set, so an emoji degrades to a
 * '?' rather than throwing.
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

/** Build a sanitizer bound to one embedded font's actual character set. */
function sanitizerFor(font: PDFFont): (text: string) => string {
  const supported = new Set(font.getCharacterSet())
  return (text: string) => {
    let out = ''
    for (const ch of text) {
      const mapped = CHAR_MAP[ch] ?? ch
      for (const mch of mapped) {
        const code = mch.codePointAt(0) ?? 0x3f
        if (supported.has(code)) out += mch
        else if (!isInvisible(code)) out += '?'
      }
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

const FONT_STYLE_KEYS: readonly FontStyleKey[] = ['regular', 'bold', 'italic', 'boldItalic']

/**
 * Every standard font a template can ask for, embedded once and looked up
 * synchronously during layout. Standard-14 fonts carry no font file — pdf-lib
 * ships their metrics — so embedding the eight or twelve a template needs
 * costs nothing at render time and keeps the exported file small.
 */
class FontBook {
  private readonly byName = new Map<string, PDFFont>()
  private readonly sanitizers = new Map<string, (text: string) => string>()

  private constructor(private readonly fallback: PDFFont) {}

  static async embed(doc: PDFDocument, template: TemplateSpec): Promise<FontBook> {
    const families: StandardFontFamily[] = [
      template.fonts.body,
      template.fonts.heading,
      template.fonts.mono,
    ]
    const names = new Set<string>()
    for (const family of families) {
      for (const key of FONT_STYLE_KEYS) names.add(STANDARD_FONT_NAMES[family][key])
    }

    const embedded = new Map<string, PDFFont>()
    for (const name of names) {
      embedded.set(name, await doc.embedFont(name as StandardFonts))
    }

    const fallbackName = STANDARD_FONT_NAMES[template.fonts.body].regular
    const fallback = embedded.get(fallbackName)
    if (!fallback) throw new Error(`resume/pdf: failed to embed ${fallbackName}`)

    const book = new FontBook(fallback)
    for (const [name, font] of embedded) {
      book.byName.set(name, font)
      book.sanitizers.set(name, sanitizerFor(font))
    }
    return book
  }

  get(family: StandardFontFamily, bold: boolean, italic: boolean): PDFFont {
    const key: FontStyleKey =
      bold && italic ? 'boldItalic' : bold ? 'bold' : italic ? 'italic' : 'regular'
    return this.byName.get(STANDARD_FONT_NAMES[family][key]) ?? this.fallback
  }

  sanitize(font: PDFFont, text: string): string {
    const fn = this.sanitizers.get(font.name)
    return fn ? fn(text) : text
  }
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/** `#rgb` / `#rrggbb` -> pdf-lib RGB. Anything unparseable renders as black. */
function parseHex(hex: string): RGB {
  const raw = hex.trim().replace(/^#/, '')
  const full =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return rgb(0, 0, 0)
  return rgb(
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255
  )
}

function sameColor(a: RGB, b: RGB): boolean {
  return a.red === b.red && a.green === b.green && a.blue === b.blue
}

// ---------------------------------------------------------------------------
// Inline layout: tokens -> wrapped lines -> merged draw segments
// ---------------------------------------------------------------------------

/**
 * The ONE ratio in this file that a template does not own: how far below the
 * top of a line box the baseline sits. 0.8em clears the ascender of every
 * standard-14 font (Helvetica 0.718em, Times 0.683em, Courier 0.629em) with
 * room for the odd accented capital, so text never creeps above the top
 * margin. It is a font-metric fact, not a design choice.
 */
const BASELINE_RATIO = 0.8

/** How far below the baseline a descender can reach, for link-annotation boxes. */
const DESCENDER_RATIO = 0.24

interface TextStyle {
  family: StandardFontFamily
  bold: boolean
  italic: boolean
  size: number
  color: RGB
  casing: TextCasing
}

interface Token {
  text: string
  isSpace: boolean
  font: PDFFont
  size: number
  color: RGB
  href?: string
  width: number
}

/** A maximal run of same-font, same-size, same-colour, same-link text. */
interface Segment {
  text: string
  font: PDFFont
  size: number
  color: RGB
  href?: string
  width: number
}

function applyCasing(text: string, casing: TextCasing): string {
  return casing === 'uppercase' ? text.toUpperCase() : text
}

/**
 * Split one authored line into whitespace-delimited tokens, each already bound
 * to the font it will be drawn with. Emphasis inside the run model is OR-ed
 * with the block's own style, so a bold word inside an already-bold heading
 * stays bold rather than flipping back to regular.
 */
function tokenize(
  line: ResumeInlineLine,
  style: TextStyle,
  fonts: FontBook,
  monoFamily: StandardFontFamily
): Token[] {
  const tokens: Token[] = []
  for (const run of line) {
    const family = run.code === true ? monoFamily : style.family
    const font = fonts.get(family, style.bold || run.bold === true, style.italic || run.italic === true)
    const text = fonts.sanitize(font, applyCasing(run.text, style.casing))
    if (!text) continue
    for (const piece of text.split(/(\s+)/)) {
      if (!piece) continue
      const isSpace = /^\s+$/.test(piece)
      tokens.push({
        text: isSpace ? ' ' : piece,
        isSpace,
        font,
        size: style.size,
        color: style.color,
        href: run.href,
        width: font.widthOfTextAtSize(isSpace ? ' ' : piece, style.size),
      })
    }
  }
  return tokens
}

/**
 * Chop a token that is wider than the whole column into pieces that each fit.
 * Without this, one 400-character URL from a pasted resume would draw straight
 * off the right edge of the page (which is what the previous renderer did).
 */
function breakToken(token: Token, maxWidth: number): Token[] {
  const chars = Array.from(token.text)
  const out: Token[] = []
  let start = 0
  while (start < chars.length) {
    let end = start + 1
    let width = token.font.widthOfTextAtSize(chars.slice(start, end).join(''), token.size)
    while (end < chars.length) {
      const next = token.font.widthOfTextAtSize(chars.slice(start, end + 1).join(''), token.size)
      if (next > maxWidth) break
      end += 1
      width = next
    }
    out.push({ ...token, text: chars.slice(start, end).join(''), width })
    start = end
  }
  return out.length > 0 ? out : [token]
}

/** Greedy wrap. Every token is measured with ITS OWN font — see the header. */
function wrapTokens(tokens: readonly Token[], maxWidth: number): Token[][] {
  const lines: Token[][] = []
  let cur: Token[] = []
  let width = 0

  const flush = () => {
    while (cur.length > 0 && cur[cur.length - 1]!.isSpace) {
      width -= cur.pop()!.width
    }
    lines.push(cur)
    cur = []
    width = 0
  }
  const hasInk = () => cur.some((t) => !t.isSpace)

  for (const token of tokens) {
    if (token.isSpace) {
      if (!hasInk()) continue // never start a line with a space
      cur.push(token)
      width += token.width
      continue
    }
    const pieces = token.width > maxWidth ? breakToken(token, maxWidth) : [token]
    for (const piece of pieces) {
      if (width + piece.width > maxWidth && hasInk()) flush()
      cur.push(piece)
      width += piece.width
    }
  }
  flush()
  return lines
}

/**
 * Merge adjacent tokens sharing a style into one drawn segment. This is also
 * what makes the width honest: standard-14 fonts kern, so the width of a drawn
 * segment is measured on the exact string that gets drawn, never assembled
 * from per-character sums.
 */
function toSegments(tokens: readonly Token[]): Segment[] {
  const segments: Segment[] = []
  for (const token of tokens) {
    const last = segments[segments.length - 1]
    if (
      last &&
      last.font === token.font &&
      last.size === token.size &&
      last.href === token.href &&
      sameColor(last.color, token.color)
    ) {
      last.text += token.text
    } else {
      segments.push({
        text: token.text,
        font: token.font,
        size: token.size,
        color: token.color,
        href: token.href,
        width: 0,
      })
    }
  }
  for (const segment of segments) {
    segment.width = segment.font.widthOfTextAtSize(segment.text, segment.size)
  }
  return segments
}

function segmentsWidth(segments: readonly Segment[]): number {
  return segments.reduce((sum, s) => sum + s.width, 0)
}

/** Lay one authored line out into drawable, already-wrapped visual lines. */
function layoutLine(
  line: ResumeInlineLine,
  style: TextStyle,
  fonts: FontBook,
  monoFamily: StandardFontFamily,
  maxWidth: number
): Segment[][] {
  const tokens = tokenize(line, style, fonts, monoFamily)
  return wrapTokens(tokens, Math.max(maxWidth, 1)).map(toSegments)
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RenderResumePdfOptions {
  /**
   * A version label (e.g. "Tailored — Acme"), NOT the candidate's name.
   * Rendered only when the resume does not open with its own name line,
   * because stacking a version label on top of the candidate's name is
   * exactly the "this looks broken" output this rewrite exists to fix.
   */
  title?: string | null
  /** Id from content_json.templateId. Unknown ids degrade via getTemplate(). */
  templateId?: string | null
  /** An explicit spec, which wins over `templateId`. Used by tests and previews. */
  template?: TemplateSpec | null
}

function resolveTemplate(opts: RenderResumePdfOptions): TemplateSpec {
  return opts.template ?? getTemplate(opts.templateId)
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Render resume Markdown (or plain text, which is valid Markdown) to a
 * single-column PDF styled by the chosen template. Returns raw PDF bytes.
 */
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

/** The block-model entry point. Everything above funnels into this. */
export async function renderResumeBlocksPdf(
  blocks: readonly ResumeBlock[],
  opts: RenderResumePdfOptions = {}
): Promise<Uint8Array> {
  const tpl = resolveTemplate(opts)

  const doc = await PDFDocument.create()
  doc.setProducer('Cello')
  doc.setCreator('Cello')

  const fonts = await FontBook.embed(doc, tpl)
  const colors = {
    text: parseHex(tpl.colors.text),
    muted: parseHex(tpl.colors.muted),
    accent: parseHex(tpl.colors.accent),
  }

  const { width: pageW, height: pageH, margins } = tpl.page
  const left = margins.left
  const textWidth = Math.max(pageW - margins.left - margins.right, 1)
  const bottom = margins.bottom
  const top = pageH - margins.top

  let page: PDFPage = doc.addPage([pageW, pageH])
  let y = top // y is the TOP of the next line box, not a baseline

  const newPage = () => {
    page = doc.addPage([pageW, pageH])
    y = top
  }
  const atPageTop = () => y >= top - 0.001
  /** Reserve `height` of vertical space, breaking the page if it will not fit. */
  const ensure = (height: number) => {
    if (y - height < bottom && !atPageTop()) newPage()
  }
  const space = (points: number) => {
    if (points > 0 && !atPageTop()) y -= points
  }

  // --- link annotations -----------------------------------------------------
  // A real /Link annotation, not "text (url)". Reasons, in order:
  //   1. The visible text stays exactly what the author wrote, so the PDF's
  //      text layer matches `resume_documents.content` (which the contract
  //      defines as label-only) — an ATS extracting either sees the same words.
  //   2. Pasting a raw URL beside every link is the single ugliest thing a
  //      resume exporter can do, and these documents are read by humans too.
  // Wrapped in try/catch: a malformed href must never fail a download.
  const addLink = (x: number, baseline: number, width: number, size: number, href: string) => {
    try {
      // Non-ASCII is stripped because PDFString writes its value verbatim and
      // sizes the object by JS string length, which a multi-byte character
      // would make wrong; `\` and parens are escaped for the same reason —
      // pdf-lib explicitly does not escape literal strings for you.
      const url = href.trim().replace(/[^\x20-\x7e]/g, '')
      if (!/^(https?:|mailto:|tel:)/i.test(url)) return
      const escaped = url.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
      const ref = doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [x, baseline - size * DESCENDER_RATIO, x + width, baseline + size * BASELINE_RATIO],
          Border: [0, 0, 0],
          A: { Type: 'Action', S: 'URI', URI: PDFString.of(escaped) },
        })
      )
      const annots = page.node.Annots()
      if (annots) annots.push(ref)
      else page.node.set(PDFName.of('Annots'), doc.context.obj([ref]))
    } catch {
      // A link that cannot be attached is not worth failing the export over.
    }
  }

  // --- primitives -----------------------------------------------------------

  const drawSegments = (segments: readonly Segment[], startX: number, baseline: number) => {
    let x = startX
    for (const segment of segments) {
      if (segment.text.trim().length > 0) {
        page.drawText(segment.text, {
          x,
          y: baseline,
          size: segment.size,
          font: segment.font,
          color: segment.color,
        })
        if (segment.href) addLink(x, baseline, segment.width, segment.size, segment.href)
      }
      x += segment.width
    }
  }

  /**
   * Draw already-wrapped visual lines. Returns nothing; advances `y`.
   * `boxX`/`boxWidth` describe the column the lines are aligned within, which
   * is how bullets get a narrower column than paragraphs without alignment
   * code of their own.
   */
  const drawLines = (
    lines: readonly Segment[][],
    size: number,
    leading: number,
    align: TextAlign,
    boxX: number,
    boxWidth: number,
    onFirstBaseline?: (baseline: number) => void
  ) => {
    let first = true
    for (const segments of lines) {
      ensure(leading)
      const baseline = y - size * BASELINE_RATIO
      const width = segmentsWidth(segments)
      const x = align === 'center' ? boxX + Math.max(0, (boxWidth - width) / 2) : boxX
      // The callback runs BEFORE the text is drawn so a list marker lands in
      // the content stream ahead of its own bullet, not spliced into the
      // middle of it. Content-stream order is the order an ATS reads.
      if (first) {
        onFirstBaseline?.(baseline)
        first = false
      }
      drawSegments(segments, x, baseline)
      y -= leading
    }
  }

  const drawRule = (spec: RuleSpec, align: TextAlign) => {
    const width = textWidth * Math.min(Math.max(spec.widthFactor, 0), 1)
    const height = spec.gap + spec.thickness
    ensure(height)
    const lineY = y - spec.gap - spec.thickness / 2
    const x = align === 'center' ? left + (textWidth - width) / 2 : left
    page.drawLine({
      start: { x, y: lineY },
      end: { x: x + width, y: lineY },
      thickness: spec.thickness,
      color: spec.accent ? colors.accent : colors.text,
    })
    y -= height
  }

  const bodyLeading = tpl.body.size * tpl.body.lineHeight

  const renderInlineLines = (
    lines: readonly ResumeInlineLine[],
    style: TextStyle,
    align: TextAlign,
    boxX: number,
    boxWidth: number
  ) => {
    const leading = style.size * tpl.body.lineHeight
    for (const line of lines) {
      const visual = layoutLine(line, style, fonts, tpl.fonts.mono, boxWidth)
      drawLines(visual, style.size, leading, align, boxX, boxWidth)
    }
  }

  // --- blocks ---------------------------------------------------------------

  /**
   * The name/contact header. The first heading (or, for an undesigned .txt
   * resume, the first short line of the opening paragraph) gets the template's
   * name treatment and the lines under it get the contact treatment. This is
   * what lets a plain-text upload come out looking typeset instead of coming
   * out as an undifferentiated wall — the user's actual complaint.
   */
  const renderNameBlock = (nameLine: ResumeInlineLine, contactLines: readonly ResumeInlineLine[]) => {
    const nb = tpl.nameBlock
    renderInlineLines(
      [nameLine],
      {
        family: tpl.fonts.heading,
        bold: nb.nameBold,
        italic: false,
        size: nb.nameSize,
        color: nb.nameAccent ? colors.accent : colors.text,
        casing: nb.nameCasing,
      },
      nb.nameAlign,
      left,
      textWidth
    )
    if (contactLines.length > 0) {
      renderInlineLines(
        contactLines,
        {
          family: tpl.fonts.body,
          bold: false,
          italic: false,
          size: nb.contactSize,
          color: nb.contactMuted ? colors.muted : colors.text,
          casing: 'none',
        },
        nb.contactAlign,
        left,
        textWidth
      )
    }
    if (nb.rule) drawRule(nb.rule, nb.nameAlign)
    space(nb.spaceAfter)
  }

  const renderHeading = (level: ResumeHeadingLevel, lines: readonly ResumeInlineLine[]) => {
    const h = tpl.headings[level]
    space(h.spaceBefore)

    // Cheap orphan control: if the heading plus two body lines will not fit,
    // start the page here rather than leaving the heading stranded at the foot.
    const ruleHeight = h.rule ? h.rule.gap + h.rule.thickness : 0
    const needed =
      lines.length * h.size * tpl.body.lineHeight + ruleHeight + h.spaceAfter + bodyLeading * 2
    if (y - needed < bottom && !atPageTop()) newPage()

    renderInlineLines(
      lines,
      {
        family: tpl.fonts.heading,
        bold: h.bold,
        italic: h.italic,
        size: h.size,
        color: h.accent ? colors.accent : colors.text,
        casing: h.casing,
      },
      h.align,
      left,
      textWidth
    )
    if (h.rule) drawRule(h.rule, h.align)
    space(h.spaceAfter)
  }

  const bodyStyle: TextStyle = {
    family: tpl.fonts.body,
    bold: false,
    italic: false,
    size: tpl.body.size,
    color: colors.text,
    casing: 'none',
  }

  const renderParagraph = (lines: readonly ResumeInlineLine[]) => {
    renderInlineLines(lines, bodyStyle, 'left', left, textWidth)
    space(tpl.body.paragraphSpacing)
  }

  const renderList = (block: Extract<ResumeBlock, { type: 'list' }>) => {
    const b = tpl.bullets
    const markerFont = fonts.get(tpl.fonts.body, false, false)
    block.items.forEach((item, index) => {
      if (index > 0) space(b.itemSpacing)

      // Clamp so that a pathologically deep list still leaves a readable column.
      const indent = Math.min(item.depth * b.indent, Math.max(textWidth - b.hangingIndent - 40, 0))
      const textX = left + indent + b.hangingIndent
      const boxWidth = Math.max(textWidth - indent - b.hangingIndent, 1)

      const glyph = item.ordered
        ? `${item.marker ?? index + 1}.`
        : b.glyphs[Math.min(item.depth, b.glyphs.length - 1)] ?? '•'
      const marker = fonts.sanitize(markerFont, glyph)

      let markerDrawn = false
      for (const line of item.lines) {
        const visual = layoutLine(line, bodyStyle, fonts, tpl.fonts.mono, boxWidth)
        drawLines(visual, bodyStyle.size, bodyLeading, 'left', textX, boxWidth, (baseline) => {
          if (markerDrawn) return
          markerDrawn = true
          page.drawText(marker, {
            x: left + indent,
            y: baseline,
            size: bodyStyle.size,
            font: markerFont,
            color: colors.text,
          })
        })
      }
    })
    space(tpl.body.paragraphSpacing)
  }

  // --- document -------------------------------------------------------------

  const list = [...blocks]
  const header = splitResumeHeader(list)

  // Version label, only when the document has no name line of its own —
  // stacking "Tailored — Acme" on top of "Jane Doe" is exactly the kind of
  // output this rewrite exists to stop producing.
  const title = opts.title?.trim()
  if (title && !header.name) {
    renderInlineLines(
      [[{ text: title }]],
      {
        family: tpl.fonts.heading,
        bold: tpl.nameBlock.nameBold,
        italic: false,
        size: tpl.headings[2].size,
        color: colors.muted,
        casing: tpl.headings[2].casing,
      },
      'left',
      left,
      textWidth
    )
    space(tpl.body.paragraphSpacing)
  }

  if (header.name) renderNameBlock(header.name, header.contact)

  for (let index = header.bodyStart; index < list.length; index += 1) {
    const block = list[index]!
    switch (block.type) {
      case 'heading':
        renderHeading(block.level, block.lines)
        break
      case 'paragraph':
        renderParagraph(block.lines)
        break
      case 'list':
        renderList(block)
        break
      case 'rule':
        drawRule(tpl.rule, 'left')
        space(tpl.body.paragraphSpacing)
        break
    }
  }

  return doc.save()
}

// ---------------------------------------------------------------------------
// Header detection (shared with the DOCX exporter)
// ---------------------------------------------------------------------------

export interface ResumeHeaderSplit {
  /** The line to set in the template's name treatment, or null for none. */
  name: ResumeInlineLine | null
  /** The line(s) to set in the contact treatment. */
  contact: ResumeInlineLine[]
  /** Index of the first block that is NOT part of the header. */
  bodyStart: number
}

/**
 * Decide which leading blocks form the name/contact header.
 *
 * Exported and imported by docx.ts rather than duplicated, because the two
 * exporters MUST agree: if one promoted a line to the name treatment and the
 * other did not, the same resume would look like two different documents
 * depending on which download button the user pressed. That is the whole class
 * of bug this feature exists to remove, so a shared import is worth docx.ts
 * pulling this module in.
 *
 * Two shapes are recognised:
 *   - authored Markdown: `# Jane Doe` followed by a contact paragraph;
 *   - an undesigned .txt/.docx upload, where "Jane Doe\njane@example.com" is
 *     ONE paragraph with a soft break — its first line is promoted to the name
 *     when it looks like a name.
 */
export function splitResumeHeader(blocks: readonly ResumeBlock[]): ResumeHeaderSplit {
  const none: ResumeHeaderSplit = { name: null, contact: [], bodyStart: 0 }
  const head = blocks[0]
  if (!head) return none

  if (head.type === 'heading' && head.level === 1 && head.lines.length > 0) {
    const next = blocks[1]
    const contactLines = next && next.type === 'paragraph' ? next.lines : []
    return {
      name: head.lines[0]!,
      contact: [...head.lines.slice(1), ...contactLines],
      bodyStart: contactLines.length > 0 ? 2 : 1,
    }
  }

  if (head.type === 'paragraph' && head.lines.length > 0 && isNameLike(head.lines[0]!)) {
    return { name: head.lines[0]!, contact: head.lines.slice(1), bodyStart: 1 }
  }

  return none
}

/**
 * Is this opening line plausibly a person's name rather than the first line of
 * a summary paragraph? Deliberately conservative — getting it wrong the other
 * way sets a sentence in 22pt. A name is short, has few words, and does not
 * end in sentence punctuation.
 */
function isNameLike(line: ResumeInlineLine): boolean {
  const text = line
    .map((run) => run.text)
    .join('')
    .trim()
  if (text.length === 0 || text.length > 64) return false
  if (/[.!?,;:]$/.test(text)) return false
  return text.split(/\s+/).length <= 8
}
