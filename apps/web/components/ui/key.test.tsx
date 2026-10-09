import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Key } from './key'
import { Tile, tileDose } from './tile'
import { Bead } from './bead'
import { Plinth } from './plinth'
import { Disclosure } from './disclosure'

describe('Key', () => {
  it('is at least 44px each way in every variant', () => {
    for (const variant of ['ink', 'raised', 'ghost'] as const) {
      const html = renderToStaticMarkup(<Key variant={variant}>Apply</Key>)
      expect(html).toContain('min-h-11')
      expect(html).toContain('min-w-11')
      expect(html).toContain('r-key')
    }
  })

  it('is a button that does not submit forms by default', () => {
    expect(renderToStaticMarkup(<Key>Go</Key>)).toContain('type="button"')
  })

  it('marks the current page', () => {
    expect(renderToStaticMarkup(<Key current>Today</Key>)).toContain('aria-current="page"')
    expect(renderToStaticMarkup(<Key>Today</Key>)).not.toContain('aria-current')
  })

  it('can be a link', () => {
    const html = renderToStaticMarkup(
      <Key asChild>
        <a href="/roles">Roles</a>
      </Key>,
    )
    expect(html).toContain('<a ')
    expect(html).toContain('r-key')
    expect(html).not.toContain('<button')
  })
})

describe('Tile', () => {
  it('raises the bevel with the size', () => {
    expect(tileDose(40)).toEqual({ lg: false, xl: false })
    expect(tileDose(48)).toEqual({ lg: true, xl: false })
    expect(tileDose(64)).toEqual({ lg: true, xl: true })
  })

  it('sets its own box and radius so nothing shifts', () => {
    const html = renderToStaticMarkup(<Tile size={64}>A</Tile>)
    expect(html).toContain('width:64px')
    expect(html).toContain('height:64px')
    expect(html).toContain('r-tile-lg')
    expect(html).toContain('r-tile-xl')
  })

  it('lies flat when finished and carries the ring only when asked', () => {
    expect(renderToStaticMarkup(<Tile flat>A</Tile>)).toContain('r-tile-flat')
    expect(renderToStaticMarkup(<Tile>A</Tile>)).not.toContain('r-tile-ring')
    expect(renderToStaticMarkup(<Tile ring>A</Tile>)).toContain('r-tile-ring')
  })
})

describe('Bead, Plinth, Disclosure', () => {
  it('draws a bead per tone and hides it from assistive tech', () => {
    expect(renderToStaticMarkup(<Bead />)).toContain('aria-hidden')
    expect(renderToStaticMarkup(<Bead tone="blocked" />)).toContain('r-bead-blocked')
  })

  it('renders the bar and the phone plinth', () => {
    expect(renderToStaticMarkup(<Plinth>x</Plinth>)).toContain('r-plinth')
    expect(renderToStaticMarkup(<Plinth kind="tabs">x</Plinth>)).toContain('r-plinth-tabs')
  })

  it('is a native details with its count, closed unless asked', () => {
    const html = renderToStaticMarkup(
      <Disclosure title="Requirements" count={9}>
        body
      </Disclosure>,
    )
    expect(html).toContain('<details')
    expect(html).toContain('<summary')
    expect(html).toContain('Requirements')
    expect(html).toContain('>9<')
    expect(html).not.toContain(' open')
    expect(renderToStaticMarkup(<Disclosure title="Posting" defaultOpen>x</Disclosure>)).toContain('open=""')
  })
})
