// End-to-end import: what the route actually calls.
//
// The .pdf cases build a REAL PDF with react-pdf (the exporter's library), one
// Text per line, and read it back with unpdf, so the extraction leg is exercised
// rather than mocked, including the image-only case, which must stay an honest
// error instead of degrading into an empty resume.

import { describe, expect, it } from 'vitest'
import { createElement as h } from 'react'
import {
  decodeTextFile,
  detectResumeFormat,
  fileExtension,
  importPastedResume,
  importResumeFile,
  isLegacyDoc,
  RESUME_UPLOAD_ACCEPT,
  RESUME_UPLOAD_MAX_BYTES,
} from './index'
import { markdownToPlainText, parseResumeMarkdown } from '../markdown'

const PLAIN_TEXT_RESUME = `Jane Q. Doe
jane.doe@example.com | 555-0100

EXPERIENCE

Senior Engineer, Northwind Payments
Mar 2019 - Present
• Led the migration of the ledger service to Postgres.
• Cut settlement latency from 900ms to 120ms.

EDUCATION

B.S. Computer Science, University of Washington, 2015
`

const AUTHORED_MARKDOWN = `# Jane Q. Doe

jane.doe@example.com

## Experience

**Senior Engineer, Northwind Payments — Mar 2019 - Present**

- Led the migration of the ledger service to Postgres.
`

const bytes = (text: string) => Buffer.from(text, 'utf8')

async function pdfWithLines(lines: string[]): Promise<Buffer> {
  const { Document, Page, Text, renderToBuffer } = await import('@react-pdf/renderer')
  const page = h(
    Page,
    { size: [612, 792], style: { padding: 54, fontFamily: 'Helvetica', fontSize: 11 } },
    ...lines.map((line) => h(Text, null, line || ' '))
  )
  return renderToBuffer(h(Document, null, page))
}

describe('format detection', () => {
  it('accepts every format the product promises', () => {
    expect(detectResumeFormat('resume.pdf')).toBe('pdf')
    expect(detectResumeFormat('resume.docx')).toBe('docx')
    expect(detectResumeFormat('resume.txt')).toBe('txt')
    expect(detectResumeFormat('resume.md')).toBe('md')
    expect(detectResumeFormat('resume.markdown')).toBe('md')
    expect(detectResumeFormat('RESUME.PDF')).toBe('pdf')
  })

  it('prefers the extension over the browser-supplied MIME type', () => {
    // Browsers routinely send .md as text/plain; taking the MIME type would
    // send the user's own Markdown through the inference and overwrite it.
    expect(detectResumeFormat('resume.md', 'text/plain')).toBe('md')
    expect(detectResumeFormat('resume.docx', 'application/zip')).toBe('docx')
  })

  it('falls back to the MIME type when there is no extension', () => {
    expect(detectResumeFormat('resume', 'application/pdf')).toBe('pdf')
    expect(detectResumeFormat('', 'text/markdown')).toBe('md')
    expect(detectResumeFormat('resume', 'application/pdf; charset=binary')).toBe('pdf')
  })

  it('rejects what it cannot read', () => {
    expect(detectResumeFormat('resume.rtf')).toBeNull()
    expect(detectResumeFormat('resume.pages')).toBeNull()
    expect(detectResumeFormat('photo.gif', 'image/gif')).toBeNull()
  })

  it('identifies legacy .doc separately, because the remedy is different', () => {
    expect(isLegacyDoc('resume.doc')).toBe(true)
    expect(isLegacyDoc('resume', 'application/msword')).toBe(true)
    expect(isLegacyDoc('resume.docx')).toBe(false)
  })

  it('exposes an accept attribute covering extensions AND MIME types', () => {
    for (const token of ['.pdf', '.docx', '.txt', '.md', 'application/pdf', 'text/plain']) {
      expect(RESUME_UPLOAD_ACCEPT).toContain(token)
    }
  })

  it('handles filenames with dots and paths', () => {
    expect(fileExtension('my.resume.v2.pdf')).toBe('.pdf')
    expect(fileExtension('C:\\Users\\jane\\resume.docx')).toBe('.docx')
    expect(fileExtension('resume')).toBe('')
  })
})

