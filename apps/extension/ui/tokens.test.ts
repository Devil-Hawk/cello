import { describe, expect, it } from 'vitest'
import { contrastRatio, TOKENS, tokenCss } from './tokens'

// The pairs the popup and the page bar actually draw. Text is held to 4.5 to 1 and the
// glyphs (the bead, the check, the stop mark) to 3 to 1, in both appearances.
const TEXT_ON_SURFACE = ['ink', 'ink2', 'ink3'] as const
const GLYPHS = ['petrol', 'ok', 'stop'] as const

for (const mode of ['light', 'dark'] as const) {
  describe(`${mode} appearance`, () => {
    const t = TOKENS[mode]
    it.each(TEXT_ON_SURFACE)('%s text reads on the surface and the ground', (name) => {
      expect(contrastRatio(t[name], t.surface)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(t[name], t.ground)).toBeGreaterThanOrEqual(4.5)
    })
    it('the primary button label reads on its fill', () => {
      expect(contrastRatio(t.btnFg, t.copperText)).toBeGreaterThanOrEqual(4.5)
    })
    it.each(GLYPHS)('the %s glyph shows against the surface', (name) => {
      expect(contrastRatio(t[name], t.surface)).toBeGreaterThanOrEqual(3)
    })
  })
}

describe('tokenCss', () => {
  it('writes every role for both appearances as custom properties', () => {
    const css = tokenCss(':root')
    for (const name of Object.keys(TOKENS.light)) expect(css).toContain(`--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:`)
    expect(css).toContain('prefers-color-scheme: dark')
    expect(css).toContain(`--surface:${TOKENS.dark.surface}`)
  })
})
