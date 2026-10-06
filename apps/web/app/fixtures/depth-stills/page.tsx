'use client'

// One still object on one canvas, for scripts/depth-stills.mjs. Open it as
// /fixtures/depth-stills?still=quiet&dpr=2, wait for window.__stillReady, and
// read the canvas. The canvas keeps its drawing buffer so toDataURL works.
// This is a tool page, never part of a product screen.

import { Suspense, useEffect, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { Canvas, useFrame } from '@react-three/fiber'
import { MarkScene } from '@/components/depth/mark-scene'
import { STILLS, type StillName } from '@/components/ui/contract'

const SIZE = 96

declare global {
  interface Window {
    __stillReady?: boolean
  }
}

// Two frames after the first draw, so shadows and the first rotation are in.
function Ready() {
  const frames = useRef(0)
  useFrame(() => {
    frames.current += 1
    if (frames.current === 3) window.__stillReady = true
  })
  return null
}

function Still() {
  const params = useSearchParams()
  const asked = params.get('still') as StillName | null
  const still: StillName = asked && STILLS.includes(asked) ? asked : 'quiet'
  const dpr = params.get('dpr') === '2' ? 2 : 1
  useEffect(() => {
    window.__stillReady = false
  }, [still, dpr])
  return (
    <div style={{ width: SIZE, height: SIZE }}>
      <Canvas
        orthographic
        shadows
        dpr={dpr}
        frameloop="always"
        gl={{ alpha: true, antialias: true, preserveDrawingBuffer: true }}
        camera={{ zoom: SIZE / 2.8, position: [0, 0, 4], near: 0.1, far: 10 }}
        style={{ width: SIZE, height: SIZE }}
      >
        <MarkScene still={still} motion={false} />
        <Ready />
      </Canvas>
    </div>
  )
}

export default function DepthStillsPage() {
  return (
    <Suspense fallback={null}>
      <Still />
    </Suspense>
  )
}