describe('importResumeFile — rejections the user can act on', () => {
  it('names the supported formats when the type is wrong', async () => {
    await expect(importResumeFile({ filename: 'resume.rtf', bytes: bytes('hello') })).rejects.toMatchObject({
      code: 'unsupported_format',
      message: expect.stringContaining('Word (.docx)'),
    })
  })

  it('tells a .doc user how to convert it', async () => {
    await expect(importResumeFile({ filename: 'resume.doc', bytes: bytes('hello') })).rejects.toMatchObject({
      code: 'legacy_doc',
      message: expect.stringContaining('Save As'),
    })
  })

  it('keeps the 5MB cap', async () => {
    const big = Buffer.alloc(RESUME_UPLOAD_MAX_BYTES + 1, 0x20)
    await expect(importResumeFile({ filename: 'resume.txt', bytes: big })).rejects.toMatchObject({
      code: 'too_large',
    })
  })

  it('rejects an empty file rather than saving an empty resume', async () => {
    await expect(importResumeFile({ filename: 'resume.txt', bytes: Buffer.alloc(0) })).rejects.toMatchObject({
      code: 'empty_file',
    })
    await expect(importResumeFile({ filename: 'resume.txt', bytes: bytes('   \n  ') })).rejects.toMatchObject({
      code: 'no_text',
    })
  })
})

describe('importResumeFile — .txt', () => {
  it('infers structure with no model configured', async () => {
    const result = await importResumeFile({ filename: 'resume.txt', bytes: bytes(PLAIN_TEXT_RESUME) })
    expect(result.format).toBe('txt')
    expect(result.method).toBe('Plain text, structure inferred')
    expect(result.structurePreserved).toBe(false)
    expect(result.markdown).toContain('# Jane Q. Doe')
    expect(result.markdown).toContain('## EXPERIENCE')
    expect(result.markdown).toContain('- Led the migration of the ledger service to Postgres.')
    expect(result.warnings).toEqual([])
  })

  it('derives the plain text from the Markdown, never independently', async () => {
    const result = await importResumeFile({ filename: 'resume.txt', bytes: bytes(PLAIN_TEXT_RESUME) })
    expect(result.plainText).toBe(markdownToPlainText(result.markdown))
    expect(result.plainText).not.toContain('#')
    expect(result.plainText).not.toContain('**')
  })

  it('still infers sections for a .txt that happens to use "- " bullets', async () => {
    // `- ` is a plain-text convention as much as a Markdown one. Adopting this
    // verbatim would hand back a document with no section headings at all.
    const dashed = PLAIN_TEXT_RESUME.replace(/•/g, '-')
    const result = await importResumeFile({ filename: 'resume.txt', bytes: bytes(dashed) })
    expect(result.method).toBe('Plain text, structure inferred')
    expect(result.markdown).toContain('## EXPERIENCE')
    expect(result.markdown).toContain('- Led the migration of the ledger service to Postgres.')
  })

  it('adopts a .txt that really was authored in Markdown', async () => {
    const result = await importResumeFile({ filename: 'resume.txt', bytes: bytes(AUTHORED_MARKDOWN) })
    expect(result.method).toBe('Markdown kept exactly as written')
    expect(result.markdown).toBe(AUTHORED_MARKDOWN.trim())
  })

  it('decodes a UTF-16 file (what Notepad writes) instead of returning mojibake', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(PLAIN_TEXT_RESUME, 'utf16le')])
    const result = await importResumeFile({ filename: 'resume.txt', bytes: utf16 })
    expect(result.plainText).toContain('Jane Q. Doe')
    expect(decodeTextFile(utf16)).toBe(PLAIN_TEXT_RESUME)
  })
})

