import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The relay carrier can reach a model job and nothing else. It imports nothing from
// the fill code, so it cannot even name a fill route. This scan reads every file in
// relay/ and fails on any import whose path goes through fill.

const IMPORT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]([^'"]+)['"]/g

export function fillImports(source: string): string[] {
  const hits: string[] = []
  for (const m of source.matchAll(IMPORT)) {
    const spec = m[1] as string
    // A fill module, or the fill client (lib/api): neither may be named from the relay.
    if (/(^|[/.])fill([/\-.]|$)/i.test(spec) || /lib\/api$/.test(spec)) hits.push(spec)
  }
  return hits
}

describe('the relay carrier has no fill imports', () => {
  it('catches a planted import', () => {
    expect(fillImports(`import { ROUTES } from '../lib/fill-contract'`)).toEqual(['../lib/fill-contract'])
    expect(fillImports(`import { runAuto } from '../fill/auto'`)).toEqual(['../fill/auto'])
    expect(fillImports(`const x = await import('../fill/manual')`)).toEqual(['../fill/manual'])
    expect(fillImports(`import { callApi } from '../lib/api'`)).toEqual(['../lib/api'])
    expect(fillImports(`import { relayCall } from './api'`)).toEqual([])
  })

  it('finds none in relay/', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url))
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) expect(fillImports(readFileSync(`${dir}/${f}`, 'utf8')), f).toEqual([])
  })

  it('does not wait on a timer of its own', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url))
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts'))) {
      expect(readFileSync(`${dir}/${f}`, 'utf8'), f).not.toMatch(/setInterval|setTimeout/)
    }
  })
})
