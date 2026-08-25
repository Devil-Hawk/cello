// Resume templates: PURE STYLE DATA. No rendering logic lives here and none
// should — a TemplateSpec is a plain object a renderer reads, which is what
// lets the PDF exporter and the studio preview stay in agreement about what
// "Modern" looks like.
//
// WHY TEMPLATES EXIST AT ALL
//   An uploaded PDF's original visual design cannot be recovered — extraction
//   gives us text, not a layout — and a .txt resume never had one. So the user
//   does not "keep" their design, they CHOOSE one. That is the only honest
//   product answer, and it is strictly better than the status quo where every
//   resume exports as the same wall of wrapped Helvetica.
//
// HARD CONSTRAINT: SINGLE COLUMN. NO TABLES, NO TEXT BOXES, NO IMAGES.
//   Do not "improve" this into a two-column layout with a skills sidebar. It
//   looks great to a human and is notoriously mangled by ATS parsers, which
//   read a PDF's content stream in draw order: a two-column page interleaves
//   the sidebar into the middle of your job history, and the employer's system
//   sees garbage. This entire feature is worthless if the document cannot be
//   parsed by the employer, so the layout budget is spent on typography —
//   type scale, weight, spacing, casing, rules — never on columns. The
//   `columns: 1` literal below is in the type so that adding a second column
//   fails to compile rather than fails in someone's applicant tracking system.
//
// FONT HONESTY
//   pdf-lib can embed the 14 standard PDF fonts without shipping any font
//   files, and nothing else. Naming "Inter" or "Garamond" here would be a lie
//   the renderer could not satisfy. So a template declares a font FAMILY from
//   the standard set, and STANDARD_FONT_NAMES maps family + style to the exact
//   PostScript name pdf-lib's StandardFonts enum uses.

import type { ResumeHeadingLevel } from './markdown'

// ---------------------------------------------------------------------------
// Style primitives
// ---------------------------------------------------------------------------

/** The only font families a standard-14 PDF can use. */
export type StandardFontFamily = 'helvetica' | 'times' | 'courier'

export type FontStyleKey = 'regular' | 'bold' | 'italic' | 'boldItalic'

/**
 * family + style -> the PostScript name pdf-lib's `StandardFonts` enum uses.
 * Exported as data so every renderer maps fonts identically; kept as strings so
 * this module never imports pdf-lib (it is style data, not a renderer).
 * Verified against pdf-lib's enum in templates.test.ts.
 */
export const STANDARD_FONT_NAMES: Record<
  StandardFontFamily,
  Record<FontStyleKey, string>
> = {
  helvetica: {
    regular: 'Helvetica',
    bold: 'Helvetica-Bold',
    italic: 'Helvetica-Oblique',
    boldItalic: 'Helvetica-BoldOblique',
  },
  times: {
    regular: 'Times-Roman',
    bold: 'Times-Bold',
    italic: 'Times-Italic',
    boldItalic: 'Times-BoldItalic',
  },
  courier: {
    regular: 'Courier',
    bold: 'Courier-Bold',
    italic: 'Courier-Oblique',
    boldItalic: 'Courier-BoldOblique',
  },
}

/** Which family each semantic role uses. `mono` renders runs with `code: true`. */
export interface TemplateFonts {
  heading: StandardFontFamily
  body: StandardFontFamily
  mono: StandardFontFamily
}

export type TextCasing = 'none' | 'uppercase'

export type TextAlign = 'left' | 'center'

/** All measurements are PDF points (72pt = 1in). */
export interface PageMargins {
  top: number
  right: number
  bottom: number
  left: number
}

export interface PageSpec {
  /** 612 x 792 = US Letter, the safe default for a US-audience ATS. */
  width: number
  height: number
  margins: PageMargins
  /**
   * Always 1. Typed as a literal so a future "sidebar" edit is a compile error.
   * See the header comment for why this is not negotiable.
   */
  columns: 1
}

/** A drawn horizontal line. Used under headings and for `---` rules. */
export interface RuleSpec {
  thickness: number
  /** Vertical gap between the text above and the line, in points. */
  gap: number
  /** Fraction (0..1) of the text column width the line spans. */
  widthFactor: number
  /** Draw in the accent colour rather than the text colour. */
  accent: boolean
}

