// Export the resume block model to a REAL .docx, styled by a TemplateSpec.
//
// WHY .docx AT ALL
//   A large share of applicant tracking systems parse Word documents more
//   reliably than PDFs — a .docx already IS structured text, so there is no
//   content-stream reading-order guesswork. Several ATS ask for .doc/.docx
//   explicitly. And a recruiter who wants to tweak a line can, which is a
//   thing recruiters genuinely do.
//
// WHAT "REAL" MEANS HERE
//   Not a text dump inside a Word wrapper. Structure is expressed the way Word
//   expresses it, so the file is editable with LIVE STYLES:
//     - headings use the built-in Heading 1/2/3 styles, redefined from the
//       template, so they show up in the Styles pane and in the navigation
//       pane, and changing the style restyles every section at once;
//     - bold / italic / code are real run properties, not asterisks;
//     - bullets and numbers are real w:numPr numbering with real indents and
//       hanging indents, so pressing Tab in Word demotes a bullet properly;
//     - links are real external hyperlink relationships;
//     - the name and contact lines get named paragraph styles of their own
//       (Resume Name / Resume Contact) rather than direct formatting;
//     - the page size, margins, type sizes, colours, bullet glyphs and rules
//       all come from the same TemplateSpec the PDF renderer uses, so the two
//       exports describe the same document.
//
// UNITS. OOXML measures in three different things and mixing them up is the
// classic bug: twips (1/20 pt) for page geometry, indents and spacing;
// half-points for font size; eighths of a point for border thickness.
//
// FONTS. pdf-lib can only embed the standard-14 PostScript families; Word
// needs a font that exists on the reader's machine. Helvetica is not installed
// on Windows, so it maps to Arial — its metric-compatible substitute, which is
// also what every Word-on-Windows install does with a Helvetica request
// anyway. The two exports therefore look the same, rather than one of them
// silently falling back to Calibri.

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  LineRuleType,
  Packer,
  Paragraph,
  TextRun,
  UnderlineType,
  type IBaseParagraphStyleOptions,
  type ILevelsOptions,
  type INumberingOptions,
  type IParagraphOptions,
  type IRunOptions,
  type ParagraphChild,
} from 'docx'

import {
  parseResumeMarkdown,
  type ResumeBlock,
  type ResumeHeadingLevel,
  type ResumeInlineLine,
  type ResumeListBlock,
} from './markdown'
import { splitResumeHeader } from './pdf'
import {
  getTemplate,
  type HeadingStyle,
  type RuleSpec,
  type StandardFontFamily,
  type TemplateSpec,
  type TextAlign,
  type TextCasing,
} from './templates'
import { getResumeTemplateId, resolveResumeMarkdown, type ResumeContentJson } from './types'

// ---------------------------------------------------------------------------
// Units and small conversions
// ---------------------------------------------------------------------------

/** PDF points -> twips (twentieths of a point), OOXML's geometry unit. */
const twip = (points: number): number => Math.round(points * 20)

/** PDF points -> half-points, OOXML's font-size unit. */
const halfPoint = (points: number): number => Math.max(1, Math.round(points * 2))

/** PDF points -> eighths of a point, OOXML's border-thickness unit (2..96). */
const eighthPoint = (points: number): number =>
  Math.min(96, Math.max(2, Math.round(points * 8)))

/**
 * Line spacing as a MULTIPLE. With lineRule="auto", w:line is measured in
 * 240ths of a line, so 240 is single spacing and 240 * 1.36 is the Modern
 * template's leading. Using the multiple rather than an exact height means
 * Word still lays the line out correctly if the reader's font substitutes.
 */
const lineMultiple = (lineHeight: number): number => Math.round(240 * lineHeight)

/** Word wants bare hex. Also tolerates a stored `#rgb`. */
function hex(color: string): string {
  const raw = color.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return raw
      .split('')
      .map((c) => c + c)
      .join('')
      .toUpperCase()
  }
  return /^[0-9a-fA-F]{6}$/.test(raw) ? raw.toUpperCase() : '000000'
}

/**
 * Standard-14 family -> a font name that actually exists on a reader's
 * machine. See the header for why Helvetica becomes Arial.
 */
const WORD_FONT: Record<StandardFontFamily, string> = {
  helvetica: 'Arial',
  times: 'Times New Roman',
  courier: 'Courier New',
}

function alignment(align: TextAlign) {
  return align === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT
}

