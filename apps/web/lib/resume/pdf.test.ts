// The PDF exporter, read back the way an employer's parser reads it: with unpdf, from the file.
// Nothing here looks at how the document was built. If a template drops a line, reorders one or
// breaks a word, the text that comes back is different and the test fails.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractText, getDocumentProxy } from 'unpdf'

import { parseResumeMarkdown, type ResumeBlock } from './markdown'
import { renderResumeBlocksPdf, renderResumePdf, renderResumeVersionPdf } from './pdf'
import { resumeToMarkdown } from './render'
import { DEFAULT_TEMPLATE_ID, RESUME_TEMPLATES } from './templates'
import { CANONICAL_RESUME, DOCX_STYLE_MD, LEGACY_TAILORED_TEXT, PDF_INFER_MD } from './test-fixtures'

/** Whitespace folded and case dropped: templates upper-case headings, and wrapping moves line breaks. */
const squash = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

async function readBack(bytes: Uint8Array) {
  const pdf = await getDocumentProxy(new Uint8Array(bytes))
  const { text, totalPages } = await extractText(pdf, { mergePages: true })
  return { text: squash(text), pages: totalPages, pdf }
}

/** Every authored line of the resume, in source order: the name, each heading, each paragraph line, each bullet. */
function authoredLines(blocks: readonly ResumeBlock[]): string[] {
  const plain = (line: { text: string }[]) => line.map((r) => r.text).join('')
  return blocks.flatMap((b) => {
    if (b.type === 'heading' || b.type === 'paragraph') return b.lines.map(plain)
    if (b.type === 'list') return b.items.flatMap((i) => i.lines.map(plain))
    return []
  })
}

/** Asserts each piece appears in the text, after the one before it. */
function expectInOrder(text: string, pieces: string[], where: string) {
  let from = 0
  for (const piece of pieces.map(squash).filter(Boolean)) {
    const at = text.indexOf(piece, from)
    expect(at, `${where}: "${piece}" after position ${from}`).toBeGreaterThanOrEqual(0)
    from = at + piece.length
  }
}

const FIXTURES: [string, string][] = [
  ['canonical resume', resumeToMarkdown(CANONICAL_RESUME)],
  ['Word style markdown', DOCX_STYLE_MD],
  ['PDF-inferred markdown', PDF_INFER_MD],
  ['legacy tailored text', LEGACY_TAILORED_TEXT],
]

describe('every template reads back in order', () => {
  for (const template of RESUME_TEMPLATES) {
    for (const [name, markdown] of FIXTURES) {
      it(`${template.id}: ${name}`, async () => {
        const { text } = await readBack(await renderResumePdf(markdown, { templateId: template.id }))
        expectInOrder(text, authoredLines(parseResumeMarkdown(markdown)), `${template.id} ${name}`)
      }, 30_000)
    }
  }

  it('finds the name, every section title, every position and every highlight of the canonical resume', async () => {
    const { text } = await readBack(await renderResumePdf(resumeToMarkdown(CANONICAL_RESUME), { templateId: 'classic' }))
    const wanted = [
      CANONICAL_RESUME.basics.name,
      ...CANONICAL_RESUME.work.flatMap((w) => [w.position, ...w.highlights]),
      CANONICAL_RESUME.education[0].institution,
    ]
    expectInOrder(text, wanted, 'canonical')
    for (const title of ['experience', 'education', 'skills']) expect(text).toContain(title)
  }, 30_000)
})

