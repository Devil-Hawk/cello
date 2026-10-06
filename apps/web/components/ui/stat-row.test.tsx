import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { StatRow } from './stat-row'

describe('StatRow', () => {
  it('leaves out stats that read 0', () => {
    const html = renderToStaticMarkup(
      <StatRow stats={[{ label: 'Dream companies', value: 0 }, { label: 'Open roles', value: 3 }]} />
    )
    expect(html).toContain('Open roles')
    expect(html).not.toContain('Dream companies')
    expect(html).toContain('sm:grid-cols-1')
  })

  it('draws nothing when every stat reads 0', () => {
    expect(renderToStaticMarkup(<StatRow stats={[{ label: 'A', value: 0 }, { label: 'B', value: 0 }]} />)).toBe('')
  })

  it('spans the last tile on phones when the count is odd', () => {
    const three = renderToStaticMarkup(
      <StatRow stats={[{ label: 'A', value: 1 }, { label: 'B', value: 2 }, { label: 'C', value: 3 }]} />
    )
    expect(three.match(/col-span-2 sm:col-span-1/g)).toHaveLength(1)
    const four = renderToStaticMarkup(
      <StatRow stats={['A', 'B', 'C', 'D'].map((label) => ({ label, value: 1 }))} />
    )
    expect(four).not.toContain('col-span-2')
  })
})
