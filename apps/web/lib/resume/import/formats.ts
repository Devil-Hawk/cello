// What a resume upload is allowed to be, and how a request is classified.
//
// The product promise is "any word or pdf or txt" — so the format list lives in
// ONE place and every user-facing string (the API's rejection message, the file
// input's `accept` attribute, the help copy) is derived from it. The previous
// implementation hard-coded `file.name.endsWith('.pdf')` in the route and told
// the user "Only PDF files are supported" from a second, unrelated string
// literal; the two could not drift apart here without a type error.
//
// THESE FOUR FORMATS CARRY DIFFERENT AMOUNTS OF STRUCTURE, AND WE DO NOT PRETEND
// OTHERWISE (see ./index.ts for the per-format pipeline):
//   .docx  Word carries REAL semantics — heading styles, bold runs, list levels.
//          Highest fidelity input by a wide margin; nothing is guessed.
//   .md    Already Markdown. Adopted verbatim; we do not "improve" it.
//   .txt   No structure exists, so structure is INFERRED (./infer.ts).
//   .pdf   Text extracted with unpdf, then the same inference as .txt, because a
//          PDF's content stream carries glyph positions, not headings.

/** The formats an upload may be. Ordered best-fidelity-first. */
export const RESUME_FORMATS = ['docx', 'md', 'txt', 'pdf'] as const

export type ResumeFormat = (typeof RESUME_FORMATS)[number]

/** Hard cap on an upload, in bytes. Unchanged from the original route. */
export const RESUME_UPLOAD_MAX_BYTES = 5 * 1024 * 1024

/** Human-readable cap, for error copy. */
export const RESUME_UPLOAD_MAX_LABEL = '5MB'

/**
 * File extensions accepted per format. `.markdown` and `.text` are included
 * because they are what some editors write, and rejecting them would be a
 * pointless "your file is fine but the name isn't" failure.
 */
const EXTENSIONS: Record<ResumeFormat, readonly string[]> = {
  docx: ['.docx'],
  md: ['.md', '.markdown', '.mdown'],
  txt: ['.txt', '.text'],
  pdf: ['.pdf'],
}

/**
 * MIME types accepted per format, used only when the filename has no usable
 * extension. Browsers are inconsistent here (a .md file is commonly sent as
 * text/plain, and Windows sends .txt as text/plain too), so the extension wins
 * whenever there is one.
 */
const MIME_TYPES: Record<ResumeFormat, readonly string[]> = {
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  md: ['text/markdown', 'text/x-markdown'],
  txt: ['text/plain'],
  pdf: ['application/pdf'],
}

/**
 * Value for a file input's `accept` attribute. Extensions AND MIME types:
 * macOS Safari filters on MIME type, Windows Chrome on extension, and a list
 * with only one of the two silently greys out valid files on the other.
 */
export const RESUME_UPLOAD_ACCEPT: string = [
  ...RESUME_FORMATS.flatMap((f) => EXTENSIONS[f]),
  ...RESUME_FORMATS.flatMap((f) => MIME_TYPES[f]),
].join(',')

/** One phrase naming the supported formats, for user-facing copy. */
export const SUPPORTED_FORMATS_SENTENCE =
  'PDF, Word (.docx), plain text (.txt) or Markdown (.md)'

/** Lowercased extension including the dot, or '' when the name has none. */
export function fileExtension(filename: string | null | undefined): string {
  if (typeof filename !== 'string') return ''
  const base = filename.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  // `dot <= 0` covers both "no extension" and a dotfile like ".resume".
  return dot > 0 ? base.slice(dot).toLowerCase() : ''
}

/**
 * Classify an upload. Returns null when the file is not one of the supported
 * formats — callers turn that into `unsupportedFormatError()` so the message
 * and the format list can never disagree.
 *
 * Extension first, MIME type only as a fallback: browsers routinely label .md
 * as text/plain (which would silently take the inference path and destroy the
 * user's own Markdown), and label .docx as application/zip.
 */
export function detectResumeFormat(
  filename: string | null | undefined,
  mimeType?: string | null
): ResumeFormat | null {
  const ext = fileExtension(filename)
  if (ext) {
    for (const format of RESUME_FORMATS) {
      if (EXTENSIONS[format].includes(ext)) return format
    }
  }

  const mime = (mimeType ?? '').split(';')[0].trim().toLowerCase()
  if (mime) {
    for (const format of RESUME_FORMATS) {
      if (MIME_TYPES[format].includes(mime)) return format
    }
  }

  return null
}

/** True for the legacy binary Word format, which mammoth cannot read. */
export function isLegacyDoc(filename: string | null | undefined, mimeType?: string | null): boolean {
  const mime = (mimeType ?? '').split(';')[0].trim().toLowerCase()
  return fileExtension(filename) === '.doc' || mime === 'application/msword'
}

/**
 * Why an import failed, in terms the route can map to an HTTP status and the UI
 * can show verbatim. Every message names the concrete next action — "could not
 * read this" with no remedy is the failure mode this replaces.
 */
export type ResumeImportErrorCode =
  | 'unsupported_format'
  | 'legacy_doc'
  | 'too_large'
  | 'empty_file'
  | 'no_text'
  | 'pdf_no_text'
  | 'docx_unreadable'

export class ResumeImportError extends Error {
  readonly code: ResumeImportErrorCode
  /** Suggested HTTP status. Everything here is the user's input, so 400. */
  readonly status: number

  constructor(code: ResumeImportErrorCode, message: string, status = 400) {
    super(message)
    this.name = 'ResumeImportError'
    this.code = code
    this.status = status
  }
}

export function unsupportedFormatError(filename?: string | null): ResumeImportError {
  const ext = fileExtension(filename)
  const what = ext ? `${ext} files are not supported` : 'That file type is not supported'
  return new ResumeImportError('unsupported_format', `${what}. Upload ${SUPPORTED_FORMATS_SENTENCE}.`)
}

export function legacyDocError(): ResumeImportError {
  return new ResumeImportError(
    'legacy_doc',
    'Legacy .doc files are not supported. Open it in Word and use File > Save As to save a .docx or a PDF, then upload that.'
  )
}