export interface HeadingStyle {
  size: number
  bold: boolean
  italic: boolean
  casing: TextCasing
  align: TextAlign
  /** Use the accent colour for the heading text. */
  accent: boolean
  /** Points of blank space above / below the heading. */
  spaceBefore: number
  spaceAfter: number
  /** Rule drawn immediately under the heading, or null for none. */
  rule: RuleSpec | null
}

export interface BodyStyle {
  size: number
  /** Multiplier on `size`, not an absolute leading. */
  lineHeight: number
  /** Extra points between consecutive blocks. */
  paragraphSpacing: number
}

export interface BulletStyle {
  /**
   * Glyph per nesting depth (index 0 = top level); renderers clamp deeper
   * levels to the last entry. Must be encodable by the standard fonts'
   * WinAnsi character set — templates.test.ts asserts exactly that, because an
   * unencodable glyph degrades to '?' in the exported PDF.
   */
  glyphs: string[]
  /** Points of indent added per nesting level. */
  indent: number
  /**
   * Points between the glyph's left edge and the text. Wrapped continuation
   * lines hang to this same offset, so bullet text stays in one visual column.
   */
  hangingIndent: number
  /** Extra points between consecutive items. */
  itemSpacing: number
}

/**
 * The name/contact header. It is not a text box and not a table — just the
 * first heading plus the line(s) under it, given their own treatment.
 */
export interface NameBlockStyle {
  nameSize: number
  nameBold: boolean
  nameCasing: TextCasing
  nameAlign: TextAlign
  nameAccent: boolean
  contactSize: number
  contactAlign: TextAlign
  /** Render contact details in the muted colour. */
  contactMuted: boolean
  /** Rule under the whole name/contact block, or null. */
  rule: RuleSpec | null
  spaceAfter: number
}

export interface TemplateColors {
  /** Body text. Near-black beats pure black in print and stays high contrast. */
  text: string
  /** Secondary text (contact line, dates). */
  muted: string
  /** Used SPARINGLY: rules and section headings only, never body text. */
  accent: string
}

// ---------------------------------------------------------------------------
// TemplateSpec
// ---------------------------------------------------------------------------

export interface TemplateSpec {
  /** Stable, persisted in content_json.templateId. Never rename an id. */
  id: string
  /** Shown in the template picker. */
  name: string
  /** One line describing who the template is for. */
  description: string
  page: PageSpec
  fonts: TemplateFonts
  colors: TemplateColors
  /** Style per heading level; the block model only ever emits 1-3. */
  headings: Record<ResumeHeadingLevel, HeadingStyle>
  nameBlock: NameBlockStyle
  body: BodyStyle
  bullets: BulletStyle
  /** Style for a `---` horizontal rule block. */
  rule: RuleSpec
}

/** Compact shape for a picker UI that does not need the whole spec. */
export interface TemplateSummary {
  id: string
  name: string
  description: string
}

const LETTER = { width: 612, height: 792 } as const

// ---------------------------------------------------------------------------
// Shipped templates
// ---------------------------------------------------------------------------

/**
 * Traditional serif. Centred name, small-caps-feel uppercase sections with a
 * full-width rule, no colour. What a law firm or a university expects.
 */
