// lane-stub: PG0 tokens
//
// The colours of the popup and the page bar. These are the same values as TOKENS in
// apps/web/components/ui/contract.ts (shell-pages' PG0), copied because that file is not
// on main yet. When it is, this file becomes
//   export { TOKENS, contrastRatio } from '../../web/components/ui/contract'
// and keeps only tokenCss. ui/tokens.test.ts holds every pair below to WCAG AA.

export const TOKENS = {
  light: {
    ground: '#ecebe7',
    surface: '#fafaf8',
    raised: '#fefefd',
    ink: '#1a1b1f',
    ink2: '#5a5d65',
    ink3: '#666971',
    copper: '#c2641a',
    copperText: '#a9500f',
    petrol: '#3a8686',
    petrolText: '#2e7373',
    ok: '#2f7a4d',
    stop: '#b4402d',
    mark: '#1a1b1f',
    btnFg: '#ffffff',
  },
  dark: {
    ground: '#17181c',
    surface: '#202126',
    raised: '#292a30',
    ink: '#ecebe7',
    ink2: '#b4b7bf',
    ink3: '#94979f',
    copper: '#e0905a',
    copperText: '#e0905a',
    petrol: '#5fb3b3',
    petrolText: '#5fb3b3',
    ok: '#5cb57e',
    stop: '#e07a66',
    mark: '#0e0f12',
    btnFg: '#17181c',
  },
} as const

const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
const vars = (set: Record<string, string>): string =>
  Object.entries(set)
    .map(([k, v]) => `--${kebab(k)}:${v};`)
    .join('')

/** CSS custom properties for both appearances, e.g. `--copper-text`, under `selector` (:root or :host). */
export function tokenCss(selector: string): string {
  return `${selector}{color-scheme:light dark;${vars(TOKENS.light)}}@media (prefers-color-scheme: dark){${selector}{${vars(TOKENS.dark)}}}`
}

function channel(hex: string, at: number): number {
  const c = parseInt(hex.slice(at, at + 2), 16) / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function luminance(hex: string): number {
  const h = hex.replace('#', '')
  return 0.2126 * channel(h, 0) + 0.7152 * channel(h, 2) + 0.0722 * channel(h, 4)
}

/** WCAG contrast ratio of two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
