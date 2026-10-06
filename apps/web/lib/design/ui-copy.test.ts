// Every string a person can read in the product is held to one voice:
// sentence case, plain verbs, no em dashes, no emoji, no exclamation marks, no
// word for what was sent that Cello retired, and none of the phrases that mark
// copy as generated. This test reads the source of every screen (app/ outside
// api/, and components/), drops the comments, and scans what is left.
//
// Screens that broke the rule before this test existed are listed in
// ui-copy.allow.ts with their count of violations. A listed file may not get
// worse and an unlisted file may not have any. The sweep that rewrites those
// screens empties the list.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { UI_COPY_BASELINE } from './ui-copy.allow'

const ROOT = path.resolve(__dirname, '../..')
const SCAN_DIRS = ['app', 'components']
const SKIP_DIRS = new Set(['api', 'node_modules', '.next'])

const BANNED_PHRASES = [
  /\bunlocks?\b/i,
  /\bsupercharged?s?\b/i,
  /\bseamless(ly)?\b/i,
  /\belevates?\b/i,
  /\beffortless(ly)?\b/i,
  /\brevolutioni[sz]e[sd]?\b/i,
  /\bAI[- ]powered\b/i,
  /\bmagic(al)?\b/i,
  /\bgame[- ]changer\b/i,
  /\bgame[- ]changing\b/i,
  /\bdive in\b/i,
]

// The word for what was sent. Cello says sent, applied or saved. In a string literal it counts only
// when the string has a space in it, so an import path or an identifier never does.
const RETIRED_WORD = /\breceipts?\b/i

// © and ® are Extended_Pictographic too; neither is an emoji in practice.
const EMOJI = /(?![©®])\p{Extended_Pictographic}|[\u{1F000}-\u{1FAFF}]|[☀-➿]️?/u
const EM_DASH = /—|&mdash;|&#8212;|\\u2014/

export function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) out.push(...listSourceFiles(full))
      continue
    }
    if (!/\.tsx?$/.test(entry)) continue
    if (/\.test\.tsx?$/.test(entry)) continue
    out.push(full)
  }
  return out
}

/** Blank out comments in place, so line numbers survive. */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|\s)\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '))
}

const JSX_TEXT = />([^<>{}]*[A-Za-z][^<>{}]*)</g

/** What a person could read: JSX text nodes and string literals. */
export function readableStrings(code: string): { text: string; jsx: boolean }[] {
  const out: { text: string; jsx: boolean }[] = []
  for (const m of code.matchAll(JSX_TEXT)) out.push({ text: m[1], jsx: true })
  for (const m of code.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
    out.push({ text: m[1] ?? m[2] ?? m[3] ?? '', jsx: false })
  }
  return out
}

interface Violation {
  file: string
  line: number
  rule: string
  text: string
}

export function scanSource(file: string, source: string): Violation[] {
  const code = stripComments(source)
  const found: Violation[] = []

  code.split('\n').forEach((line, index) => {
    const at = index + 1
    if (EM_DASH.test(line)) found.push({ file, line: at, rule: 'em dash', text: line.trim() })
    if (EMOJI.test(line)) found.push({ file, line: at, rule: 'emoji', text: line.trim() })
    for (const { text, jsx } of readableStrings(line)) {
      for (const phrase of BANNED_PHRASES) {
        if (phrase.test(text)) found.push({ file, line: at, rule: `banned phrase ${phrase.source}`, text: text.trim() })
      }
      if (RETIRED_WORD.test(text) && (jsx || /\s/.test(text.trim()))) {
        found.push({ file, line: at, rule: 'retired word for what was sent', text: text.trim() })
      }
    }
    // Exclamation marks only count in text a person reads between tags.
    for (const m of line.matchAll(JSX_TEXT)) {
      if (m[1].includes('!')) found.push({ file, line: at, rule: 'exclamation mark', text: m[1].trim() })
    }
  })
  return found
}

/** Violations per file, and the files that are over what the baseline allows them. */
export function overBaseline(violations: Violation[], baseline: Record<string, number>): { counts: Record<string, number>; over: string[] } {
  const counts: Record<string, number> = {}
  for (const v of violations) counts[v.file] = (counts[v.file] ?? 0) + 1
  const over = Object.entries(counts)
    .filter(([file, n]) => n > (baseline[file] ?? 0))
    .map(([file, n]) => `${file}: ${n} found, ${baseline[file] ?? 0} allowed`)
  return { counts, over }
}

describe('UI copy', () => {
  const files = SCAN_DIRS.flatMap((dir) => listSourceFiles(path.join(ROOT, dir)))

  it('scans every screen', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it('has nothing worse than the baseline: no em dashes, emoji, exclamation marks, retired word or generated-sounding phrases', () => {
    const violations = files.flatMap((file) => scanSource(path.relative(ROOT, file), readFileSync(file, 'utf8')))
    const { counts, over } = overBaseline(violations, UI_COPY_BASELINE)
    const detail = violations
      .filter((v) => over.some((o) => o.startsWith(`${v.file}:`)))
      .map((v) => `${v.file}:${v.line} [${v.rule}] ${v.text.slice(0, 120)}`)
      .join('\n')
    // The current map, ready to paste into ui-copy.allow.ts when a screen is listed on purpose.
    expect(over, `\n${detail}\n\nCurrent counts, sorted:\n${JSON.stringify(Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`).toEqual([])
  })

  it('catches each rule on a sample', () => {
    const sample = [
      "const a = 'Unlock your potential'",
      '<p>Done!</p>',
      '<p>Jobs — ranked</p>',
      '<span>\u{1F389}</span>',
      '// a comment — with a dash is fine',
      "const url = 'https://example.com/path' // trailing comment — fine",
      '<p>View your receipt</p>',
      "const msg = 'Your receipt is saved'",
    ].join('\n')
    const rules = scanSource('sample.tsx', sample).map((v) => `${v.line}:${v.rule}`)
    expect(rules).toEqual([
      '1:banned phrase \\bunlocks?\\b',
      '2:exclamation mark',
      '3:em dash',
      '4:emoji',
      '7:retired word for what was sent',
      '8:retired word for what was sent',
    ])
  })

  it('does not count the retired word in an import path or an identifier', () => {
    const source = ["import { listReceipts } from '@/lib/applications/receipts'", "const key = 'receipt'", 'const rows = await listReceipts()'].join('\n')
    expect(scanSource('sample.tsx', source)).toEqual([])
  })

  it('fails an unlisted file with one violation, and a listed file that gets worse', () => {
    const one = scanSource('components/new.tsx', '<p>Jobs — ranked</p>')
    expect(overBaseline(one, {}).over).toEqual(['components/new.tsx: 1 found, 0 allowed'])
    const two = scanSource('components/old.tsx', ['<p>Jobs — ranked</p>', '<p>Done!</p>'].join('\n'))
    expect(overBaseline(two, { 'components/old.tsx': 2 }).over).toEqual([])
    expect(overBaseline(two, { 'components/old.tsx': 1 }).over).toEqual(['components/old.tsx: 2 found, 1 allowed'])
  })
})
