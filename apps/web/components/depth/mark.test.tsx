import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Mark } from './mark'
import { WorkingMark } from './working-mark'
import { Still } from './still'
import { MAX_CANVASES, canvasesHeld, claimCanvas } from './canvas-slot'
import { markReducer, showTwin } from './mark-state'

describe('Mark on the server', () => {
  it('renders the SVG twin in a 36 by 36 box with a fixed width and height', () => {
    const html = renderToStaticMarkup(<Mark />)
    expect(html).toContain('width:36px')
    expect(html).toContain('height:36px')
    expect(html).toContain('<svg')
    expect(html).toContain('width="36"')
    expect(html).not.toContain('<canvas')
  })

  it('keeps the same box for the working mark at 24px, live only when working', () => {
    const html = renderToStaticMarkup(<WorkingMark />)
    expect(html).toContain('width:24px')
    expect(html).toContain('data-live')
    expect(renderToStaticMarkup(<Mark />)).not.toContain('data-live')
  })

  it('renders a still as an image over its twin, never a canvas', () => {
    const html = renderToStaticMarkup(<Still name="quiet" />)
    expect(html).toContain('/depth/quiet@1x.webp')
    expect(html).toContain('/depth/quiet@2x.webp 2x')
    expect(html).toContain('<svg')
    expect(html).not.toContain('<canvas')
  })
})

describe('canvas slots', () => {
  it('refuses a third canvas on a page, and gives a slot back', () => {
    const base = canvasesHeld()
    const first = claimCanvas()
    const second = claimCanvas()
    const third = claimCanvas()
    expect(MAX_CANVASES).toBe(2)
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(third).toBeNull()
    first?.()
    first?.()
    expect(canvasesHeld()).toBe(base + 1)
    expect(claimCanvas()).not.toBeNull()
    second?.()
  })
})

describe('mark life cycle', () => {
  it('starts as the twin, shows the canvas once ready, and returns to the twin when the context is lost', () => {
    let p = markReducer('twin', 'allow')
    expect(p).toBe('loading')
    expect(showTwin(p)).toBe(true)
    p = markReducer(p, 'ready')
    expect(p).toBe('canvas')
    expect(showTwin(p)).toBe(false)
    p = markReducer(p, 'lost')
    expect(showTwin(p)).toBe(true)
  })

  it('does not try again after a lost context', () => {
    expect(markReducer('lost', 'allow')).toBe('lost')
    expect(markReducer('lost', 'release')).toBe('lost')
  })

  it('falls back to the twin when no slot is free', () => {
    expect(markReducer('twin', 'deny')).toBe('twin')
  })
})
