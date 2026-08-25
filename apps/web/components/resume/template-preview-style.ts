// Turns a TemplateSpec (pure print data, in POINTS) into the CSS the on-screen
// preview needs — and nothing else. No React, no DOM, so the arithmetic is
// unit-testable.
//
// WHY DERIVE THE PREVIEW FROM THE SAME SPEC THE PDF USES
//   The bug this feature exists to fix is a preview that lies: the studio
//   showed a textarea while the export showed something else. If the preview
//   carried its own hand-written CSS it would drift from the exporter the first
//   time anyone touched a template. Every number below comes out of
//   lib/resume/templates.ts, so adding a template makes the preview change with
//   it and there is nothing to keep in sync by hand.
//
// SCALE, AND WHY IT IS ONE NUMBER
//   Templates measure in PDF points (72pt = 1in). PREVIEW_PX_PER_PT converts
//   points to CSS pixels, and it is applied to EVERYTHING — type sizes, margins,
//   rules, bullet indents, page width. One factor keeps every proportion the
//   exporter will produce: a 22pt name is exactly 2.2x a 10pt bullet on screen
//   just as it is on paper. It is deliberately not 96/72: the sheet then fits
//   the studio's column at full width, where 1.333 would force it to shrink and
//   break that proportionality against the surrounding UI.
//
// WHAT THE PREVIEW STILL CANNOT PROMISE
//   Page breaks, and the exact line-wrap points of the standard PDF fonts
//   (the browser substitutes Arial/Liberation for Helvetica). Structure,
//   hierarchy, order, rules, bullets and density are all faithful; "will this
//   fit on one page" is not — that answer only exists once pdf-lib lays it out.

import type { CSSProperties } from 'react'
import type {
  HeadingStyle,
  RuleSpec,
  StandardFontFamily,
  TemplateColors,
  TemplateSpec,
} from '@/lib/resume/templates'
import type { ResumeHeadingLevel } from '@/lib/resume/markdown'

/** CSS pixels per PDF point for the on-screen sheet. See the header comment. */
export const PREVIEW_PX_PER_PT = 1.2

/**
 * Browser stacks for the three standard PDF families. pdf-lib embeds the base
 * PostScript fonts (Helvetica/Times-Roman/Courier); a browser almost never has
 * those exact files, so each stack lists the metric-compatible substitutes a
 * Mac, a Windows box and a Linux box respectively actually ship. The generic
 * family at the end is what guarantees the *category* (serif vs sans vs mono)
 * survives even when every named face is missing — that category is the part
 * of the template the preview must not get wrong.
 */
export const PREVIEW_FONT_STACKS: Record<StandardFontFamily, string> = {
  helvetica: 'Helvetica, Arial, "Liberation Sans", "Helvetica Neue", sans-serif',
  times: '"Times New Roman", Times, "Liberation Serif", Georgia, serif',
  courier: '"Courier New", Courier, "Liberation Mono", monospace',
}

/** Points -> a CSS px string, rounded to hundredths so React does not churn. */
export function pt(points: number): string {
  return `${Math.round(points * PREVIEW_PX_PER_PT * 100) / 100}px`
}

function colorFor(style: { accent: boolean }, colors: TemplateColors): string {
  return style.accent ? colors.accent : colors.text
}

/** A drawn rule becomes a bottom border on the element above it. */
function ruleStyle(rule: RuleSpec | null, colors: TemplateColors): CSSProperties {
  if (!rule) return {}
  return {
    borderBottom: `${pt(rule.thickness)} solid ${rule.accent ? colors.accent : colors.text}`,
    paddingBottom: pt(rule.gap),
    // widthFactor 1 is the common case; MINIMAL's `---` rule is a short 25% mark.
    width: rule.widthFactor >= 1 ? '100%' : `${Math.round(rule.widthFactor * 1000) / 10}%`,
  }
}

