'use client'

// One still object on one canvas, for scripts/depth-stills.mjs only. The canvas
// keeps its drawing buffer so toDataURL works, draws the rest pose (no motion,
// no pointer), and flags window.__stillReady once a few frames are in.

import { useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import type { StillName } from '@/components/ui/contract'
import { MarkScene } from './mark-scene'

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
  return (
    <div style={{ width: STILL_SIZE, height: STILL_SIZE }}>
      <Canvas
        orthographic
        shadows
        dpr={dpr}
        frameloop="always"
        gl={{ alpha: true, antialias: true, preserveDrawingBuffer: true }}
        camera={{ zoom: STILL_SIZE / 2.8, position: [0, 0, 4], near: 0.1, far: 10 }}
        style={{ width: STILL_SIZE, height: STILL_SIZE }}
      >
        <MarkScene still={still} motion={false} />
        <Ready />
      </Canvas>
    </div>
  )
}