describe('renderResumePdf', () => {
  it('renders empty, whitespace-only and null input as a valid PDF', async () => {
    for (const input of ['', '   \n\n  ', null, undefined]) {
      const bytes = await renderResumePdf(input)
      expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-')
    }
  }, 30_000)

  it('reads the authored markdown off a stored version', async () => {
    const bytes = await renderResumeVersionPdf({
      content: 'ignored plain text',
      content_json: { markdown: '# Jane Doe\n\n## Skills\n\n- Go' },
    })
    const { text } = await readBack(bytes)
    expect(text).toContain('jane doe')
    expect(text).not.toContain('ignored plain text')
  }, 30_000)

  it('accepts a parsed block model and matches the string entry point', async () => {
    const md = '# Jane Doe\n\n## Skills\n\n- Go\n- SQL'
    const a = await readBack(await renderResumePdf(md, { templateId: 'classic' }))
    const b = await readBack(await renderResumeBlocksPdf(parseResumeMarkdown(md), { templateId: 'classic' }))
    expect(b.text).toBe(a.text)
  }, 30_000)

  it('renders the default template for an unknown or missing id', async () => {
    const md = '# Jane Doe\n\n## Experience\n\n- Led a team'
    const def = await readBack(await renderResumePdf(md, { templateId: DEFAULT_TEMPLATE_ID }))
    expect((await readBack(await renderResumePdf(md, { templateId: 'no-such-template' }))).text).toBe(def.text)
    expect((await readBack(await renderResumePdf(md, { templateId: null }))).text).toBe(def.text)
  }, 30_000)

  it('never stacks a version label on top of the candidate name', async () => {
    const named = await readBack(await renderResumePdf('# Jane Doe\n\n## Skills\n\n- Go', { title: 'Tailored for Acme' }))
    expect(named.text).not.toContain('tailored for acme')
    const unnamed = await readBack(await renderResumePdf('- Go\n- SQL', { title: 'Tailored for Acme' }))
    expect(unnamed.text).toContain('tailored for acme')
  }, 30_000)

  it('keeps the author typography the fonts can draw and folds what they cannot', async () => {
    const { text } = await readBack(await renderResumePdf('# Jane Doe\n\nNorthwind, 2021 — Present. Cut 2s → 200ms.'))
    expect(text).toContain('2021 — present')
    expect(text).toContain('2s -> 200ms')
  }, 30_000)

  it('draws emphasis as fonts, never as markdown syntax', async () => {
    const { text } = await readBack(await renderResumePdf('# Jane Doe\n\nLed **eleven** teams with *care* and `Go`.'))
    expect(text).toContain('led eleven teams with care and go.')
    expect(text).not.toMatch(/[*`]/)
  }, 30_000)
})

describe('pagination and long lines', () => {
  it('flows 60 bullets onto two or more pages and loses none', async () => {
    const bullets = Array.from({ length: 60 }, (_, i) => `Bullet number ${i + 1} describes an outcome in enough words that it wraps onto a second line on the page.`)
    const md = ['# Jane Doe', '', '## Experience', '', ...bullets.map((b) => `- ${b}`)].join('\n')
    const { text, pages } = await readBack(await renderResumePdf(md, { templateId: 'classic' }))
    expect(pages).toBeGreaterThanOrEqual(2)
    expectInOrder(text, bullets, 'bullets')
  }, 60_000)

  it('breaks a word wider than the column without losing a character', async () => {
    const token = 'https://example.com/' + 'a-very-long-path/'.repeat(25)
    const { text } = await readBack(await renderResumePdf(`# Jane Doe\n\n${token}`))
    expect(text.replace(/ /g, '')).toContain(token.replace(/ /g, ''))
  }, 30_000)

  it('never leaves a section heading alone at the foot of a page', async () => {
    for (let filler = 38; filler <= 56; filler += 1) {
      const md = ['# Jane Doe', '', ...Array.from({ length: filler }, (_, i) => `Line ${i + 1} of filler text.\n`), '## Zz Heading', '', 'Body under the heading.'].join('\n')
      const pdf = await getDocumentProxy(new Uint8Array(await renderResumePdf(md, { templateId: 'classic' })))
      const { text: pages } = await extractText(pdf, { mergePages: false })
      for (const page of pages.slice(0, -1)) {
        const last = page.trim().split('\n').pop()!.toLowerCase()
        expect(last, `${filler} filler lines`).not.toContain('zz heading')
      }
    }
  }, 120_000)
})

describe('links', () => {
  it('renders the link text and attaches a real link, not the address as text', async () => {
    const bytes = await renderResumePdf('# Jane Doe\n\nSee my [portfolio](https://jane.dev/work) for details.')
    const { text, pdf } = await readBack(bytes)
    expect(text).toContain('see my portfolio for details.')
    expect(text).not.toContain('jane.dev')
    const links = (await (await pdf.getPage(1)).getAnnotations()).filter((a: { subtype?: string }) => a.subtype === 'Link')
    expect(links.map((l: { url?: string }) => l.url)).toEqual(['https://jane.dev/work'])
  }, 30_000)

  it('leaves an odd scheme as plain text with no link', async () => {
    const { text, pdf } = await readBack(await renderResumePdf('# Jane Doe\n\n[click](javascript:alert(1)) here'))
    expect(text).toContain('click here')
    expect(await (await pdf.getPage(1)).getAnnotations()).toHaveLength(0)
  }, 30_000)
})

describe('templates change the document', () => {
  it('sets the name at each template\'s own size', async () => {
    const sizes = new Set<number>()
    for (const template of RESUME_TEMPLATES) {
      const { pdf } = await readBack(await renderResumePdf('# Jane Doe\n\n## Skills\n\n- Go', { templateId: template.id }))
      const items = (await (await pdf.getPage(1)).getTextContent()).items as { str: string; transform: number[] }[]
      const name = items.find((i) => i.str.toLowerCase().includes('jane doe'))!
      expect(Math.abs(name.transform[3]), template.id).toBeCloseTo(template.nameBlock.nameSize, 0)
      sizes.add(template.nameBlock.nameSize)
    }
    expect(sizes.size).toBeGreaterThan(1)
  }, 60_000)
})

describe('no pdf-lib', () => {
  it('is in no file under apps/web and not in package.json', () => {
    const root = join(__dirname, '..', '..')
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (['node_modules', '.next', '.git'].includes(entry)) continue
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.(ts|tsx|js|mjs|json)$/.test(entry) && !full.endsWith('pdf.test.ts') && /pdf-lib/.test(readFileSync(full, 'utf8'))) hits.push(full.slice(root.length))
      }
    }
    walk(root)
    expect(hits).toEqual([])
  })
})
