// Two source scans that keep the Companies feature to its rules (owner directives 20 and 55):
//   the pages only read: nothing under app/(app)/companies reaches Supabase from the browser
//   code first: nothing under lib/companies reaches a model

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const WEB = process.cwd()

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(entry) ? [full] : []
  })
}

/** Every module a file imports, from `import ... from 'x'`, `import 'x'`, `import('x')` and `require('x')`. */
function importsOf(src: string): string[] {
  return [...src.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1])
}

const offenders = (dir: string, banned: (spec: string) => boolean) =>
  walk(path.join(WEB, dir))
    .filter((f) => importsOf(readFileSync(f, 'utf8')).some(banned))
    .map((f) => path.relative(WEB, f).split(path.sep).join('/'))

/** '@/lib/models', '../models/x' and 'lib/models' are one module: drop the way in, keep the path under lib. */
const underLib = (spec: string) => spec.replace(/^@\/lib\//, '').replace(/^(\.\.?\/)+/, '').replace(/^lib\//, '')

describe('the scanner itself', () => {
  it('reads every form of import', () => {
    expect(importsOf(`import a from 'x'\nimport { b } from "y"\nimport 'z'\nconst c = await import('w')\nconst d = require('v')\nexport * from 'u'`)).toEqual(['x', 'y', 'z', 'w', 'v', 'u'])
    expect(underLib('@/lib/harness/llm')).toBe('harness/llm')
    expect(underLib('../../models/index')).toBe('models/index')
  })
})

describe('the Companies pages', () => {
  it('never import the browser Supabase client', () => {
    expect(offenders('app/(app)/companies', (s) => s === '@/lib/supabase/client' || s.startsWith('@supabase/supabase-js'))).toEqual([])
  })
})

describe('lib/companies', () => {
  it('never imports a model', () => {
    const model = (s: string) => /^(harness\/llm|ingest\/model|models)$|^(models)\//.test(underLib(s)) || s.startsWith('@langchain/') || s === 'openai' || s.startsWith('openai/')
    expect(offenders('lib/companies', model)).toEqual([])
  })
})
