// .docx -> resume Markdown.
//
// THIS IS THE HIGHEST-FIDELITY INPUT WE ACCEPT, AND THE ONLY ONE THAT NEEDS NO
// GUESSING. A Word file carries real semantics: "Heading 1" is a heading
// because the author said so, a bold run is bold because the author bolded it,
// and a list item's level is stored, not inferred from leading spaces. So this
// path does not run the .txt heuristics — it translates.
//
// WHY mammoth + turndown AND NOT A HAND-ROLLED OOXML READER
//   docx is a zip of XML with numbering definitions in one part, styles in
//   another, and list levels resolved through both. mammoth already does that
//   resolution and emits semantic HTML; turndown already handles HTML -> the
//   Markdown grammar lib/resume/markdown.ts parses. Writing either by hand
//   would be a worse version of a maintained library, and it is exactly the
//   layer where "mostly works" quietly loses a user's bullet nesting.
//
// THE TWO PROMOTIONS AT THE END
//   Plenty of real resumes are typed in Word with NO styles at all — the
//   section names are just bold text at 14pt. mammoth reports that honestly as
//   a bold paragraph, which would render as bold body text and give the
//   templates nothing to typeset. So a paragraph that is entirely bold AND
//   whose text is a section name we recognise is promoted to `## `, and a first
//   line that looks like a person's name is promoted to `# `. Both use the
//   document's own words and its own emphasis; neither invents anything.

import TurndownService from 'turndown'
import { isKnownSectionTitle, isLikelyName } from './infer'
import { ResumeImportError } from './formats'

/**
 * Extra style mappings on top of mammoth's defaults (which already map
 * Heading 1-6, lists, bold/italic and hyperlinks). Word's resume templates lean
 * on Title/Subtitle, and h4+ is clamped to h3 by the block model anyway, so map
 * it here where the intent is still visible.
 */
const STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Name'] => h1:fresh",
  "p[style-name='Subtitle'] => p:fresh",
  "p[style-name='Section Title'] => h2:fresh",
  "p[style-name='Section Heading'] => h2:fresh",
  "p[style-name='Heading 4'] => h3:fresh",
  "p[style-name='Heading 5'] => h3:fresh",
  "p[style-name='Heading 6'] => h3:fresh",
]

/** Cell text joined with this. Matches how the block model lowers GFM tables. */
const CELL_SEPARATOR = ' — '

function createTurndown(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    strongDelimiter: '**',
    emDelimiter: '*',
    codeBlockStyle: 'fenced',
    hr: '---',
  })

  // Images carry no resume text and a data: URI would bloat content_json by
  // megabytes. The block model reduces them to alt text anyway.
  service.addRule('dropImages', { filter: ['img'], replacement: () => '' })

  // A table in a resume is usually LAYOUT, not data — Word's two-column resume
  // templates are tables. Flatten each row to one line so the document stays
  // single-column and readable in draw order, which is the same thing
  // lib/resume/markdown.ts does to a GFM table and for the same ATS reason.
  service.addRule('flattenTableRows', {
    filter: ['tr'],
    replacement: (_content, node) => {
      const cells = Array.from((node as unknown as { childNodes: ArrayLike<unknown> }).childNodes ?? [])
        .map((child) => child as { nodeName?: string; textContent?: string | null })
        .filter((child) => child.nodeName === 'TD' || child.nodeName === 'TH')
        .map((child) => (child.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
      return cells.length > 0 ? `\n\n${cells.join(CELL_SEPARATOR)}\n\n` : ''
    },
  })
  service.addRule('unwrapTables', {
    filter: ['table', 'thead', 'tbody', 'tfoot'],
    replacement: (content) => content,
  })

  return service
}

/**
 * A paragraph that is entirely bold and reads as a section name becomes a real
 * `## ` heading; the first line becomes `# ` when it reads as a person's name
 * and the document has no h1 of its own. Only runs when the document declared
 * no headings at all — if the author used Heading styles, their structure is
 * the truth and nothing here second-guesses it.
 */
export function promoteUnstyledHeadings(markdown: string): string {
  const lines = markdown.split('\n')
  const hasHeadings = lines.some((line) => /^#{1,6}\s+\S/.test(line))
  if (hasHeadings) return markdown

  let promotedName = false
  return lines
    .map((line) => {
      const trimmed = line.trim()
      if (!trimmed) return line

      const boldOnly = /^\*\*(.+?)\*\*:?$/.exec(trimmed)
      if (boldOnly && isKnownSectionTitle(boldOnly[1])) {
        return `## ${boldOnly[1].replace(/:$/, '').trim()}`
      }

      if (!promotedName) {
        promotedName = true
        const bare = boldOnly ? boldOnly[1].trim() : trimmed
        if (isLikelyName(bare)) return `# ${bare}`
      }
      return line
    })
    .join('\n')
}

/** Collapse the blank-line noise turndown leaves behind. */
function tidy(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Convert a .docx buffer to resume Markdown.
 *
 * Throws ResumeImportError('docx_unreadable') when the file is not a readable
 * Word document, and ResumeImportError('no_text') when it is readable but
 * empty — a corrupt upload must not become a silently empty resume.
 */
export async function docxToMarkdown(buffer: Buffer): Promise<{ markdown: string; warnings: string[] }> {
  // Dynamic import for the same reason unpdf is dynamically imported in the
  // upload route: neither belongs in the module graph of a request that is not
  // processing a document.
  const mammothModule = await import('mammoth')
  const mammoth = (mammothModule as unknown as { default?: typeof mammothModule }).default ?? mammothModule

  let html: string
  let messages: Array<{ type: string; message: string }>
  try {
    const result = await mammoth.convertToHtml({ buffer }, { styleMap: STYLE_MAP })
    html = result.value
    messages = result.messages
  } catch (error) {
    console.error('[resume/import] docx conversion failed:', error)
    throw new ResumeImportError(
      'docx_unreadable',
      'That .docx file could not be read. Re-save it from Word (File > Save As > Word Document) and try again, or upload a PDF.'
    )
  }

  const markdown = promoteUnstyledHeadings(tidy(createTurndown().turndown(html)))
  if (!markdown.trim()) {
    throw new ResumeImportError(
      'no_text',
      'That .docx file has no text in it. If the resume is an image pasted into Word, upload the original PDF instead.'
    )
  }

  const warnings: string[] = []
  const errors = messages.filter((m) => m.type === 'error')
  if (errors.length > 0) {
    warnings.push(
      `Word reported ${errors.length} problem${errors.length === 1 ? '' : 's'} while reading the file; check the imported resume for gaps.`
    )
  }

  return { markdown, warnings }
}
