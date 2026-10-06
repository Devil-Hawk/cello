// The colours of the popup and the page bar are the web app's own tokens
// (apps/web/components/ui/contract.ts), so the two cannot drift. ui/tokens.test.ts holds every
// pair to WCAG AA. This file turns them into CSS.
import { TOKENS } from '../../web/components/ui/contract'

export { TOKENS, contrastRatio } from '../../web/components/ui/contract'

const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
const vars = (set: Record<string, string>): string =>
  Object.entries(set)
    .map(([k, v]) => `--${kebab(k)}:${v};`)
    .join('')

/** CSS custom properties for both appearances, e.g. `--copper-text`, under `selector` (:root or :host). */
export function tokenCss(selector: string): string {
  return `${selector}{color-scheme:light dark;${vars(TOKENS.light)}}@media (prefers-color-scheme: dark){${selector}{${vars(TOKENS.dark)}}}`
}
