// Resume import: any common resume file (or pasted text) -> Markdown + the
// derived ATS plain text, in one call.
//
// WHY BOTH STRINGS COME OUT OF ONE FUNCTION
//   lib/resume/types.ts is emphatic that `content_json.markdown` is AUTHORED and
//   `resume_documents.content` is DERIVED from it, and that writing one without
//   the other is silent corruption — the PDF the user downloads and the text the
//   employer's parser reads would describe different resumes. So no caller of
//   this module ever gets the chance: importResume() returns `{ markdown,
//   plainText }` where plainText is markdownToPlainText(markdown), computed
//   here, once.
//
// THE FORMATS CARRY DIFFERENT AMOUNTS OF STRUCTURE (see ./formats.ts):
//   .docx -> ./docx.ts        real Word semantics, translated, nothing guessed
//   .md   -> adopted verbatim when it actually contains Markdown
//   .txt  -> ./llm.ts         LLM reformat if a key exists, else ./infer.ts
//   .pdf  -> unpdf text, then the same treatment as .txt; a vision model reads
//            image-only PDFs when one is configured, and its output is
//            cross-checked against the extracted text whenever there IS any.
//
// WHAT NEVER HAPPENS HERE
//   - An unstructured blob. Every path produces headings and bullets, or an
//     error that says why it could not.
//   - Invented content. The LLM's output is word-set-checked against the source
//     (./llm.ts) and discarded for the deterministic inference if it diverges.
//   - A silently empty resume. A scanned PDF with no text layer and no vision
//     key is an error with a remedy in it, not an empty document.

import { markdownToPlainText, looksLikeMarkdown, parseResumeMarkdown } from '../markdown'
import { docxToMarkdown } from './docx'
import {
  detectResumeFormat,
  isLegacyDoc,
  legacyDocError,
  unsupportedFormatError,
  ResumeImportError,
  RESUME_UPLOAD_MAX_BYTES,
  RESUME_UPLOAD_MAX_LABEL,
  type ResumeFormat,
} from './formats'
import { inferResumeMarkdown } from './infer'
import { checkReformatFaithfulness, reformatToMarkdown, stripCodeFence, type CompletionFn } from './llm'

export * from './formats'
export { inferResumeMarkdown, isKnownSectionTitle, isLikelyName, escapeInlineMarkdown } from './infer'
export {
  RESUME_MARKDOWN_PROMPT,
  buildReformatPrompt,
  checkReformatFaithfulness,
  reformatToMarkdown,
  stripCodeFence,
} from './llm'
export { docxToMarkdown, promoteUnstyledHeadings } from './docx'

/**
 * Below this many characters, a PDF's extracted text is treated as "there is no
 * text layer" — i.e. a scan. Unchanged from the original route's threshold.
 */
const MIN_PDF_TEXT_CHARS = 50

/**
 * Optional model access. Both legs are independently optional: a user with no
 * keys at all still gets a structured resume from every format.
 */
export interface ResumeImportModels {
  /** Reformats extracted plain text into Markdown. Usually OpenRouter/OpenAI. */
  reformat?: CompletionFn | null
  /**
   * Reads a PDF natively (base64 in, Markdown out) — the only way to recover an
   * image-only scan. Usually Claude.
   */
  readPdf?: ((pdfBase64: string) => Promise<string>) | null
}

export interface ResumeImportResult {
  format: ResumeFormat
  /** AUTHORED. Goes to content_json.markdown. */
  markdown: string
  /** DERIVED from `markdown`. Goes to resume_documents.content. */
  plainText: string
  /** Short, user-facing description of how this was produced. */
  method: string
  /** True when the source itself carried the structure (docx / real Markdown). */
  structurePreserved: boolean
  /** Honest notes about downgrades. Safe to show the user verbatim. */
  warnings: string[]
}

/** Decode a text file, honouring a BOM. Notepad still writes UTF-16 by default. */
export function decodeTextFile(bytes: Buffer): string {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le')
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le')
  }
  const text = bytes.toString('utf8')
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** unpdf text extraction. Returns '' rather than throwing — the caller decides. */
async function extractPdfText(bytes: Buffer): Promise<string> {
  try {
    const { extractText } = await import('unpdf')
    const result = await extractText(new Uint8Array(bytes))
    return Array.isArray(result.text) ? result.text.join('\n') : String(result.text ?? '')
  } catch (error) {
    console.error('[resume/import] unpdf extraction failed:', error)
    return ''
  }
}

function finish(
  format: ResumeFormat,
  markdown: string,
  method: string,
  warnings: string[],
  structurePreserved: boolean
): ResumeImportResult {
  const plainText = markdownToPlainText(markdown)
  if (!plainText.trim()) {
    throw new ResumeImportError('no_text', 'No readable text was found in that resume.')
  }
  return { format, markdown, plainText, method, warnings, structurePreserved }
}

/**
 * Stronger evidence of Markdown than looksLikeMarkdown(), which also fires on a
 * `- ` line. That is the right test for a file the user NAMED .md, but a `- `
 * bullet is just as much a plain-text convention — treating a .txt resume that
 * uses `- ` or `* ` bullets as authored Markdown would adopt it verbatim and
 * hand the user a document with no section headings at all, which is exactly
 * the unstructured blob this pipeline exists to prevent. A heading or a `**`
 * only appears on purpose.
 */
export function looksAuthoredInMarkdown(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false
  return /^#{1,6}\s+\S/m.test(text) || /\*\*\S/.test(text)
}

