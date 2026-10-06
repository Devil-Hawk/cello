// Every string a person can read in the product is held to one voice:
// sentence case, plain verbs, no em dashes, no emoji, no exclamation marks, no
// word for what was sent that Cello retired, and none of the phrases that mark
// copy as generated. This test parses the source of every screen (app/ outside
// api/, and components/) and scans the text a person could read in it.
//
// Screens that broke the rule before this test existed are listed in
// ui-copy.allow.ts with their count of violations. A listed file may not get
// worse and an unlisted file may not have any. The sweep that rewrites those
// screens empties the list.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
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

// The copyright and registered signs are Extended_Pictographic too; neither is an emoji in practice.
const EMOJI = /(?![\u00A9\u00AE])\p{Extended_Pictographic}|[\u{1F000}-\u{1FAFF}]|[\u2600-\u27BF]\uFE0F?/u
const EM_DASH = /\u2014|&mdash;|&#8212;|\\u2014/

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

/**
 * What a person could read: JSX text and string or template literals, with the offset each starts at.
 * It reads the syntax tree, so text a formatter wrapped onto its own line, text beside an
 * expression ({n} roles) and multi-line templates are all seen, and code is not mistaken for text.
 */
export function readableStrings(file: string, source: string): { text: string; jsx: boolean; at: number }[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
  const out: { text: string; jsx: boolean; at: number }[] = []
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      if (/[A-Za-z]/.test(node.text)) out.push({ text: node.text, jsx: true, at: node.pos })
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      out.push({ text: node.text, jsx: false, at: node.getStart(tree) })
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return out
}

interface Violation {
  file: string
  line: number
  rule: string
  text: string
}

export function scanSource(file: string, source: string): Violation[] {
  const found: Violation[] = []

  stripComments(source).split('\n').forEach((line, index) => {
    if (EM_DASH.test(line)) found.push({ file, line: index + 1, rule: 'em dash', text: line.trim() })
    if (EMOJI.test(line)) found.push({ file, line: index + 1, rule: 'emoji', text: line.trim() })
  })

  for (const { text, jsx, at } of readableStrings(file, source)) {
    const first = at + text.length - text.trimStart().length
    const line = source.slice(0, first).split('\n').length
    for (const phrase of BANNED_PHRASES) {
      if (phrase.test(text)) found.push({ file, line, rule: `banned phrase ${phrase.source}`, text: text.trim() })
    }
    if (RETIRED_WORD.test(text) && (jsx || /\s/.test(text.trim()))) {
      found.push({ file, line, rule: 'retired word for what was sent', text: text.trim() })
    }
    // Exclamation marks only count in text a person reads between tags.
    if (jsx && text.includes('!')) found.push({ file, line, rule: 'exclamation mark', text: text.trim() })
  }
  return found.sort((a, b) => a.line - b.line)
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
      "const a = 'Unlock your potential';",
      '<p>Done!</p>;',
      '<p>Jobs \u2014 ranked</p>;',
      '<span>\u{1F389}</span>;',
      '// a comment \u2014 with a dash is fine',
      "const url = 'https://example.com/path'; // trailing comment \u2014 fine",
      '<p>View your receipt</p>;',
      "const msg = 'Your receipt is saved';",
      'const dest = `Sent to ${receipt.destination}`',
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

  it('reads text a formatter wrapped, text beside an expression, and multi-line templates', () => {
    const sample = [
      '<p>',
      '  Your receipt is saved!',
      '</p>;',
      '<p>',
      '  Get AI-powered insights',
      '</p>;',
      '<p>Saved {n} roles!</p>;',
      '<p>{n} roles are ready, seamless</p>;',
      'const t = `a',
      'seamless ${x} text`;',
      'const f = (a) => a > 1 ? b : c',
    ].join('\n')
    const rules = scanSource('sample.tsx', sample).map((v) => `${v.line}:${v.rule}`)
    expect(rules).toEqual([
      '2:retired word for what was sent',
      '2:exclamation mark',
      '5:banned phrase \\bAI[- ]powered\\b',
      '7:exclamation mark',
      '8:banned phrase \\bseamless(ly)?\\b',
      '9:banned phrase \\bseamless(ly)?\\b',
    ])
  })

  it('does not count the retired word in an import path or an identifier', () => {
    const source = ["import { listReceipts } from '@/lib/applications/receipts'", "const key = 'receipt'", 'const rows = await listReceipts()'].join('\n')
    expect(scanSource('sample.tsx', source)).toEqual([])
  })

  it('fails an unlisted file with one violation, and a listed file that gets worse', () => {
    const one = scanSource('components/new.tsx', '<p>Jobs \u2014 ranked</p>;')
    expect(overBaseline(one, {}).over).toEqual(['components/new.tsx: 1 found, 0 allowed'])
    const two = scanSource('components/old.tsx', ['<p>Jobs \u2014 ranked</p>;', '<p>Done!</p>;'].join('\n'))
    expect(overBaseline(two, { 'components/old.tsx': 2 }).over).toEqual([])
    expect(overBaseline(two, { 'components/old.tsx': 1 }).over).toEqual(['components/old.tsx: 2 found, 1 allowed'])
  })
})
