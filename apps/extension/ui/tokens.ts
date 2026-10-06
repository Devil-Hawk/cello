// The colours of the popup and the page bar are the web app's own tokens
// (apps/web/components/ui/contract.ts), so the two cannot drift. ui/tokens.test.ts holds every
// pair to WCAG AA. This file turns them into CSS; its contrast check stays local because the
// web copy does not compile under the extension's stricter indexing rules.
import { TOKENS } from '../../web/components/ui/contract'

export { TOKENS }

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
  const hi = Math.max(luminance(a), luminance(b))
  const lo = Math.min(luminance(a), luminance(b))
  return (hi + 0.05) / (lo + 0.05)
}