describe('importResumeFile — .md', () => {
  it('keeps the user\u2019s own Markdown exactly as written', async () => {
    const result = await importResumeFile({ filename: 'resume.md', bytes: bytes(AUTHORED_MARKDOWN) })
    expect(result.format).toBe('md')
    expect(result.structurePreserved).toBe(true)
    expect(result.method).toBe('Markdown kept exactly as written')
    expect(result.markdown).toBe(AUTHORED_MARKDOWN.trim())
    expect(result.warnings).toEqual([])
  })

  it('infers structure for a .md file that carries no Markdown, and says so', async () => {
    const result = await importResumeFile({ filename: 'resume.md', bytes: bytes(PLAIN_TEXT_RESUME) })
    expect(result.markdown).toContain('## EXPERIENCE')
    expect(result.warnings[0]).toMatch(/no Markdown formatting/)
  })
})

describe('importPastedResume', () => {
  it('infers structure from pasted plain text', async () => {
    const result = await importPastedResume(PLAIN_TEXT_RESUME)
    expect(result.format).toBe('txt')
    expect(result.markdown).toContain('## EXPERIENCE')
    expect(result.plainText).toBe(markdownToPlainText(result.markdown))
  })

  it('keeps pasted Markdown as Markdown', async () => {
    const result = await importPastedResume(AUTHORED_MARKDOWN)
    expect(result.format).toBe('md')
    expect(result.markdown).toBe(AUTHORED_MARKDOWN.trim())
  })

  it('infers structure for pasted text that only uses dash bullets', async () => {
    const result = await importPastedResume(PLAIN_TEXT_RESUME.replace(/•/g, '-'))
    expect(result.format).toBe('txt')
    expect(result.markdown).toContain('## EXPERIENCE')
  })

  it('asks for text rather than saving nothing', async () => {
    await expect(importPastedResume('   ')).rejects.toMatchObject({ code: 'no_text' })
  })
})

describe('importResumeFile — .pdf', () => {
  it('extracts the text layer and infers structure with no model', async () => {
    const pdf = await pdfWithLines([
      'Jane Q. Doe',
      'jane.doe@example.com | 555-0100',
      '',
      'EXPERIENCE',
      '',
      'Senior Engineer, Northwind Payments',
      'Mar 2019 - Present',
      '* Led the migration of the ledger service to Postgres.',
      '',
      'EDUCATION',
      '',
      'B.S. Computer Science, University of Washington, 2015',
    ])
    const result = await importResumeFile({ filename: 'resume.pdf', bytes: pdf })
    expect(result.format).toBe('pdf')
    expect(result.method).toBe('PDF text, structure inferred')
    expect(result.markdown).toContain('# Jane Q. Doe')
    expect(result.markdown).toContain('## EXPERIENCE')
    expect(result.markdown).toContain('## EDUCATION')
    expect(result.markdown).toContain('- Led the migration of the ledger service to Postgres.')
    expect(result.markdown).toContain('**Senior Engineer, Northwind Payments — Mar 2019 - Present**')
    expect(parseResumeMarkdown(result.markdown).filter((b) => b.type === 'heading')).toHaveLength(3)
  }, 20_000)

  it('asks for the picture to be read when the PDF has no text layer', async () => {
    const blank = await pdfWithLines([])
    await expect(importResumeFile({ filename: 'scan.pdf', bytes: blank })).rejects.toMatchObject({
      code: 'needs_transcribe',
      status: 422,
    })
  }, 20_000)
})

describe('importResumeFile: pictures', () => {
  it('asks for a transcription instead of guessing', async () => {
    await expect(
      importResumeFile({ filename: 'resume.jpg', mimeType: 'image/jpeg', bytes: Buffer.from([1, 2, 3]) })
    ).rejects.toMatchObject({ code: 'needs_transcribe', status: 422 })
  })

  it('rejects an iPhone HEIC photo with the export-as-JPEG remedy', async () => {
    await expect(
      importResumeFile({ filename: 'IMG_1.HEIC', mimeType: 'image/heic', bytes: Buffer.from([1, 2, 3]) })
    ).rejects.toMatchObject({ code: 'heic_unsupported', message: expect.stringContaining('JPEG') })
  })
})
