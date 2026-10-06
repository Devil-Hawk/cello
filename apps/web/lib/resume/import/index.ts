// Resume import: any common resume file (or pasted text) -> Markdown + the
// derived plain text. This is the TEXT leg only; lib/resume/import/structure.ts
// turns the result into a structured Resume (the thing that is stored).
//
// THE FORMATS CARRY DIFFERENT AMOUNTS OF STRUCTURE (see ./formats.ts):
//   .docx -> ./docx.ts        real Word semantics, translated, nothing guessed
//   .md   -> adopted verbatim when it actually contains Markdown
//   .txt  -> ./infer.ts       deterministic structure inference
//   .pdf  -> unpdf text, then the same inference as .txt
//   image / scanned PDF -> not read here: a 422 `needs_transcribe` tells the
//            client to run the transcribe step (lib/resume/import/vision.ts, or
//            browser OCR when the server has no vision key).
//
// WHAT NEVER HAPPENS HERE
//   - An LLM reformat. The structure step replaces it: one strict-JSON call
//     that is faithfulness-checked, with the deterministic path as the fallback.
//   - A silently empty resume. A PDF with no text layer is an error with a
//     remedy in it, not an empty document.

import {
  markdownToPlainText,
  looksAuthoredInMarkdown,
  looksLikeMarkdown,
  parseResumeMarkdown,
} from '../markdown'
import { docxToMarkdown } from './docx'
import {
  detectResumeFormat,
  heicError,
  isHeic,
  isLegacyDoc,
  legacyDocError,
  unsupportedFormatError,
  ResumeImportError,
  RESUME_UPLOAD_MAX_BYTES,
  RESUME_UPLOAD_MAX_LABEL,
  type ResumeFormat,
} from './formats'
import { inferResumeMarkdown } from './infer'

export * from './formats'
export { looksAuthoredInMarkdown }
export { inferResumeMarkdown, isKnownSectionTitle, isLikelyName, escapeInlineMarkdown } from './infer'
export { checkReformatFaithfulness, findInventedFacts, stripCodeFence } from './llm'
export { docxToMarkdown, promoteUnstyledHeadings } from './docx'

/**
 * Below this many characters, a PDF's extracted text is treated as "there is no
 * text layer" — i.e. a scan. Unchanged from the original route's threshold.
 */
const MIN_PDF_TEXT_CHARS = 50

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

/** Text that already is Markdown is adopted as-is; text that isn't is inferred. */
function importTextLike(format: ResumeFormat, text: string): ResumeImportResult {
  if (!text.trim()) {
    throw new ResumeImportError('no_text', 'That file is empty.')
  }

  // Real Markdown is the user's own formatting. Adopt it verbatim — running it
  // through the inference would overwrite decisions they made.
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
  return finish(format, inferResumeMarkdown(text), 'Plain text, structure inferred', warnings, false)
}

async function importPdf(bytes: Buffer): Promise<ResumeImportResult> {
  const rawText = await extractPdfText(bytes)
  if (rawText.trim().length < MIN_PDF_TEXT_CHARS) {
    // The honest scanned-PDF path. Never turn this into an empty resume.
    throw new ResumeImportError(
      'needs_transcribe',
      'This PDF has no text layer, so it has to be read as a picture.',
      422
    )
  }
  return finish('pdf', inferResumeMarkdown(rawText), 'PDF text, structure inferred', [], false)
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
export async function importResumeFile(input: ResumeFileInput): Promise<ResumeImportResult> {
  const { filename, mimeType, bytes } = input

  if (!bytes || bytes.length === 0) {
    throw new ResumeImportError('empty_file', 'That file is empty.')
  }
  if (bytes.length > RESUME_UPLOAD_MAX_BYTES) {
    throw new ResumeImportError('too_large', `File too large (max ${RESUME_UPLOAD_MAX_LABEL}).`)
  }
  if (isLegacyDoc(filename, mimeType)) throw legacyDocError()
  if (isHeic(filename, mimeType)) throw heicError()

  const format = detectResumeFormat(filename, mimeType)
  if (!format) throw unsupportedFormatError(filename)

  switch (format) {
    case 'docx': {
      const { markdown, warnings } = await docxToMarkdown(bytes)
      return finish('docx', markdown, 'Word formatting preserved', warnings, true)
    }
    case 'pdf':
      return importPdf(bytes)
    case 'md':
    case 'txt':
      return importTextLike(format, decodeTextFile(bytes))
    case 'png':
    case 'jpg':
    case 'webp':
      throw new ResumeImportError('needs_transcribe', 'That picture has to be read before it can be imported.', 422)
  }
}

/**
 * Import resume text the user pasted in. Treated as Markdown when it carries
 * Markdown, and inferred otherwise — the same two paths a .md / .txt file takes.
 */
export async function importPastedResume(text: string): Promise<ResumeImportResult> {
  if (typeof text !== 'string' || !text.trim()) {
    throw new ResumeImportError('no_text', 'Paste your resume text first.')
  }
  if (Buffer.byteLength(text, 'utf8') > RESUME_UPLOAD_MAX_BYTES) {
    throw new ResumeImportError('too_large', `That is too much text (max ${RESUME_UPLOAD_MAX_LABEL}).`)
  }
  // Pasted text is undesigned until it proves otherwise — same bar as a .txt.
  return importTextLike(looksAuthoredInMarkdown(text) ? 'md' : 'txt', text)
}
