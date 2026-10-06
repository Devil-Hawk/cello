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
})
