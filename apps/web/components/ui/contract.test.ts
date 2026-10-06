import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  COPY_CAPS,
  GLYPH_TOKENS,
  STILLS,
  SURFACES,
  TEXT_TOKENS,
  TOKENS,
  contrastRatio,
  type Appearance,
} from './contract'

const css = readFileSync(path.join(process.cwd(), 'app/relief.css'), 'utf8')

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  return css.slice(start, css.indexOf('\n}', start))
}

const CSS_NAME: Record<string, string> = {
  ground: '--r-ground',
  surface: '--r-surface',
  raised: '--r-raised',
  ink: '--r-ink',
  ink2: '--r-ink-2',
  ink3: '--r-ink-3',
  copper: '--r-copper',
  copperText: '--r-copper-text',
  petrol: '--r-petrol',
  petrolText: '--r-petrol-text',
  ok: '--r-ok',
  stop: '--r-stop',
  mark: '--r-mark',
  btnFg: '--r-btn-fg',
}

describe('the contract and the tokens file agree', () => {
  const blocks: Record<Appearance, string> = { light: block(':root'), dark: block('.dark') }
  for (const mode of ['light', 'dark'] as const) {
    it(`${mode} values in relief.css match contract.ts`, () => {
      for (const [key, name] of Object.entries(CSS_NAME)) {
        const m = blocks[mode].match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`))
        expect(m, `${name} in ${mode}`).not.toBeNull()
        expect(m?.[1]).toBe(TOKENS[mode][key as keyof (typeof TOKENS)['light']])
      }
    })
  }
})

describe('contrast', () => {
  for (const mode of ['light', 'dark'] as const) {
    it(`text tokens pass AA on ground, surface and raised in ${mode}`, () => {
      for (const t of TEXT_TOKENS) {
        for (const s of SURFACES) {
          const ratio = contrastRatio(TOKENS[mode][t], TOKENS[mode][s])
          expect(ratio, `${t} on ${s} (${mode}) is ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    })
    it(`glyph tokens pass 3 to 1 in ${mode}`, () => {
      for (const t of GLYPH_TOKENS) {
        for (const s of SURFACES) {
          expect(contrastRatio(TOKENS[mode][t], TOKENS[mode][s])).toBeGreaterThanOrEqual(3)
        }
      }
    })
    it(`ink key text passes AA in ${mode}`, () => {
      expect(contrastRatio(TOKENS[mode].btnFg, TOKENS[mode].ink)).toBeGreaterThanOrEqual(4.5)
    })
  }
})

describe('caps and stills', () => {
  it('holds the first screen budgets', () => {
    expect(COPY_CAPS.laptop).toEqual({ words: 90, groups: 5 })
    expect(COPY_CAPS.phone).toEqual({ words: 45, groups: 3 })
  })
  it('names the two stills', () => {
    expect([...STILLS]).toEqual(['quiet', 'empty'])
  })
})
