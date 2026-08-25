// What the formatted preview is allowed to put on screen.
//
// Two properties matter enough to pin down, and neither is visible in a
// screenshot:
//
//  1. SAFETY. Resume text arrives from an uploaded file and from an LLM
//     rewrite, and this component turns it into DOM. If rehype-sanitize is ever
//     dropped — or paired with rehype-raw by someone adding "HTML support" —
//     these tests fail loudly instead of the studio quietly gaining a script
//     injection point.
//  2. HONESTY. The preview exists to stop the studio lying about what will be
//     exported, so every lowering rule in lib/resume/markdown.ts has to hold
//     here too: no <img>, no <blockquote>, no <del>, and no table grid.
//
// Rendered with react-dom/server rather than a DOM testing library: vitest.config.ts
// configures no jsdom environment (see components/copilot/observation-view.test.tsx),
// and static markup is enough for both claims.

import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { getTemplate } from '@/lib/resume/templates'
import { ResumePreview } from './resume-preview'
import { pt } from './template-preview-style'

function render(markdown: string, templateId = 'modern'): string {
  return renderToStaticMarkup(createElement(ResumePreview, { markdown, templateId }))
}

describe('ResumePreview — untrusted input', () => {
  it('drops raw HTML instead of rendering it', () => {
    const html = render('# Jane Doe\n\n<script>alert(1)</script>\n\n<b>not bold</b>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
    expect(html).not.toContain('<b>not bold</b>')
  })

  it('strips an event-handler attribute smuggled in as raw HTML', () => {
    const html = render('Intro\n\n<img src=x onerror="alert(1)">')
    expect(html).not.toContain('onerror')
  })

  it('neutralises a javascript: link target while keeping the label', () => {
    const html = render('[Portfolio](javascript:alert(1))')
    expect(html).toContain('Portfolio')
    expect(html).not.toContain('javascript:alert')
  })

  it('does not execute or emit an iframe', () => {
    expect(render('<iframe src="https://evil.example"></iframe>')).not.toContain('<iframe')
  })
})

describe('ResumePreview — agrees with what the exporter will produce', () => {
  it('renders a GFM table as flat rows, never as a grid', () => {
    // lib/resume/markdown.ts lowers each ROW to a paragraph with cells joined by
    // " — " because a table is the top ATS-mangling risk. The DOM keeps <tr>/<td>
    // for semantics; the stylesheet is what flattens them, so assert both the
    // content survives and the flattening rules are still present.
    const html = render('| Skill | Years |\n| --- | --- |\n| TypeScript | 8 |')
    expect(html).toContain('TypeScript')
    expect(html).toContain('.rp-sheet tr { margin-bottom')
    expect(html).toContain('.rp-sheet table, .rp-sheet thead, .rp-sheet tbody, .rp-sheet tr { display: block')
    expect(html).toContain('content: " — "')
  })

  it('keeps an image’s alt text and nothing else', () => {
    const html = render('![Headshot of Jane](https://example.com/jane.png)')
    expect(html).toContain('Headshot of Jane')
    expect(html).not.toContain('<img')
  })

  it('splices a blockquote in as ordinary blocks', () => {
    const html = render('> Reference available on request')
    expect(html).toContain('Reference available on request')
    expect(html).not.toContain('<blockquote')
  })

  it('keeps struck-through words and drops the mark', () => {
    const html = render('~~Contractor~~ Staff Engineer')
    expect(html).toContain('Contractor')
    expect(html).not.toContain('<del')
  })

  it('clamps h4-h6 to level 3, as the block model does', () => {
    const html = render('#### Deeply nested heading')
    expect(html).toContain('<h3')
    expect(html).not.toContain('<h4')
  })

  it('numbers an ordered list from the source’s own start value', () => {
    // lib/resume/markdown.ts writes "5."/"6." for this input (it respects the
    // list's `start`). The preview draws its numbers with a CSS counter, which
    // restarts at 1 unless the element seeds it — so dropping `start` here is a
    // silent disagreement with the exported document, not a visual nit.
    expect(render('5. Fifth\n6. Sixth')).toContain('counter-reset:rp-ol 4')
    expect(render('1. First\n2. Second')).toContain('counter-reset:rp-ol 0')
  })

  it('renders bullets as a real list, with list semantics kept explicit', () => {
    const html = render('- Shipped billing\n- Cut latency 40%')
    expect(html).toContain('<ul role="list"')
    expect(html).toContain('<li')
    expect(html).toContain('Cut latency 40%')
  })
})

describe('ResumePreview — the template decides how it looks', () => {
  it('gives the opening name the template’s nameBlock size, not its h1 size', () => {
    const modern = getTemplate('modern')
    const html = render('# Jane Doe\njane@example.com\n\n## Experience\n\n- A thing')
    expect(html).toContain(`font-size:${pt(modern.nameBlock.nameSize)}`)
    expect(html).toContain('Jane Doe')
    // …and the section heading below it is still a real h2.
    expect(html).toContain('<h2')
  })

  it('renders the contact line in the template’s muted colour', () => {
    const modern = getTemplate('modern')
    const html = render('# Jane Doe\njane@example.com\n\n## Experience')
    expect(html).toContain(modern.colors.muted)
  })

  it('changes with the selected template', () => {
    const source = '# Jane Doe\njane@example.com\n\n## Experience\n\n- A thing'
    const classic = render(source, 'classic')
    const compact = render(source, 'compact')
    expect(classic).not.toBe(compact)
    // Classic is a serif; Compact is not.
    expect(classic).toContain('Times New Roman')
    expect(compact).not.toContain('Times New Roman')
  })

  it('falls back to the default template for an unknown id rather than failing', () => {
    expect(() => render('# Jane', 'no-such-template')).not.toThrow()
    expect(render('# Jane', 'no-such-template')).toContain(getTemplate(null).colors.text)
  })

  it('shows an empty-state line instead of a blank sheet', () => {
    expect(render('')).toContain('Nothing to preview yet')
  })

  it('exposes the pane as a labelled, keyboard-reachable region', () => {
    // A scrollable pane that cannot be focused is unreadable for a keyboard-only
    // user (axe: scrollable-region-focusable).
    const html = render('# Jane Doe')
    expect(html).toContain('role="region"')
    expect(html).toContain('aria-label="Formatted resume preview"')
    expect(html).toContain('tabindex="0"')
  })
})
