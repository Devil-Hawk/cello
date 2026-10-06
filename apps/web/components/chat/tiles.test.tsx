import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MAX_TILES } from '@/lib/chat/types'
import { Tiles, type TileData } from './tiles'

const noop = () => undefined
const tile = (n: number, over: Partial<TileData> = {}): TileData => ({ id: `t${n}`, kind: 'role', ref: `r${n}`, name: `Role ${n}`, origin: 'person', ...over })
const html = (tiles: TileData[], add = true) => renderToStaticMarkup(<Tiles tiles={tiles} onRemove={noop} onAdd={add ? noop : undefined} />)

describe('Tiles', () => {
  it('shows each thing in order with Remove, and Add at the end', () => {
    const out = html([tile(1), tile(2, { kind: 'company', ref: 'c1', name: 'Ramp' })])
    expect(out.indexOf('Role 1')).toBeLessThan(out.indexOf('Ramp'))
    expect(out).toContain('aria-label="Remove Role 1"')
    expect(out).toContain('aria-label="Remove Ramp"')
    expect(out).toContain('href="/companies/c1"')
    expect(out.lastIndexOf('Add')).toBeGreaterThan(out.indexOf('Ramp'))
  })

  it('says when Cello added a tile, and not for the person\'s own', () => {
    const out = html([tile(1), tile(2, { origin: 'model' })])
    expect((out.match(/Added by Cello/g) ?? []).length).toBe(1)
  })

  it('opens a made thing in the panel instead of a page', () => {
    const out = html([tile(1, { kind: 'made', ref: 'm1', name: 'Comparison of 6 roles' })])
    expect(out).toContain('data-tile="made"')
    expect(out).not.toContain('href="/made')
  })

  it('at 25 says why Add is gone', () => {
    const out = html(Array.from({ length: MAX_TILES }, (_, i) => tile(i)))
    expect(out).toContain('A chat holds 25. Remove one to add another.')
    expect(out).not.toMatch(/>\s*Add\s*</)
    expect((out.match(/data-tile=/g) ?? []).length).toBe(25)
  })

  it('keeps a 60-character title from widening its tile', () => {
    const out = html([tile(1, { name: 'A'.repeat(60) })])
    expect(out).toContain('min-w-0 truncate')
    expect(out).toContain('max-w-full')
  })

  it('shows nothing for an empty chat with no way to add', () => {
    expect(html([], false)).toBe('')
  })
})