const CLASSIC: TemplateSpec = {
  id: 'classic',
  name: 'Classic',
  description: 'Traditional serif with centred header and ruled sections.',
  page: { ...LETTER, margins: { top: 72, right: 72, bottom: 72, left: 72 }, columns: 1 },
  fonts: { heading: 'times', body: 'times', mono: 'courier' },
  colors: { text: '#111111', muted: '#444444', accent: '#111111' },
  headings: {
    1: {
      size: 18,
      bold: true,
      italic: false,
      casing: 'none',
      align: 'center',
      accent: false,
      spaceBefore: 0,
      spaceAfter: 6,
      rule: null,
    },
    2: {
      size: 11.5,
      bold: true,
      italic: false,
      casing: 'uppercase',
      align: 'left',
      accent: false,
      spaceBefore: 14,
      spaceAfter: 6,
      rule: { thickness: 0.75, gap: 3, widthFactor: 1, accent: false },
    },
    3: {
      size: 10.5,
      bold: true,
      italic: false,
      casing: 'none',
      align: 'left',
      accent: false,
      spaceBefore: 8,
      spaceAfter: 2,
      rule: null,
    },
  },
  nameBlock: {
    nameSize: 20,
    nameBold: true,
    nameCasing: 'none',
    nameAlign: 'center',
    nameAccent: false,
    contactSize: 9.5,
    contactAlign: 'center',
    contactMuted: true,
    rule: { thickness: 0.75, gap: 8, widthFactor: 1, accent: false },
    spaceAfter: 14,
  },
  body: { size: 10.5, lineHeight: 1.34, paragraphSpacing: 6 },
  bullets: { glyphs: ['•', '–', '·'], indent: 14, hangingIndent: 12, itemSpacing: 2 },
  rule: { thickness: 0.75, gap: 6, widthFactor: 1, accent: false },
}

/**
 * Clean sans with an accent. Left-aligned name, section headings set in the
 * accent colour over an accent rule. The default: reads as current without
 * doing anything an ATS dislikes.
 */
const MODERN: TemplateSpec = {
  id: 'modern',
  name: 'Modern',
  description: 'Clean sans-serif with accent rules under each section.',
  page: { ...LETTER, margins: { top: 54, right: 54, bottom: 54, left: 54 }, columns: 1 },
  fonts: { heading: 'helvetica', body: 'helvetica', mono: 'courier' },
  colors: { text: '#111827', muted: '#4b5563', accent: '#1d4ed8' },
  headings: {
    1: {
      size: 17,
      bold: true,
      italic: false,
      casing: 'none',
      align: 'left',
      accent: false,
      spaceBefore: 0,
      spaceAfter: 6,
      rule: null,
    },
    2: {
      size: 11,
      bold: true,
      italic: false,
      casing: 'uppercase',
      align: 'left',
      accent: true,
      spaceBefore: 16,
      spaceAfter: 7,
      rule: { thickness: 1.25, gap: 4, widthFactor: 1, accent: true },
    },
    3: {
      size: 10.5,
      bold: true,
      italic: false,
      casing: 'none',
      align: 'left',
      accent: false,
      spaceBefore: 9,
      spaceAfter: 3,
      rule: null,
    },
  },
  nameBlock: {
    nameSize: 22,
    nameBold: true,
    nameCasing: 'none',
    nameAlign: 'left',
    nameAccent: false,
    contactSize: 9.5,
    contactAlign: 'left',
    contactMuted: true,
    rule: { thickness: 1.25, gap: 9, widthFactor: 1, accent: true },
    spaceAfter: 15,
  },
  body: { size: 10, lineHeight: 1.36, paragraphSpacing: 6 },
  bullets: { glyphs: ['•', '–', '·'], indent: 13, hangingIndent: 11, itemSpacing: 2.5 },
  rule: { thickness: 1, gap: 6, widthFactor: 1, accent: true },
}

/**
 * Dense. Narrow margins, tight leading, small type, no rules — for the
 * ten-year career that has to fit on one page. Still single column; the space
 * comes from spacing, not from a second column.
 */
const COMPACT: TemplateSpec = {
  id: 'compact',
  name: 'Compact',
  description: 'Dense single page: tight leading and narrow margins.',
  page: { ...LETTER, margins: { top: 40, right: 40, bottom: 40, left: 40 }, columns: 1 },
  fonts: { heading: 'helvetica', body: 'helvetica', mono: 'courier' },
  colors: { text: '#000000', muted: '#333333', accent: '#000000' },
  headings: {
    1: {
      size: 14,
      bold: true,
      italic: false,
      casing: 'none',
      align: 'left',
      accent: false,
      spaceBefore: 0,
      spaceAfter: 3,
      rule: null,
    },
    2: {
      size: 9.5,
      bold: true,
      italic: false,
      casing: 'uppercase',
      align: 'left',
      accent: false,
      spaceBefore: 8,
      spaceAfter: 3,
      rule: { thickness: 0.5, gap: 2, widthFactor: 1, accent: false },
    },
    3: {
      size: 9.5,
      bold: true,
      italic: false,
      casing: 'none',
      align: 'left',
      accent: false,
      spaceBefore: 5,
      spaceAfter: 1,
      rule: null,
    },
  },
  nameBlock: {
    nameSize: 15,
    nameBold: true,
    nameCasing: 'uppercase',
    nameAlign: 'left',
    nameAccent: false,
    contactSize: 8.5,
    contactAlign: 'left',
    contactMuted: false,
    rule: null,
    spaceAfter: 8,
  },
  body: { size: 9, lineHeight: 1.16, paragraphSpacing: 3 },
  bullets: { glyphs: ['•', '-', '·'], indent: 10, hangingIndent: 9, itemSpacing: 0.5 },
  rule: { thickness: 0.5, gap: 3, widthFactor: 1, accent: false },
}