function headingStyle(style: HeadingStyle, spec: TemplateSpec): CSSProperties {
  return {
    fontFamily: PREVIEW_FONT_STACKS[spec.fonts.heading],
    fontSize: pt(style.size),
    fontWeight: style.bold ? 700 : 400,
    fontStyle: style.italic ? 'italic' : 'normal',
    textTransform: style.casing === 'uppercase' ? 'uppercase' : 'none',
    // Uppercase section labels are unreadable at 9pt without tracking; this is
    // the one place the preview adds something the PDF renderer does per-glyph.
    letterSpacing: style.casing === 'uppercase' ? '0.06em' : 'normal',
    textAlign: style.align,
    color: colorFor(style, spec.colors),
    marginTop: pt(style.spaceBefore),
    marginBottom: pt(style.spaceAfter),
    lineHeight: 1.25,
    ...ruleStyle(style.rule, spec.colors),
  }
}

/** Every style the preview renderer applies, all derived from one TemplateSpec. */
export interface ResumePreviewStyles {
  /** The white sheet: page width, margins, body font, text colour. */
  page: CSSProperties
  /** The name line (nameBlock, not headings[1]) — what the exporter draws first. */
  name: CSSProperties
  /** The contact line(s) under the name. */
  contact: CSSProperties
  /** The block wrapping name + contact, carrying the header rule and its space. */
  header: CSSProperties
  headings: Record<ResumeHeadingLevel, CSSProperties>
  paragraph: CSSProperties
  list: CSSProperties
  /** A `---` horizontal rule block. */
  rule: CSSProperties
  /** Custom properties the static stylesheet reads (bullets, indents, gaps). */
  vars: CSSProperties
}

/**
 * The full style set for a template. Pure: same spec in, same styles out, so a
 * caller can memoise on the spec object.
 */
export function resumePreviewStyles(spec: TemplateSpec): ResumePreviewStyles {
  const { colors, page, body, bullets, nameBlock } = spec
  const bodyFont = PREVIEW_FONT_STACKS[spec.fonts.body]

  const vars: Record<string, string> = {
    '--rp-mono': PREVIEW_FONT_STACKS[spec.fonts.mono],
    '--rp-indent': pt(bullets.indent),
    '--rp-hang': pt(bullets.hangingIndent),
    '--rp-item-gap': pt(bullets.itemSpacing),
    '--rp-para-gap': pt(body.paragraphSpacing),
    '--rp-muted': colors.muted,
  }
  // Glyph per nesting depth; deeper levels clamp to the last entry, matching
  // the renderer contract in templates.ts. Quoted because CSS `content` needs
  // a string token, and these arrive from the registry, never from user text.
  const glyphs = bullets.glyphs.length > 0 ? bullets.glyphs : ['•']
  for (let depth = 0; depth < 3; depth += 1) {
    vars[`--rp-bullet-${depth}`] = `"${glyphs[Math.min(depth, glyphs.length - 1)]}"`
  }

  return {
    page: {
      maxWidth: pt(page.width),
      paddingTop: pt(page.margins.top),
      paddingRight: pt(page.margins.right),
      paddingBottom: pt(page.margins.bottom),
      paddingLeft: pt(page.margins.left),
      fontFamily: bodyFont,
      fontSize: pt(body.size),
      lineHeight: body.lineHeight,
      color: colors.text,
    },
    name: {
      fontFamily: PREVIEW_FONT_STACKS[spec.fonts.heading],
      fontSize: pt(nameBlock.nameSize),
      fontWeight: nameBlock.nameBold ? 700 : 400,
      textTransform: nameBlock.nameCasing === 'uppercase' ? 'uppercase' : 'none',
      letterSpacing: nameBlock.nameCasing === 'uppercase' ? '0.06em' : 'normal',
      textAlign: nameBlock.nameAlign,
      color: nameBlock.nameAccent ? colors.accent : colors.text,
      lineHeight: 1.2,
    },
    contact: {
      fontSize: pt(nameBlock.contactSize),
      textAlign: nameBlock.contactAlign,
      color: nameBlock.contactMuted ? colors.muted : colors.text,
      marginTop: pt(3),
      lineHeight: 1.35,
    },
    header: {
      marginBottom: pt(nameBlock.spaceAfter),
      ...ruleStyle(nameBlock.rule, colors),
    },
    headings: {
      1: headingStyle(spec.headings[1], spec),
      2: headingStyle(spec.headings[2], spec),
      3: headingStyle(spec.headings[3], spec),
    },
    paragraph: { marginBottom: pt(body.paragraphSpacing) },
    list: { marginBottom: pt(body.paragraphSpacing), marginLeft: pt(bullets.indent) },
    rule: {
      border: 'none',
      marginTop: pt(spec.rule.gap),
      marginBottom: pt(spec.rule.gap),
      ...ruleStyle(spec.rule, colors),
      paddingBottom: 0,
    },
    vars: vars as CSSProperties,
  }
}

