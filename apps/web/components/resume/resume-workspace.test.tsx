// A smoke test over the assembled workspace — editor + toolbar + picker +
// preview — for the accessibility properties that are easy to regress and
// invisible in review.
//
// The app was taken from 16 axe violations to 0 immediately before this feature
// landed, and every control added here is a way to put one back: icon-only
// toolbar buttons with no accessible name, toggles that signal state with colour
// alone, an unlabelled editing surface, a view switcher with no group name. Each
// of those is asserted below against the real rendered markup.
//
// react-dom/server, because vitest.config.ts configures no jsdom environment
// (see components/copilot/observation-view.test.tsx). Effects do not run, which
// is fine: nothing asserted here depends on one.

import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_TEMPLATE_ID } from '@/lib/resume/templates'
import { ResumeWorkspace, type ResumeWorkspaceProps } from './resume-workspace'

const MARKDOWN = '# Jane Doe\njane@example.com\n\n## Experience\n\n- Shipped billing'

function render(overrides: Partial<ResumeWorkspaceProps> = {}): string {
  return renderToStaticMarkup(
    createElement(ResumeWorkspace, {
      markdown: MARKDOWN,
      onMarkdownChange: () => undefined,
      templateId: DEFAULT_TEMPLATE_ID,
      onTemplateChange: () => undefined,
      ...overrides,
    })
  )
}

describe('ResumeWorkspace — accessible names', () => {
  it('names every icon-only formatting button and its shortcut', () => {
    const html = render()
    for (const label of [
      'Bold (Ctrl+B)',
      'Italic (Ctrl+I)',
      'Heading 1 — your name',
      'Heading 2 — section title',
      'Heading 3 — role or company',
      'Bulleted list',
      'Numbered list',
      'Insert link (Ctrl+K)',
    ]) {
      expect(html).toContain(`aria-label="${label}"`)
    }
  })

  it('exposes the formatting buttons as toggles, not as colour changes', () => {
    const html = render()
    // Scoped to the toolbar: the view switcher next to it also uses aria-pressed.
    const toolbar = html.slice(
      html.indexOf('aria-label="Resume formatting"'),
      html.indexOf('<textarea')
    )
    // Eight buttons; the link button is an action, the other seven are toggles —
    // all of them still report a pressed state so nothing announces as a plain
    // button that behaves like a toggle.
    expect(toolbar.split('aria-pressed=').length - 1).toBe(8)
  })

  it('names the editing surface and the formatting group', () => {
    const html = render()
    expect(html).toContain('aria-label="Resume editor"')
    expect(html).toContain('aria-label="Resume formatting"')
  })

  it('names the view switcher and the template group', () => {
    const html = render({ compareMarkdown: 'old' })
    expect(html).toContain('aria-label="Document view"')
    expect(html).toContain('<legend')
    expect(html).toContain('Template')
  })

  it('never uses a positive tabIndex', () => {
    expect(render({ compareMarkdown: 'old' })).not.toMatch(/tabindex="[1-9]/)
  })
})

describe('ResumeWorkspace — panes', () => {
  it('shows Edit and Preview, and offers Diff only when there is something to compare', () => {
    const without = render()
    expect(without).toContain('Edit')
    expect(without).toContain('Preview')
    expect(without).not.toContain('>Diff<')

    const withCompare = render({ compareMarkdown: '# Jane Doe\n\n## Experience' })
    expect(withCompare).toContain('>Diff<')
  })

  it('renders the live preview beside the editor in edit mode', () => {
    const html = render()
    expect(html).toContain('aria-label="Live preview of the formatted resume"')
    expect(html).toContain('<textarea')
  })

  it('falls back to editing when Diff is requested with nothing to compare', () => {
    const html = render({ mode: 'diff', compareMarkdown: null })
    expect(html).toContain('<textarea')
    expect(html).not.toContain('Comparing versions')
  })

  it('shows the diff when one is requested and available', () => {
    const html = render({ mode: 'diff', compareMarkdown: '# Jane Doe', compareLabel: 'v1' })
    expect(html).toContain('Comparing versions')
    expect(html).toContain('v1')
  })

  it('read-only shows the typeset document and no editing surface', () => {
    const html = render({ readOnly: true })
    expect(html).not.toContain('<textarea')
    expect(html).not.toContain('aria-label="Resume formatting"')
    expect(html).toContain('aria-label="Formatted resume preview"')
  })

  it('renders the document, not a plain-text dump of the Markdown', () => {
    const html = render({ mode: 'preview' })
    expect(html).toContain('<h2')
    expect(html).toContain('<li')
    // The `#` and `-` markers are formatting instructions, not content.
    expect(html).not.toContain('# Jane Doe')
    expect(html).not.toContain('- Shipped billing')
  })
})