/**
 * Spare. Wide margins, no rules anywhere, muted uppercase section labels,
 * en-dash bullets. Lets a short, strong resume breathe.
 */
const MINIMAL: TemplateSpec = {
  id: 'minimal',
  name: 'Minimal',
  description: 'Spare and airy: wide margins, no rules, muted section labels.',
  page: { ...LETTER, margins: { top: 76, right: 84, bottom: 76, left: 84 }, columns: 1 },
  fonts: { heading: 'helvetica', body: 'helvetica', mono: 'courier' },
  colors: { text: '#1a1a1a', muted: '#6b7280', accent: '#6b7280' },
  headings: {
    1: {
      size: 16,
      bold: false,
      italic: false,
      casing: 'none',
      align: 'left',
      accent: false,
      spaceBefore: 0,
      spaceAfter: 8,
      rule: null,
    },
    2: {
      size: 9,
      bold: false,
      italic: false,
      casing: 'uppercase',
      align: 'left',
      accent: true,
      spaceBefore: 22,
      spaceAfter: 8,
      rule: null,
    },
    3: {
      size: 10.5,
      bold: false,
      italic: true,
      casing: 'none',
      align: 'left',
      accent: false,
      spaceBefore: 12,
      spaceAfter: 3,
      rule: null,
    },
  },
  nameBlock: {
    nameSize: 19,
    nameBold: false,
    nameCasing: 'none',
    nameAlign: 'left',
    nameAccent: false,
    contactSize: 9,
    contactAlign: 'left',
    contactMuted: true,
    rule: null,
    spaceAfter: 22,
  },
  body: { size: 10, lineHeight: 1.5, paragraphSpacing: 9 },
  bullets: { glyphs: ['–', '·', '-'], indent: 16, hangingIndent: 13, itemSpacing: 4 },
  rule: { thickness: 0.5, gap: 10, widthFactor: 0.25, accent: true },
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Ids of the shipped templates. Persisted values — never rename one. */
export type TemplateId = 'classic' | 'modern' | 'compact' | 'minimal'

/**
 * The id used when nothing is stored, and the fallback for an unknown id.
 * "Modern" because it is the least surprising on an undesigned resume.
 */
export const DEFAULT_TEMPLATE_ID: TemplateId = 'modern'

export const RESUME_TEMPLATES: readonly TemplateSpec[] = [CLASSIC, MODERN, COMPACT, MINIMAL]

const BY_ID: Record<TemplateId, TemplateSpec> = {
  classic: CLASSIC,
  modern: MODERN,
  compact: COMPACT,
  minimal: MINIMAL,
}

export function isTemplateId(value: unknown): value is TemplateId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BY_ID, value)
}

/**
 * Look up a template, degrading to the default for anything unrecognised —
 * null, undefined, a typo, or an id from a template we later retire. A stored
 * id must never be able to break a render, so this function does not throw and
 * never returns undefined.
 */
export function getTemplate(id: string | null | undefined): TemplateSpec {
  return isTemplateId(id) ? BY_ID[id] : BY_ID[DEFAULT_TEMPLATE_ID]
}

/** Everything a template picker needs, in display order. */
export function listTemplates(): TemplateSummary[] {
  return RESUME_TEMPLATES.map(({ id, name, description }) => ({ id, name, description }))
}
