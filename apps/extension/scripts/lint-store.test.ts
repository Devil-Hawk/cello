import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { lintText } from './lint-store.mjs'

describe('store lint', () => {
  it('fails on a planted receipt, em dash, exclamation mark and emoji', () => {
    expect(lintText('Keeps a receipt of what was sent.')).toHaveLength(1)
    expect(lintText('One \u2014 two')).toHaveLength(1)
    expect(lintText('Great!')).toHaveLength(1)
    expect(lintText('Done \u2705')).toHaveLength(1)
  })

  it('fails on a short description over 132 characters', () => {
    expect(lintText(`Short description: ${'a'.repeat(133)}`)).toHaveLength(1)
    expect(lintText(`Short description: ${'a'.repeat(132)}`)).toHaveLength(0)
  })

  it('passes every file in the store package', () => {
    const dir = fileURLToPath(new URL('../store', import.meta.url))
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      expect(lintText(readFileSync(`${dir}/${f}`, 'utf8'), f), f).toEqual([])
    }
  })
})
