// The editor's state machine, its markup, and the saver's request. No jsdom:
// the reducer is pure and the markup is rendered to a string (see
// components/resume/resume-workspace.test.tsx).

import { describe, expect, it, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_TEMPLATE_ID } from '@/lib/resume/templates'
import { editorReducer, initEditor, isDirty, ResumeEditor } from './resume-editor'
import { saveResumeVersion } from './save-resume'
import type { EditorProps } from './types'

const MARKDOWN = '# Jane Doe\njane@example.com\n\n## Experience\n\n- Shipped billing'
const base = initEditor({ markdown: MARKDOWN, templateId: DEFAULT_TEMPLATE_ID, versionLabel: 'Version 1' })

function render(overrides: Partial<EditorProps> = {}): string {
  return renderToStaticMarkup(
    createElement(ResumeEditor, {
      markdown: MARKDOWN,
      versionLabel: 'Version 1',
      templateId: DEFAULT_TEMPLATE_ID,
      onSave: async () => ({ ok: false }),
      ...overrides,
    })
  )
}

describe('editorReducer', () => {
  it('is clean on open and dirty after an edit', () => {
    expect(isDirty(base)).toBe(false)
    expect(isDirty(editorReducer(base, { type: 'edit', markdown: MARKDOWN + '\n- More' }))).toBe(true)
  })

  it('is dirty after a template change alone', () => {
    expect(isDirty(editorReducer(base, { type: 'template', templateId: 'other' }))).toBe(true)
  })

  it('a failed save keeps the buffer and stays dirty', () => {
    const typed = editorReducer(base, { type: 'edit', markdown: 'typed text' })
    const failed = editorReducer(editorReducer(typed, { type: 'saving' }), { type: 'failed' })
    expect(failed.markdown).toBe('typed text')
    expect(failed.status).toBe('failed')
    expect(isDirty(failed)).toBe(true)
  })

  it('a good save takes the canonical Markdown, the new label and is clean', () => {
    const typed = editorReducer(base, { type: 'edit', markdown: 'typed text' })
    const saved = editorReducer(typed, { type: 'saved', markdown: '# Canonical', versionLabel: 'Version 2' })
    expect(saved.markdown).toBe('# Canonical')
    expect(saved.versionLabel).toBe('Version 2')
    expect(isDirty(saved)).toBe(false)
  })
})

describe('ResumeEditor markup', () => {
  it('names every toolbar key with its shortcut and a pressed state', () => {
    const html = render()
    for (const label of ['Bold (Ctrl+B)', 'Italic (Ctrl+I)', 'Insert link (Ctrl+K)']) {
      expect(html).toContain(`aria-label="${label}"`)
    }
    const toolbar = html.slice(html.indexOf('aria-label="Resume formatting"'), html.indexOf('<textarea'))
    expect(toolbar.split('aria-pressed=').length - 1).toBe(8)
  })

  it('lists the save shortcut and disables Save while clean', () => {
    const html = render()
    expect(html).toContain('Save as a new version')
    expect(html).toContain('aria-keyshortcuts="Control+S Meta+S"')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save as a new version/)
  })

  it('offers Diff only with a compare', () => {
    expect(render()).not.toContain('>Diff<')
    expect(render({ compare: { label: 'Base resume', markdown: '# Jane' } })).toContain('>Diff<')
  })

  it('renders no template picker for a letter', () => {
    expect(render()).toContain('Template')
    const letter = render({ templateId: null, markdown: 'Dear team,\n\nHello.' })
    expect(letter).not.toContain('Template')
    expect(letter).toContain('<textarea')
  })

  it('read only shows no Save and no editing surface', () => {
    const html = render({ readOnly: true })
    expect(html).not.toContain('Save as a new version')
    expect(html).not.toContain('<textarea')
  })

  it('its own files use no raw shadow, gradient or backdrop class (Relief contract)', () => {
    for (const file of ['markdown-toolbar.tsx', 'markdown-editor.tsx', 'resume-workspace.tsx', 'resume-diff.tsx', 'editor/resume-editor.tsx']) {
      const code = readFileSync(join(__dirname, '..', file), 'utf8').replace(/\/\/.*$/gm, '')
      expect(code, file).not.toMatch(/shadow-|bg-gradient|backdrop-|box-shadow/)
    }
  })
})

describe('saveResumeVersion', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('posts the edit into the version\'s own bucket as source edited', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ document: { version: 4 }, markdown: '# Canonical' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchStub)
    const result = await saveResumeVersion({ jobId: 'job-1', markdown: '# Jane', templateId: 'classic' })
    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/resume/documents')
    expect(JSON.parse(init.body as string)).toEqual({ action: 'save', jobId: 'job-1', markdown: '# Jane', templateId: 'classic', source: 'edited' })
    expect(result).toEqual({ ok: true, markdown: '# Canonical', versionLabel: 'Version 4' })
  })

  it('maps a server error and a network failure to ok false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"no"}', { status: 500 })))
    expect(await saveResumeVersion({ jobId: null, markdown: 'x', templateId: null })).toEqual({ ok: false })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await saveResumeVersion({ jobId: null, markdown: 'x', templateId: null })).toEqual({ ok: false })
  })
})
