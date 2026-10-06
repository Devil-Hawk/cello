import { describe, expect, it } from 'vitest'
import { decideDepth, type DepthInputs } from './capabilities'
import { frameloopFor } from './frameloop'

const ok: DepthInputs = {
  reducedMotion: false,
  reducedTransparency: false,
  webgl: true,
  majorCaveat: false,
  saveData: false,
  deviceMemory: 8,
}

describe('decideDepth', () => {
  it('renders 3D on a capable device', () => {
    expect(decideDepth(ok)).toEqual({ webgl: true, motion: true, blur: true })
  })
  it('keeps the twins with no context', () => {
    expect(decideDepth({ ...ok, webgl: false }).webgl).toBe(false)
  })
  it('keeps the twins when only software rendering exists', () => {
    expect(decideDepth({ ...ok, majorCaveat: true }).webgl).toBe(false)
  })
  it('keeps the twins on Save-Data', () => {
    expect(decideDepth({ ...ok, saveData: true }).webgl).toBe(false)
  })
  it('keeps the twins at 2 GB of memory or less, and renders at 4', () => {
    expect(decideDepth({ ...ok, deviceMemory: 2 }).webgl).toBe(false)
    expect(decideDepth({ ...ok, deviceMemory: 4 }).webgl).toBe(true)
    expect(decideDepth({ ...ok, deviceMemory: undefined }).webgl).toBe(true)
  })
  it('stops motion for reduced motion, and blur for reduced transparency', () => {
    expect(decideDepth({ ...ok, reducedMotion: true }).motion).toBe(false)
    expect(decideDepth({ ...ok, reducedTransparency: true }).blur).toBe(false)
  })
})

describe('frameloopFor', () => {
  const base = { visible: true, onScreen: true, working: false, motion: true }
  it('never draws in a hidden tab', () => {
    expect(frameloopFor({ ...base, visible: false, working: true })).toBe('never')
  })
  it('draws only on demand for reduced motion', () => {
    expect(frameloopFor({ ...base, working: true, motion: false })).toBe('demand')
  })
  it('runs continuously only while working, visible and on screen', () => {
    expect(frameloopFor({ ...base, working: true })).toBe('always')
    expect(frameloopFor({ ...base, working: true, onScreen: false })).toBe('demand')
  })
  it('keeps the idle bar mark on demand', () => {
    expect(frameloopFor(base)).toBe('demand')
  })
})