/**
 * XML 1.0 forbids most control characters outright and a lone surrogate makes
 * the whole package unopenable, so both are stripped. That is the ONLY
 * filtering needed here: unlike the PDF renderer there is no WinAnsi encoding
 * to fold onto, because .docx is UTF-8. Smart quotes, em dashes, accents and
 * everything else a Word-authored resume is full of pass through exactly as
 * the author typed them.
 */
function sanitize(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1')
}

function applyCasing(text: string, casing: TextCasing): string {
  return casing === 'uppercase' ? text.toUpperCase() : text
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** Character style carrying the template's mono font, for `code` runs. */
const CODE_STYLE_ID = 'ResumeCode'
const HYPERLINK_STYLE_ID = 'Hyperlink'
const NAME_STYLE_ID = 'ResumeName'
const CONTACT_STYLE_ID = 'ResumeContact'
const RULE_STYLE_ID = 'ResumeRule'
const BULLET_NUMBERING = 'resume-bullets'

/**
 * Lower one authored line's inline runs to Word runs. Emphasis is set only
 * when the run asks for it — never explicitly set to `false` — so a bold word
 * inside an already-bold heading style stays bold instead of being knocked
 * back to regular by the direct formatting.
 */
function lineToChildren(line: ResumeInlineLine, casing: TextCasing): ParagraphChild[] {
  const children: ParagraphChild[] = []
  for (const run of line) {
    const text = sanitize(applyCasing(run.text, casing))
    if (!text) continue
    const options: IRunOptions = {
      text,
      ...(run.bold === true ? { bold: true } : {}),
      ...(run.italic === true ? { italics: true } : {}),
      ...(run.code === true ? { style: CODE_STYLE_ID } : {}),
    }
    if (run.href) {
      children.push(
        new ExternalHyperlink({
          children: [new TextRun({ ...options, style: HYPERLINK_STYLE_ID })],
          link: run.href,
        })
      )
    } else {
      children.push(new TextRun(options))
    }
  }
  return children
}

/**
 * Several authored lines become ONE paragraph joined by soft breaks, matching
 * the block model's rule that a renderer wraps lines but never joins them. A
 * plain-text contact block stays one paragraph with two visual lines, exactly
 * as the author typed it.
 */
function linesToChildren(
  lines: readonly ResumeInlineLine[],
  casing: TextCasing = 'none'
): ParagraphChild[] {
  const children: ParagraphChild[] = []
  lines.forEach((line) => {
    const runs = lineToChildren(line, casing)
    if (runs.length === 0) return
    if (children.length > 0) children.push(new TextRun({ break: 1 }))
    children.push(...runs)
  })
  return children
}

// ---------------------------------------------------------------------------
// Styles built from the template
// ---------------------------------------------------------------------------

function borderFromRule(rule: RuleSpec, tpl: TemplateSpec) {
  return {
    bottom: {
      style: BorderStyle.SINGLE,
      size: eighthPoint(rule.thickness),
      // w:space is in points: the gap between the text and the line.
      space: Math.max(0, Math.round(rule.gap)),
      color: hex(rule.accent ? tpl.colors.accent : tpl.colors.text),
    },
  }
}

function headingStyle(h: HeadingStyle, tpl: TemplateSpec): IBaseParagraphStyleOptions {
  return {
    run: {
      font: WORD_FONT[tpl.fonts.heading],
      size: halfPoint(h.size),
      bold: h.bold,
      italics: h.italic,
      color: hex(h.accent ? tpl.colors.accent : tpl.colors.text),
    },
    paragraph: {
      alignment: alignment(h.align),
      spacing: {
        before: twip(h.spaceBefore),
        after: twip(h.spaceAfter),
        line: lineMultiple(tpl.body.lineHeight),
        lineRule: LineRuleType.AUTO,
      },
      // Word's own orphan control: never leave a section heading alone at the
      // foot of a page. Cheaper and more reliable than measuring, which is why
      // the PDF renderer has to do it by hand and this one does not.
      keepNext: true,
      keepLines: true,
      ...(h.rule ? { border: borderFromRule(h.rule, tpl) } : {}),
    },
  }
}

/**
 * One numbering config per list flavour. Bullets share a single definition
 * (they never need to restart); every ORDERED list block gets its own
 * reference so that a second numbered list starts again at 1 instead of
 * continuing the first one — Word's default behaviour otherwise.
 */
function numberingFor(tpl: TemplateSpec, orderedReferences: readonly string[]): INumberingOptions {
  const { glyphs, indent, hangingIndent } = tpl.bullets
  const levels = (format: 'bullet' | 'decimal'): ILevelsOptions[] =>
    Array.from({ length: 5 }, (_unused, level) => ({
      level,
      format: format === 'bullet' ? LevelFormat.BULLET : LevelFormat.DECIMAL,
      text: format === 'bullet' ? (glyphs[Math.min(level, glyphs.length - 1)] ?? '•') : `%${level + 1}.`,
      alignment: AlignmentType.LEFT,
      style: {
        run: { font: WORD_FONT[tpl.fonts.body], color: hex(tpl.colors.text) },
        paragraph: {
          indent: {
            left: twip(level * indent + hangingIndent),
            hanging: twip(hangingIndent),
          },
        },
      },
    }))

  return {
    config: [
      { reference: BULLET_NUMBERING, levels: levels('bullet') },
      ...orderedReferences.map((reference) => ({ reference, levels: levels('decimal') })),
    ],
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RenderResumeDocxOptions {
  /** Document title metadata (Word's File > Info). Never drawn on the page. */
  title?: string | null
  /** Id from content_json.templateId. Unknown ids degrade via getTemplate(). */
  templateId?: string | null
  /** An explicit spec, which wins over `templateId`. */
  template?: TemplateSpec | null
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/** Render resume Markdown (or plain text) to .docx bytes. */
export async function renderResumeDocx(
  source: string | null | undefined,
  opts: RenderResumeDocxOptions = {}
): Promise<Uint8Array> {
  return renderResumeBlocksDocx(parseResumeMarkdown(source), opts)
}

/** Convenience for callers holding a resume_documents row. */
export async function renderResumeVersionDocx(
  doc: { content: string; content_json: ResumeContentJson | null; title?: string | null },
  opts: RenderResumeDocxOptions = {}
): Promise<Uint8Array> {
  return renderResumeDocx(resolveResumeMarkdown(doc), {
    title: doc.title ?? null,
    templateId: getResumeTemplateId(doc.content_json),
    ...opts,
  })
}

/** The block-model entry point. */
export async function renderResumeBlocksDocx(
  blocks: readonly ResumeBlock[],
  opts: RenderResumeDocxOptions = {}
): Promise<Uint8Array> {
  const tpl = opts.template ?? getTemplate(opts.templateId)
  const nb = tpl.nameBlock
  const textWidth = tpl.page.width - tpl.page.margins.left - tpl.page.margins.right

  const list = [...blocks]
  const children: Paragraph[] = []

  // Every ordered list block needs its own numbering definition; collect them
  // up front because numbering must be declared when the Document is built.
  const orderedReferences: string[] = []
  const orderedReferenceFor = new Map<number, string>()
  list.forEach((block, index) => {
    if (block.type === 'list' && block.items.some((item) => item.ordered)) {
      const reference = `resume-ordered-${index}`
      orderedReferences.push(reference)
      orderedReferenceFor.set(index, reference)
    }
  })

  const push = (options: IParagraphOptions) => {
    children.push(new Paragraph(options))
  }

  // --- name / contact header -----------------------------------------------
  // `splitResumeHeader` is imported from the PDF renderer rather than
  // reimplemented, so the two exports can never disagree about which line is
  // the candidate's name — see its doc comment.
  const header = splitResumeHeader(list)
  if (header.name) {
    push({ style: NAME_STYLE_ID, children: linesToChildren([header.name], nb.nameCasing) })
    if (header.contact.length > 0) {
      push({ style: CONTACT_STYLE_ID, children: linesToChildren(header.contact) })
    }
  }

  const HEADING_FOR_LEVEL: Record<ResumeHeadingLevel, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
  }

  const emitList = (block: ResumeListBlock, blockIndex: number) => {
    const orderedReference = orderedReferenceFor.get(blockIndex)
    for (const item of block.items) {
      const runs = linesToChildren(item.lines)
      if (runs.length === 0) continue
      push({
        numbering: {
          reference:
            item.ordered && orderedReference ? orderedReference : BULLET_NUMBERING,
          level: Math.min(item.depth, 4),
        },
        spacing: { after: twip(tpl.bullets.itemSpacing) },
        children: runs,
      })
    }
  }

  for (let index = header.bodyStart; index < list.length; index += 1) {
    const block = list[index]!
    switch (block.type) {
      case 'heading': {
        const runs = linesToChildren(block.lines, tpl.headings[block.level].casing)
        if (runs.length > 0) push({ heading: HEADING_FOR_LEVEL[block.level], children: runs })
        break
      }
      case 'paragraph': {
        const runs = linesToChildren(block.lines)
        if (runs.length > 0) push({ children: runs })
        break
      }
      case 'list':
        emitList(block, index)
        break
      case 'rule':
        // A paragraph whose only content is a bottom border. `widthFactor` is
        // approximated with a right indent, because a Word paragraph border
        // always spans the paragraph's own width.
        push({
          style: RULE_STYLE_ID,
          indent: { right: twip(textWidth * (1 - Math.min(Math.max(tpl.rule.widthFactor, 0), 1))) },
          children: [],
        })
        break
    }
  }

  // A section with no children produces a corrupt package.
  if (children.length === 0) children.push(new Paragraph({ children: [] }))

  const document = new Document({
    creator: 'Cello',
    title: opts.title?.trim() || undefined,
    numbering: numberingFor(tpl, orderedReferences),
    styles: {
      default: {
        document: {
          run: {
            font: WORD_FONT[tpl.fonts.body],
            size: halfPoint(tpl.body.size),
            color: hex(tpl.colors.text),
          },
          paragraph: {
            spacing: {
              after: twip(tpl.body.paragraphSpacing),
              line: lineMultiple(tpl.body.lineHeight),
              lineRule: LineRuleType.AUTO,
            },
          },
        },
        heading1: headingStyle(tpl.headings[1], tpl),
        heading2: headingStyle(tpl.headings[2], tpl),
        heading3: headingStyle(tpl.headings[3], tpl),
      },
      paragraphStyles: [
        {
          id: NAME_STYLE_ID,
          name: 'Resume Name',
          basedOn: 'Heading1',
          next: 'Normal',
          quickFormat: true,
          run: {
            font: WORD_FONT[tpl.fonts.heading],
            size: halfPoint(nb.nameSize),
            bold: nb.nameBold,
            color: hex(nb.nameAccent ? tpl.colors.accent : tpl.colors.text),
          },
          paragraph: {
            alignment: alignment(nb.nameAlign),
            spacing: { before: 0, after: 0, line: lineMultiple(tpl.body.lineHeight), lineRule: LineRuleType.AUTO },
            keepNext: true,
          },
        },
        {
          id: CONTACT_STYLE_ID,
          name: 'Resume Contact',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: {
            font: WORD_FONT[tpl.fonts.body],
            size: halfPoint(nb.contactSize),
            color: hex(nb.contactMuted ? tpl.colors.muted : tpl.colors.text),
          },
          paragraph: {
            alignment: alignment(nb.contactAlign),
            spacing: { after: twip(nb.spaceAfter), line: lineMultiple(tpl.body.lineHeight), lineRule: LineRuleType.AUTO },
            ...(nb.rule ? { border: borderFromRule(nb.rule, tpl) } : {}),
          },
        },
        {
          id: RULE_STYLE_ID,
          name: 'Resume Rule',
          basedOn: 'Normal',
          next: 'Normal',
          paragraph: {
            spacing: { before: twip(tpl.rule.gap), after: twip(tpl.body.paragraphSpacing) },
            border: borderFromRule(tpl.rule, tpl),
          },
        },
      ],
      characterStyles: [
        {
          id: CODE_STYLE_ID,
          name: 'Resume Code',
          basedOn: 'DefaultParagraphFont',
          quickFormat: true,
          run: { font: WORD_FONT[tpl.fonts.mono] },
        },
        {
          id: HYPERLINK_STYLE_ID,
          name: 'Hyperlink',
          basedOn: 'DefaultParagraphFont',
          run: {
            color: hex(tpl.colors.accent),
            underline: { type: UnderlineType.SINGLE },
          },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: twip(tpl.page.width), height: twip(tpl.page.height) },
            margin: {
              top: twip(tpl.page.margins.top),
              right: twip(tpl.page.margins.right),
              bottom: twip(tpl.page.margins.bottom),
              left: twip(tpl.page.margins.left),
            },
          },
        },
        children,
      },
    ],
  })

  const buffer = await Packer.toBuffer(document)
  return new Uint8Array(buffer)
}