// ---------------------------------------------------------------------------
// name / contact header
// ---------------------------------------------------------------------------

/**
 * The header a resume opens with, split out of the document body.
 *
 * WHY SPLIT AT ALL
 *   A template's `nameBlock` is not "heading level 1 with different numbers" —
 *   it has its own size, alignment, rule and a muted contact line, and the PDF
 *   renderer applies it to the document's opening block. If the preview rendered
 *   that block as an ordinary h1 it would show 17pt where the export shows 22pt
 *   over an accent rule. Splitting here (rather than sniffing the first node
 *   mid-render) keeps it deterministic and testable.
 */
export interface ResumeHeaderSplit {
  /** The name line, with any leading `# ` removed. Null when the document does not open with one. */
  name: string | null
  /** Contact lines joined with Markdown hard breaks, or null. */
  contact: string | null
  /** Everything after the header — the document to render normally. */
  body: string
}

/** A line that opens a block which is definitely NOT a name. */
const NON_NAME_OPENER =
  /^(#{2,6}[ \t]|[-*+][ \t]|\d+[.)][ \t]|>|```|~~~|\||(-{3,}|\*{3,}|_{3,})\s*$)/

/**
 * A name is short. A pasted paragraph of prose that happens to sit first would
 * otherwise be set at 22pt across the top of the page.
 */
const MAX_NAME_LENGTH = 60

export function splitResumeHeader(markdown: string | null | undefined): ResumeHeaderSplit {
  const source = (markdown ?? '').replace(/\r\n?/g, '\n')
  const lines = source.split('\n')

  let first = 0
  while (first < lines.length && lines[first].trim().length === 0) first += 1
  if (first >= lines.length) return { name: null, contact: null, body: source }

  const head = lines[first]
  const isH1 = /^#[ \t]/.test(head)
  if (!isH1) {
    if (NON_NAME_OPENER.test(head.trimStart())) return { name: null, contact: null, body: source }
    if (head.trim().length > MAX_NAME_LENGTH) return { name: null, contact: null, body: source }
  }

  const name = head.replace(/^#[ \t]+/, '').trim()
  if (!name) return { name: null, contact: null, body: source }

  // Contact lines: the rest of this block. An h1 ends its own block, so the
  // contact lines are whatever non-blank lines follow it before the next blank
  // line or the next block opener.
  const contactLines: string[] = []
  let cursor = first + 1
  while (cursor < lines.length) {
    const line = lines[cursor]
    if (line.trim().length === 0) break
    if (/^#{1,6}[ \t]/.test(line.trimStart())) break
    if (NON_NAME_OPENER.test(line.trimStart())) break
    contactLines.push(line.trim())
    cursor += 1
  }

  const rest = lines.slice(cursor).join('\n').replace(/^\n+/, '')
  return {
    name,
    // Two trailing spaces is a Markdown hard break, so multi-line contact
    // details stay on their own lines instead of being reflowed into one.
    contact: contactLines.length > 0 ? contactLines.join('  \n') : null,
    body: rest,
  }
}
