// Source scans for the agent engine. Each rule names the one file allowed to do a thing, so
// the thing cannot be done a second way without this test failing.
//
//   new ChatOpenRouter(   only lib/agents/model.ts (the one model door, with spend and keys)
//   new ChatOpenAI(       nowhere (graph-chokepoints.test.ts bans every other Chat*( too)
//   createDeepAgent(      only lib/agents/factory.ts (the guards are attached there)
//   createSubAgent(       only lib/agents/factory.ts
//   createAgent(          nowhere (createDeepAgent and createSubAgent cover every loop)
//   MultiServerMCPClient( only lib/agents/user-mcp.ts (SSRF and DNS checks come first)
//   PostgresSaver         constructed only in lib/agents/persistence.ts (and lib/graph/pg.ts, the
//                         old graph's pool, until it is removed)
//   PostgresStore         nowhere: mem0 is the only memory store
//
// Comments are stripped first, and test files are skipped, so a file cannot trip or dodge a rule by
// talking about it. scripts/mutation-check-scans.ts proves each pattern fires on a mutated fixture.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const WEB_ROOT = process.cwd()
const SKIP = new Set(['node_modules', '.next', '.turbo', '.git', '.vercel', 'coverage', 'scripts'])

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(entry) && !entry.includes('.test.') && !entry.includes('.eval.')) out.push(full)
  }
  return out
}

const rel = (file: string) => path.relative(WEB_ROOT, file).split(path.sep).join('/')

function stripComments(src: string): string {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
    })
    .join('\n')
}

interface Rule {
  name: string
  pattern: RegExp
  /** The files allowed to contain the pattern. */
  allowed: string[]
}

const RULES: Rule[] = [
  { name: 'new ChatOpenRouter(', pattern: /\bnew\s+ChatOpenRouter\s*\(/, allowed: ['lib/agents/model.ts', 'lib/models/factory.ts'] },
  { name: 'new ChatOpenAI(', pattern: /\bnew\s+ChatOpenAI\s*\(/, allowed: ['lib/models/factory.ts'] },
  { name: 'createDeepAgent(', pattern: /\bcreateDeepAgent\s*\(/, allowed: ['lib/agents/factory.ts'] },
  { name: 'createSubAgent(', pattern: /\bcreateSubAgent\s*\(/, allowed: ['lib/agents/factory.ts'] },
  { name: 'createAgent(', pattern: /\bcreateAgent\s*\(/, allowed: [] },
  { name: 'new MultiServerMCPClient(', pattern: /\bnew\s+MultiServerMCPClient\s*\(/, allowed: ['lib/agents/user-mcp.ts'] },
  { name: 'PostgresSaver constructed', pattern: /\b(?:new\s+PostgresSaver\s*\(|PostgresSaver\.fromConnString\s*\()/, allowed: ['lib/agents/persistence.ts', 'lib/graph/pg.ts'] },
  { name: 'PostgresStore constructed (a second memory store)', pattern: /\b(?:new\s+PostgresStore\s*\(|PostgresStore\.fromConnString\s*\()/, allowed: [] },
]

/** The files in `files` (path to source) that break `rule`. */
function offenders(rule: Rule, files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([file, src]) => rule.pattern.test(stripComments(src)) && !rule.allowed.includes(file))
    .map(([file]) => file)
    .sort()
}

const SOURCES: Record<string, string> = Object.fromEntries(walk(WEB_ROOT).map((f) => [rel(f), readFileSync(f, 'utf8')]))

describe('the agent engine has one door for each dangerous thing', () => {
  for (const rule of RULES) {
    it(`${rule.name} appears only in ${rule.allowed.join(', ') || 'no file'}`, () => {
      expect(offenders(rule, SOURCES)).toEqual([])
    })
  }

  it('the allowed files really do contain their pattern, so a rename cannot leave a rule empty', () => {
    for (const rule of RULES) {
      for (const file of rule.allowed) expect(rule.pattern.test(stripComments(SOURCES[file] ?? '')), `${file} has ${rule.name}`).toBe(true)
    }
  })

  it('the scan walks the agent files, not an empty tree', () => {
    expect(Object.keys(SOURCES).filter((f) => f.startsWith('lib/agents/')).length).toBeGreaterThan(20)
  })
})

describe('the scan catches an offender', () => {
  const clean = { 'lib/agents/ok.ts': 'export const x = 1' }
  for (const rule of RULES) {
    it(`${rule.name} in a new file is reported, and in a comment is not`, () => {
      const code = rule.name.startsWith('PostgresSaver')
        ? 'const s = new PostgresSaver(pool)'
        : rule.name.startsWith('PostgresStore')
          ? 'const s = new PostgresStore({})'
          : `const m = ${rule.name}{})`
      expect(offenders(rule, clean)).toEqual([])
      expect(offenders(rule, { ...clean, 'lib/rogue.ts': code })).toEqual(['lib/rogue.ts'])
      expect(offenders(rule, { ...clean, 'lib/rogue.ts': `// ${code}\n/* ${code} */\n * ${code}` })).toEqual([])
    })
  }
})
