// The template picker's two non-negotiable properties.
//
//  1. IT READS THE REGISTRY. The user asked to "choose any templates", so a
//     template added to lib/resume/templates.ts must appear here with no UI
//     change. These tests derive their expectations from RESUME_TEMPLATES
//     itself, so a hardcoded option list in the component fails them.
//  2. IT IS A REAL RADIO GROUP. Native inputs inside a fieldset/legend, exactly
//     one checked, one shared name — that is what gives a keyboard user arrow-key
//     navigation and a screen-reader user the group's name and position. Divs
//     with onClick look identical in a screenshot and are unusable without a
//     mouse, which is precisely the regression worth pinning.
//
// react-dom/server, because vitest.config.ts configures no jsdom environment
// (see components/copilot/observation-view.test.tsx).

import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RESUME_TEMPLATES, DEFAULT_TEMPLATE_ID } from '@/lib/resume/templates'
import { TemplatePicker } from './template-picker'

function render(value: string): string {
  return renderToStaticMarkup(
    createElement(TemplatePicker, { value, onChange: () => undefined })
  )
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('TemplatePicker', () => {
  it('offers every template in the registry, with its name and description', () => {
    const html = render(DEFAULT_TEMPLATE_ID)
    expect(count(html, 'type="radio"')).toBe(RESUME_TEMPLATES.length)
    for (const spec of RESUME_TEMPLATES) {
      expect(html).toContain(`value="${spec.id}"`)
      expect(html).toContain(spec.name)
      expect(html).toContain(spec.description)
    }
  })

  it('is a grouped set of native radios — one name, one checked option', () => {
    const html = render('classic')
    expect(html).toContain('<fieldset')
    expect(html).toContain('<legend')
    expect(count(html, 'name="resume-template"')).toBe(RESUME_TEMPLATES.length)
    expect(count(html, 'checked=""')).toBe(1)
  })

  it('checks the option that matches `value`', () => {
    for (const spec of RESUME_TEMPLATES) {
      const inputs = render(spec.id).match(/<input[^>]*>/g) ?? []
      const checked = inputs.filter((tag) => tag.includes('checked'))
      expect(checked).toHaveLength(1)
      expect(checked[0]).toContain(`value="${spec.id}"`)
    }
  })

  it('checks nothing rather than throwing when the stored id is unknown', () => {
    const html = render('a-template-we-retired')
    expect(count(html, 'checked=""')).toBe(0)
    expect(count(html, 'type="radio"')).toBe(RESUME_TEMPLATES.length)
  })

  it('keeps the radios focusable — sr-only, never display:none or hidden', () => {
    const html = render(DEFAULT_TEMPLATE_ID)
    expect(html).toContain('peer sr-only')
    expect(html).not.toContain('type="hidden"')
    // A positive tabIndex reorders the whole page's tab sequence.
    expect(html).not.toMatch(/tabindex="[1-9]/)
  })

  it('renders the focus ring against the visible card, not the clipped input', () => {
    // The input is invisible, so `peer-focus-visible:` on the card is the only
    // thing that shows a keyboard user where they are.
    expect(render(DEFAULT_TEMPLATE_ID)).toContain('peer-focus-visible:ring-2')
  })

  it('hides the decorative thumbnails from assistive technology', () => {
    // The name and description carry the meaning; the miniature is a picture of
    // a page and would otherwise be read out as a pile of empty boxes.
    expect(count(render(DEFAULT_TEMPLATE_ID), 'aria-hidden="true"')).toBe(RESUME_TEMPLATES.length)
  })

  it('draws each thumbnail from its own spec, so no two look alike', () => {
    const thumbnails = RESUME_TEMPLATES.map((spec) => {
      const html = render(spec.id)
      const start = html.indexOf(`value="${spec.id}"`)
      return html.slice(start, start + 2000)
    })
    expect(new Set(thumbnails).size).toBe(RESUME_TEMPLATES.length)
  })
})
