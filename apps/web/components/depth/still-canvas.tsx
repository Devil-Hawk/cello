'use client'

// One still object on one canvas, for scripts/depth-stills.mjs only. The canvas
// keeps its drawing buffer so toDataURL works, draws the rest pose (no motion,
// no pointer), and flags window.__stillReady once a few frames are in.

import { useEffect, useRef } from 'react'
import { createRoot, extend, useFrame } from '@react-three/fiber'
import { AmbientLight, BoxGeometry, DirectionalLight, Group, Mesh, MeshStandardMaterial } from 'three'
import type { StillName } from '@/components/ui/contract'
import { MarkScene } from './mark-scene'

// Only the intrinsics the scene uses, as in mark-canvas.tsx.
extend({ AmbientLight, BoxGeometry, DirectionalLight, Group, Mesh, MeshStandardMaterial })

export const STILL_SIZE = 96

declare global {
  interface Window {
    __stillReady?: boolean
  }
}

function Ready() {
  const frames = useRef(0)
  useFrame(() => {
    frames.current += 1
    if (frames.current === 3) window.__stillReady = true
  })
  return null
}

export function StillCanvas({ still, dpr }: { still: StillName; dpr: 1 | 2 }) {
  const el = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = el.current
    if (!canvas) return
    const root = createRoot(canvas)
    root.configure({
      orthographic: true,
      shadows: true,
      dpr,
      frameloop: 'always',
      gl: { alpha: true, antialias: true, preserveDrawingBuffer: true },
      camera: { zoom: STILL_SIZE / 2.8, position: [0, 0, 4], near: 0.1, far: 10 },
      size: { width: STILL_SIZE, height: STILL_SIZE, top: 0, left: 0 },
    })
    root.render(
      <>
        <MarkScene still={still} motion={false} />
        <Ready />
      </>,
    )
    return () => root.unmount()
  }, [still, dpr])
  return (
    <div style={{ width: STILL_SIZE, height: STILL_SIZE }}>
      <canvas ref={el} style={{ width: STILL_SIZE, height: STILL_SIZE, display: 'block' }} />
    </div>
  )
}
