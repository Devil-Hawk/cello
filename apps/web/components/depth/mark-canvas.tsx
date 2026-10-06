'use client'

// The WebGL half of the mark. Loaded only through next/dynamic with ssr false,
// after the page is interactive, so three and Fiber never reach first-load JS.

import { useEffect, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { frameloopFor } from '@/lib/depth/frameloop'
import { MarkScene } from './mark-scene'

export interface MarkCanvasProps {
  size: number
  live: boolean
  motion: boolean
  onReady: () => void
  onLost: () => void
}

export default function MarkCanvas({ size, live, motion, onReady, onLost }: MarkCanvasProps) {
  const wrap = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(true)
  const [onScreen, setOnScreen] = useState(true)

  // A hidden tab stops the loop; so does scrolling the canvas out of view.
  useEffect(() => {
    const sync = () => setVisible(document.visibilityState === 'visible')
    sync()
    document.addEventListener('visibilitychange', sync)
    const el = wrap.current
    const io = el && typeof IntersectionObserver === 'function' ? new IntersectionObserver(([e]) => setOnScreen(e.isIntersecting)) : null
    if (el && io) io.observe(el)
    return () => {
      document.removeEventListener('visibilitychange', sync)
      io?.disconnect()
    }
  }, [])

  const frameloop = frameloopFor({ visible, onScreen, working: live, motion })

  return (
    <div ref={wrap} style={{ width: size, height: size }} className="absolute inset-0">
      <Canvas
        orthographic
        shadows
        dpr={[1, 2]}
        frameloop={frameloop}
        gl={{ alpha: true, antialias: true, powerPreference: 'low-power' }}
        camera={{ zoom: size / 2.8, position: [0, 0, 4], near: 0.1, far: 10 }}
        style={{ width: size, height: size }}
        onCreated={({ gl }) => {
          gl.domElement.addEventListener('webglcontextlost', (e) => {
            e.preventDefault()
            onLost()
          })
          onReady()
        }}
      >
        <MarkScene live={live} motion={motion} />
      </Canvas>
    </div>
  )
}
