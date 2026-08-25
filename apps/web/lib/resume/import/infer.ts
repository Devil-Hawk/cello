// Deterministic plain-text -> resume Markdown inference.
//
// THE CASE THIS EXISTS FOR
//   A .txt resume, or the text unpdf pulls out of a PDF, carries NO structure:
//   no headings, no bold, no list semantics — just lines. Something has to
//   decide which lines are sections and which are bullets, or the studio opens
//   an unstructured blob and every template renders the same grey wall of text.
//   That decision is made HERE, with rules, so that a user with no LLM key
//   still gets a structured document. The LLM path (./llm.ts) produces a better
//   guess; it does not produce the ONLY guess.
//
// THE ONE RULE THIS MODULE OBEYS
//   It never invents, deletes or rewrites words. Every transformation is
//   syntactic: adding `## `, adding `- `, wrapping in `**`, escaping a
//   character that Markdown would otherwise eat. Two exceptions, both
//   deliberate and both word-preserving:
//     - page furniture ("Page 2 of 3") is dropped, because it is an artifact of
//       pagination and not something the candidate wrote;
//     - a line that is ONLY a date range is joined onto the line above it with
//       ' — ', because PDF extraction routinely breaks "Acme Corp" and
//       "2019 – 2023" onto separate lines and they are one role line.
//   Everything else survives verbatim, which is what makes it safe to run this
//   as the fallback when an LLM's output fails its faithfulness check.
//
// WHY NOT MORE CLEVERNESS
//   Every additional heuristic buys a little structure and risks mangling a
//   resume that does not match it. So the bar for a rule here is: it must be
//   wrong rarely, and when it IS wrong the result must still be readable. The
//   rules that did not clear that bar (bolding a short line before a bullet run
//   because it is "probably a company", bolding `Label:` prefixes in a skills
//   section) are deliberately absent.

/** Section names recognised regardless of casing or isolation. */
const SECTION_TITLES: ReadonlySet<string> = new Set([
  // Summary-ish
  'SUMMARY', 'PROFESSIONAL SUMMARY', 'EXECUTIVE SUMMARY', 'CAREER SUMMARY',
  'SUMMARY OF QUALIFICATIONS', 'QUALIFICATIONS', 'PROFILE', 'PROFESSIONAL PROFILE',
  'OBJECTIVE', 'CAREER OBJECTIVE', 'ABOUT', 'ABOUT ME', 'HIGHLIGHTS',
  // Experience
  'EXPERIENCE', 'WORK EXPERIENCE', 'WORK HISTORY', 'PROFESSIONAL EXPERIENCE',
  'RELEVANT EXPERIENCE', 'ADDITIONAL EXPERIENCE', 'EMPLOYMENT', 'EMPLOYMENT HISTORY',
  'CAREER HISTORY', 'INDUSTRY EXPERIENCE', 'EXPERIENCE HIGHLIGHTS', 'CONSULTING EXPERIENCE',
  'TEACHING EXPERIENCE', 'RESEARCH EXPERIENCE', 'MILITARY SERVICE',
  // Education
  'EDUCATION', 'EDUCATION AND TRAINING', 'ACADEMIC BACKGROUND', 'ACADEMICS',
  'COURSEWORK', 'RELEVANT COURSEWORK', 'TRAINING',
  // Skills
  'SKILLS', 'TECHNICAL SKILLS', 'CORE SKILLS', 'KEY SKILLS', 'SKILLS AND TOOLS',
  'CORE COMPETENCIES', 'COMPETENCIES', 'TECHNOLOGIES', 'TECHNICAL PROFICIENCIES',
  'TOOLS AND TECHNOLOGIES', 'AREAS OF EXPERTISE',
  // Work product
  'PROJECTS', 'SELECTED PROJECTS', 'PERSONAL PROJECTS', 'SIDE PROJECTS', 'PORTFOLIO',
  'PUBLICATIONS', 'PATENTS', 'PRESENTATIONS', 'TALKS', 'SPEAKING', 'RESEARCH',
  // Credentials
  'CERTIFICATIONS', 'CERTIFICATIONS AND LICENSES', 'LICENSES AND CERTIFICATIONS',
  'CERTIFICATES', 'LICENSES',
  // Recognition
  'AWARDS', 'HONORS', 'AWARDS AND HONORS', 'HONORS AND AWARDS', 'ACHIEVEMENTS',
  'KEY ACHIEVEMENTS', 'ACCOMPLISHMENTS',
  // Everything else
  'LANGUAGES', 'INTERESTS', 'HOBBIES', 'VOLUNTEER', 'VOLUNTEER EXPERIENCE',
  'COMMUNITY INVOLVEMENT', 'LEADERSHIP', 'ACTIVITIES', 'EXTRACURRICULAR ACTIVITIES',
  'AFFILIATIONS', 'PROFESSIONAL AFFILIATIONS', 'MEMBERSHIPS', 'REFERENCES',
  'CONTACT', 'CONTACT INFORMATION', 'ADDITIONAL INFORMATION',
])

