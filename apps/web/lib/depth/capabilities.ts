import { useEffect, useState } from 'react'

// What this device and this person allow. One decision, made once, read by
// every rendered object: no component asks the browser on its own.

export interface DepthInputs {
  reducedMotion: boolean
  reducedTransparency: boolean
  /** A WebGL context could be made at all. */
  webgl: boolean
  /** A context exists only when a major performance caveat is allowed (software rendering). */
  majorCaveat: boolean
  saveData: boolean
  /** navigator.deviceMemory in GB, when the browser reports it. */
  deviceMemory?: number
}

export interface DepthDecision {
  /** Render the 3D objects. False means the SVG twins stay. */
  webgl: boolean
  /** Hover and open transforms, and a moving mark. False draws one still frame. */
  motion: boolean
  /** Backdrop blur on the sticky bar. False means a solid ground. */
  blur: boolean
}

export function decideDepth(i: DepthInputs): DepthDecision {
  const lowMemory = i.deviceMemory !== undefined && i.deviceMemory <= 2
  return {
    webgl: i.webgl && !i.majorCaveat && !i.saveData && !lowMemory,
    motion: !i.reducedMotion,
    blur: !i.reducedTransparency,
  }
}

/** Before the browser is asked (and on the server): twins, no blur promise, no motion. */
export const SAFE_DEPTH: DepthDecision = { webgl: false, motion: false, blur: false }

function makeContext(failIfMajorPerformanceCaveat: boolean): boolean {
  const canvas = document.createElement('canvas')
  const gl = (canvas.getContext('webgl2', { failIfMajorPerformanceCaveat }) ||
    canvas.getContext('webgl', { failIfMajorPerformanceCaveat })) as WebGLRenderingContext | null
  if (!gl) return false
  // Give the slot back at once: the page may only hold a couple of contexts.
  gl.getExtension('WEBGL_lose_context')?.loseContext()
  return true
}

function probeWebgl(): Pick<DepthInputs, 'webgl' | 'majorCaveat'> {
  try {
    if (makeContext(true)) return { webgl: true, majorCaveat: false }
    const software = makeContext(false)
    return { webgl: software, majorCaveat: software }
  } catch {
    return { webgl: false, majorCaveat: false }
  }
}

function readInputs(): DepthInputs {
  const media = (q: string) => typeof matchMedia === 'function' && matchMedia(q).matches
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } }
  return {
    reducedMotion: media('(prefers-reduced-motion: reduce)'),
    reducedTransparency: media('(prefers-reduced-transparency: reduce)'),
    ...probeWebgl(),
    saveData: nav.connection?.saveData === true,
    deviceMemory: nav.deviceMemory,
  }
}

// ponytail: probed once per page load; a person changing the system setting
// mid-visit gets it on the next load. Subscribe to matchMedia if that matters.
let cached: DepthDecision | null = null

export function useDepth(): DepthDecision {
  const [d, setD] = useState<DepthDecision>(cached ?? SAFE_DEPTH)
  useEffect(() => {
    if (!cached) cached = decideDepth(readInputs())
    setD(cached)
  }, [])
  return d
}
