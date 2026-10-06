import { describe, expect, it } from 'vitest'
import { ROUTE_GROWTH_MAX, THREE_ASYNC_MAX, checkBundle } from './check-bundle.mjs'

const KB = 1024
const base = {
  routes: { '/today/page': ['a.js', 'b.js'] },
  chunkGzip: { 'a.js': 80 * KB, 'b.js': 20 * KB },
  chunkHasThree: { 'a.js': false, 'b.js': false },
  baseline: { '/today/page': 100 * KB },
}

describe('checkBundle', () => {
  it('passes a build that matches its baseline', () => {
    expect(checkBundle(base).ok).toBe(true)
  })

  it('fails a planted 300 KB first-load chunk', () => {
    const r = checkBundle({
      ...base,
      routes: { '/today/page': ['a.js', 'b.js', 'planted.js'] },
      chunkGzip: { ...base.chunkGzip, 'planted.js': 300 * KB },
      chunkHasThree: { ...base.chunkHasThree, 'planted.js': false },
    })
    expect(r.ok).toBe(false)
    expect(r.failures[0]).toContain('/today/page')
  })

  it('passes a route 4 KB over its baseline and fails one 6 KB over', () => {
    const grown = (extra) => ({ ...base, chunkGzip: { ...base.chunkGzip, 'b.js': 20 * KB + extra } })
    expect(checkBundle(grown(4 * KB)).ok).toBe(true)
    expect(checkBundle(grown(6 * KB)).ok).toBe(false)
    expect(ROUTE_GROWTH_MAX).toBe(5 * KB)
  })

  it('fails three in first-load JS', () => {
    const r = checkBundle({ ...base, chunkHasThree: { 'a.js': true, 'b.js': false } })
    expect(r.ok).toBe(false)
    expect(r.failures.join(' ')).toContain('contains three')
  })

  it('accepts three in a chunk loaded on idle, up to 200 KB gzipped', () => {
    const withThree = (size) => ({
      ...base,
      chunkGzip: { ...base.chunkGzip, 'three.js': size },
      chunkHasThree: { ...base.chunkHasThree, 'three.js': true },
    })
    expect(checkBundle(withThree(199 * KB)).ok).toBe(true)
    expect(checkBundle(withThree(201 * KB)).ok).toBe(false)
    expect(THREE_ASYNC_MAX).toBe(200 * KB)
  })

  it('skips the growth check with no baseline', () => {
    const { baseline: _unused, ...noBaseline } = base
    expect(checkBundle(noBaseline).ok).toBe(true)
  })
})