/** Bullet glyphs seen in the wild, plus ASCII `-`/`*`/`+` and the dashes. */
const BULLET_PREFIX = /^([\u2022\u00b7\u25aa\u25cf\u25cb\u2023\u2219\u25e6\u25a0\u25b8\u2043\u2013\u2014*+-])[ \t]+(.*)$/
/** `1.` / `1)` / `(1)` ordered markers. */
const ORDERED_PREFIX = /^\(?(\d{1,2})[.)][ \t]+(.*)$/
/** A line of only dashes/underscores/equals — a typed-out horizontal rule. */
const RULE_LINE = /^[-=_\u2013\u2014*\u2500\u2501]{3,}$/
/** Page furniture left behind by PDF extraction. */
const PAGE_NOISE = [
  /^page[ \t]+\d+([ \t]+(of|\/)[ \t]*\d+)?$/i,
  /^\d+[ \t]*(of|\/)[ \t]*\d+$/i,
  /^[-\u2013\u2014][ \t]*\d{1,3}[ \t]*[-\u2013\u2014]$/,
]

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?'
const YEAR = '(?:19|20)\\d{2}'
const SEP = '[ \\t]*(?:-|\\u2013|\\u2014|to|through|until|\\u2192)[ \\t]*'
const POINT = `(?:${MONTH}[ \\t]*['\u2019]?\\d{2,4}|\\d{1,2}[/.]${YEAR}|${YEAR})`
const OPEN_END = '(?:present|current|now|today|ongoing|date)'

/** "Mar 2019 – Present", "2019-2023", "03/2019 to 12/2021". */
const DATE_RANGE = new RegExp(`${POINT}${SEP}(?:${POINT}|${OPEN_END})`, 'i')

/**
 * True when the line is NOTHING but a date range (plus punctuation). Anything
 * with words left over — "Senior Engineer, Acme (2019 – 2023)" — is a role
 * line in its own right and must not be folded into the line above it.
 */
function isDateOnlyLine(text: string): boolean {
  if (!DATE_RANGE.test(text)) return false
  const rest = text.replace(DATE_RANGE, ' ').replace(/[()[\]|,;:.\u2013\u2014-]/g, ' ').trim()
  return rest.length === 0
}

/**
 * Escape the characters Markdown would otherwise consume. Resumes are full of
 * them: `first_last@example.com` becomes italic text without this, and `C++`
 * or `[1]` citations misparse. The escapes cost nothing downstream —
 * markdownToPlainText() parses the Markdown, so `\_` renders back as `_` in the
 * text an ATS reads.
 */
