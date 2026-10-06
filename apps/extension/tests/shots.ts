import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { contrastRatio } from '../ui/tokens'

// What the popup and bar specs share: a screenshot saved where CI uploads it, the 44px
// target check, the contrast of drawn text, and the copy scan.

const DIR = path.resolve(__dirname, '../test-results/shots')

export async function shoot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(DIR, { recursive: true })
  await page.screenshot({ path: path.join(DIR, `${name}.png`) })
}

/** The width and height of every control matched, as drawn. */
export async function sizes(loc: Locator): Promise<Array<{ label: string; width: number; height: number }>> {
  return loc.evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect()
      return { label: (e.textContent ?? '').trim(), width: r.width, height: r.height }
    }),
  )
}

const hex = (c: number[]): string => '#' + c.slice(0, 3).map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')

/** Contrast of an element's text against the first opaque background behind it, as the browser drew them. */
export async function contrastOf(loc: Locator): Promise<number> {
  const [fg, bg] = await loc.evaluate((el) => {
    const parse = (c: string): number[] => (c.match(/[\d.]+/g) ?? ['0', '0', '0', '0']).map(Number)
    let node: Element | null = el
    let back = [255, 255, 255]
    while (node) {
      const c = parse(getComputedStyle(node).backgroundColor)
      if ((c[3] ?? 1) > 0) {
        back = c
        break
      }
      node = node.parentElement ?? ((node.getRootNode() as ShadowRoot).host ?? null)
    }
    return [parse(getComputedStyle(el).color), back]
  })
  return contrastRatio(hex(fg as number[]), hex(bg as number[]))
}

/** Words Cello never uses in its own copy. */
export function copyProblems(text: string): string[] {
  const out: string[] = []
  if (/—/.test(text)) out.push('an em dash')
  if (/!/.test(text)) out.push('an exclamation mark')
  if (/receipt/i.test(text)) out.push('the word receipt')
  return out
}