/** Text that already is Markdown is adopted as-is; text that isn't is inferred. */
async function importTextLike(
  format: ResumeFormat,
  text: string,
  models: ResumeImportModels
): Promise<ResumeImportResult> {
  if (!text.trim()) {
    throw new ResumeImportError('no_text', 'That file is empty.')
  }

  // Real Markdown is the user's own formatting. Adopt it verbatim — running it
  // through the inference (or an LLM) would overwrite decisions they made.
  // A .md file gets the benefit of the doubt (bullets count); anything else has
  // to show a heading or bold.
  if (format === 'md' ? looksLikeMarkdown(text) : looksAuthoredInMarkdown(text)) {
    if (parseResumeMarkdown(text).length === 0) {
      throw new ResumeImportError('no_text', 'No readable text was found in that file.')
    }
    return finish(format, text.trim(), 'Markdown kept exactly as written', [], true)
  }

  const warnings: string[] = []
  if (format === 'md') {
    warnings.push(
      'That .md file had no Markdown formatting in it, so the section structure was inferred from the text.'
    )
  }

  const result = await reformatToMarkdown(text, models.reformat)
  return finish(
    format,
    result.markdown,
    result.method === 'llm' ? 'Plain text + AI formatting' : 'Plain text, structure inferred',
    [...warnings, ...result.warnings],
    false
  )
}

async function importPdf(bytes: Buffer, models: ResumeImportModels): Promise<ResumeImportResult> {
  const rawText = await extractPdfText(bytes)
  const hasTextLayer = rawText.trim().length >= MIN_PDF_TEXT_CHARS
  const warnings: string[] = []

  // A vision model reads the page the way a human does — the only thing that
  // survives a two-column layout or a scan. Its output is still checked against
  // unpdf's extraction whenever there IS one: the check compares word SETS, so
  // a different reading order passes and invented content does not.
  if (models.readPdf) {
    try {
      const answer = stripCodeFence(await models.readPdf(bytes.toString('base64')))
      if (answer && parseResumeMarkdown(answer).length > 0) {
        if (!hasTextLayer) {
          warnings.push(
            'This PDF has no text layer, so it was read visually. There was no extracted text to cross-check it against — please proofread the imported resume.'
          )
          return finish('pdf', answer, 'Image-only PDF read by AI vision', warnings, false)
        }
        const report = checkReformatFaithfulness(rawText, answer)
        if (report.ok) {
          return finish('pdf', answer, 'PDF read by AI vision (verified against the PDF text)', warnings, false)
        }
        warnings.push(
          `The AI read of the PDF was discarded because ${report.reason}. The extracted text was used instead, so nothing was invented.`
        )
      }
    } catch (error) {
      console.error('[resume/import] vision PDF read failed:', error)
      warnings.push('Reading the PDF with AI failed, so its extracted text was used instead.')
    }
  }

  if (!hasTextLayer) {
    // The honest scanned-PDF path. Never turn this into an empty resume.
    throw new ResumeImportError(
      'pdf_no_text',
      models.readPdf
        ? 'No text could be read from this PDF — it looks scanned, and the AI read of it did not work either. Upload a .docx or .txt version, or paste the text instead.'
        : 'No text could be read from this PDF — it looks scanned or image-only. Add an Anthropic API key in Settings to read image-based PDFs, or upload a .docx / .txt version instead.'
    )
  }

  const result = await reformatToMarkdown(rawText, models.reformat)
  return finish(
    'pdf',
    result.markdown,
    result.method === 'llm' ? 'PDF text + AI formatting' : 'PDF text, structure inferred',
    [...warnings, ...result.warnings],
    false
  )
}

export interface ResumeFileInput {
  filename?: string | null
  mimeType?: string | null
  bytes: Buffer
}

/**
 * Import an uploaded resume file. Throws ResumeImportError (which carries a
 * user-facing message and an HTTP status) for anything the user can fix.
 */
export async function importResumeFile(
  input: ResumeFileInput,
  models: ResumeImportModels = {}
): Promise<ResumeImportResult> {
  const { filename, mimeType, bytes } = input

  if (!bytes || bytes.length === 0) {
    throw new ResumeImportError('empty_file', 'That file is empty.')
  }
  if (bytes.length > RESUME_UPLOAD_MAX_BYTES) {
    throw new ResumeImportError('too_large', `File too large (max ${RESUME_UPLOAD_MAX_LABEL}).`)
  }
  if (isLegacyDoc(filename, mimeType)) throw legacyDocError()

  const format = detectResumeFormat(filename, mimeType)
  if (!format) throw unsupportedFormatError(filename)

  switch (format) {
    case 'docx': {
      const { markdown, warnings } = await docxToMarkdown(bytes)
      return finish('docx', markdown, 'Word formatting preserved', warnings, true)
    }
    case 'pdf':
      return importPdf(bytes, models)
    case 'md':
    case 'txt':
      return importTextLike(format, decodeTextFile(bytes), models)
  }
}

/**
 * Import resume text the user pasted in. Treated as Markdown when it carries
 * Markdown, and inferred otherwise — the same two paths a .md / .txt file takes.
 */
export async function importPastedResume(
  text: string,
  models: ResumeImportModels = {}
): Promise<ResumeImportResult> {
  if (typeof text !== 'string' || !text.trim()) {
    throw new ResumeImportError('no_text', 'Paste your resume text first.')
  }
  if (Buffer.byteLength(text, 'utf8') > RESUME_UPLOAD_MAX_BYTES) {
    throw new ResumeImportError('too_large', `That is too much text (max ${RESUME_UPLOAD_MAX_LABEL}).`)
  }
  // Pasted text is undesigned until it proves otherwise — same bar as a .txt.
  return importTextLike(looksAuthoredInMarkdown(text) ? 'md' : 'txt', text, models)
}