export function escapeInlineMarkdown(text: string): string {
  return text
    .replace(/([\\`*_[\]~])/g, '\\$1')
    .replace(/^(\s*)(#{1,6})(\s|$)/, '$1\\$2$3')
    .replace(/^(\s*)>/, '$1\\>')
    // A leading "2019." would otherwise open an ordered list numbered 2019.
    .replace(/^(\s*)(\d{1,9})([.)])(\s)/, '$1$2\\$3$4')
}

/** Normalize a heading candidate for vocabulary lookup. */
function normalizeTitle(text: string): string {
  return text
    .replace(/&/g, ' AND ')
    .toUpperCase()
    .replace(/[^A-Z ]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/** Strip trailing colons and leading/trailing decoration ("--- SKILLS ---"). */
function stripHeadingDecoration(text: string): string {
  return text
    .replace(/^[\s\-=_*\u2013\u2014\u2500\u2501]+/, '')
    .replace(/[\s\-=_*\u2013\u2014\u2500\u2501]+$/, '')
    .replace(/[:\uff1a]\s*$/, '')
    .trim()
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/**
 * A person's name: a short run of letters with no email, URL, digit or pipe in
 * it, and not one of the section titles. Only ever tested against the FIRST
 * content line, so a "Skills" line further down cannot be mistaken for a name.
 */
export function isLikelyName(text: string): boolean {
  if (text.length > 60 || text.length < 2) return false
  if (!/^[A-Za-z][A-Za-z .,'\u2019-]*$/.test(text)) return false
  const words = wordCount(text)
  if (words < 1 || words > 6) return false
  return !SECTION_TITLES.has(normalizeTitle(text))
}

/**
 * True when the line is one of the resume section names we recognise, ignoring
 * casing, a trailing colon and decoration. Exported because the .docx path
 * needs the same vocabulary: a Word file that used bold text instead of a
 * Heading style still has "EXPERIENCE" on a line of its own, and promoting that
 * to a real heading uses the document's own words, not an invented structure.
 */
export function isKnownSectionTitle(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false
  const stripped = stripHeadingDecoration(text)
  return stripped.length > 0 && SECTION_TITLES.has(normalizeTitle(stripped))
}

/** ALL-CAPS (or vocabulary-matching) standalone line -> `## ` section. */
function isSectionHeading(text: string, isolated: boolean): boolean {
  const stripped = stripHeadingDecoration(text)
  if (!stripped) return false
  if (SECTION_TITLES.has(normalizeTitle(stripped))) return true
  if (!isolated) return false
  // ALL-CAPS heuristic: short, shouty, no sentence punctuation, has letters.
  if (!/[A-Z]/.test(stripped)) return false
  if (stripped !== stripped.toUpperCase()) return false
  if (stripped.length > 40 || wordCount(stripped) > 5) return false
  if (/[.,;!?]$/.test(stripped)) return false
  if (DATE_RANGE.test(stripped)) return false
  return true
}

// --- the intermediate document -------------------------------------------
//
// Lines are collected into blocks BEFORE serialising, so that a date-only line
// can still reach back and join the role line above it, and so that a run of
// adjacent lines (a name/contact block) stays one paragraph with its line
// structure intact rather than becoming N paragraphs.

interface ParaBlock { kind: 'para'; lines: string[] }
interface HeadingBlock { kind: 'heading'; level: 1 | 2; text: string }
interface ListItem { depth: number; ordered: boolean; marker: number; text: string }
interface ListBlock { kind: 'list'; items: ListItem[] }
interface RuleBlock { kind: 'rule' }
type Block = ParaBlock | HeadingBlock | ListBlock | RuleBlock

const BOLD = /^\*\*(.*)\*\*$/

function bold(text: string): string {
  const inner = BOLD.exec(text)
  return `**${inner ? inner[1] : text}**`
}

function unbold(text: string): string {
  const inner = BOLD.exec(text)
  return inner ? inner[1] : text
}

/** Normalize the messy realities of extracted text before any rule runs. */
function normalizeSourceText(raw: string): string[] {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/\f/g, '\n\n') // PDF page break -> paragraph break
    .replace(/[\u00a0\u2007\u202f]/g, ' ') // non-breaking spaces
    .replace(/[\u200b-\u200d\ufeff]/g, '') // zero-width junk
    .replace(/\t/g, '    ')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
}

/**
 * Infer resume Markdown from undesigned plain text.
 *
 * Emits `# Name`, `## Section`, `**Role line with dates**`, `- bullets` and
 * paragraphs — the same subset lib/resume/markdown.ts models and the templates
 * render. Total: any string in, Markdown out; empty input yields ''.
 */
export function inferResumeMarkdown(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) return ''

  const lines = normalizeSourceText(raw)
  const blocks: Block[] = []
  let sawContent = false
  /** Indent of the first bullet in the current run, for nesting depth. */
  let bulletBaseIndent: number | null = null
  /** True when the previous source line was blank (or this is the start). */
  let precededByBlank = true

  const last = (): Block | undefined => blocks[blocks.length - 1]

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    const text = rawLine.trim()

    if (!text) {
      precededByBlank = true
      bulletBaseIndent = null
      continue
    }

    if (PAGE_NOISE.some((re) => re.test(text))) {
      // Page furniture: drop it, but do not let it glue the blocks either side
      // of a page break together.
      precededByBlank = true
      bulletBaseIndent = null
      continue
    }

    const indent = rawLine.length - rawLine.trimStart().length

    // --- name (first content line only) ---
    if (!sawContent) {
      sawContent = true
      if (isLikelyName(text) && !BULLET_PREFIX.test(text)) {
        blocks.push({ kind: 'heading', level: 1, text: escapeInlineMarkdown(text) })
        precededByBlank = false
        continue
      }
    }
    sawContent = true

    // --- typed-out horizontal rule ---
    if (RULE_LINE.test(text)) {
      blocks.push({ kind: 'rule' })
      precededByBlank = true
      bulletBaseIndent = null
      continue
    }

    // --- bullets ---
    const bulletMatch = BULLET_PREFIX.exec(text)
    const orderedMatch = bulletMatch ? null : ORDERED_PREFIX.exec(text)
    if (bulletMatch || orderedMatch) {
      const body = (bulletMatch ? bulletMatch[2] : orderedMatch![2]).trim()
      if (body) {
        if (bulletBaseIndent === null) bulletBaseIndent = indent
        const delta = indent - bulletBaseIndent
        const depth = delta >= 7 ? 2 : delta >= 3 ? 1 : 0
        const item: ListItem = {
          depth,
          ordered: Boolean(orderedMatch),
          marker: orderedMatch ? Number(orderedMatch[1]) : 1,
          text: escapeInlineMarkdown(body),
        }
        const tail = last()
        if (tail && tail.kind === 'list') tail.items.push(item)
        else blocks.push({ kind: 'list', items: [item] })
        precededByBlank = false
        continue
      }
      // A lone glyph with no text after it: fall through and treat as prose.
    }
    bulletBaseIndent = null

    // --- section headings ---
    if (isSectionHeading(text, precededByBlank)) {
      blocks.push({ kind: 'heading', level: 2, text: escapeInlineMarkdown(stripHeadingDecoration(text)) })
      precededByBlank = false
      continue
    }

    // --- a line that is only a date range: join it to the role line above ---
    const tail = last()
    if (isDateOnlyLine(text) && tail && tail.kind === 'para' && tail.lines.length > 0) {
      const idx = tail.lines.length - 1
      tail.lines[idx] = bold(`${unbold(tail.lines[idx])} \u2014 ${escapeInlineMarkdown(text)}`)
      precededByBlank = false
      continue
    }

    // --- role line (carries a date range) vs ordinary prose ---
    const escaped = escapeInlineMarkdown(text)
    const line = DATE_RANGE.test(text) && text.length <= 120 ? bold(escaped) : escaped

    if (!precededByBlank && tail && tail.kind === 'para') {
      // Adjacent source lines stay ONE paragraph, so a contact block keeps its
      // line structure instead of exploding into a paragraph per line.
      tail.lines.push(line)
    } else {
      blocks.push({ kind: 'para', lines: [line] })
    }
    precededByBlank = false
  }

  return serialize(blocks)
}

function serialize(blocks: readonly Block[]): string {
  const chunks: string[] = []

  for (const block of blocks) {
    switch (block.kind) {
      case 'heading':
        chunks.push(`${'#'.repeat(block.level)} ${block.text}`)
        break
      case 'para':
        chunks.push(block.lines.join('\n'))
        break
      case 'rule':
        chunks.push('---')
        break
      case 'list':
        chunks.push(
          block.items
            .map((item) => {
              const indent = '  '.repeat(item.depth)
              const marker = item.ordered ? `${item.marker}. ` : '- '
              return `${indent}${marker}${item.text}`
            })
            .join('\n')
        )
        break
    }
  }

  return chunks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
}
