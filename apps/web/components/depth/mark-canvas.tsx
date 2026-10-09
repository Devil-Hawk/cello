'use client'

// The WebGL half of the mark. Loaded only through next/dynamic with ssr false,
// after the page is interactive, so three and Fiber never reach first-load JS.

import { useEffect, useRef, useState } from 'react'
import { createRoot, extend } from '@react-three/fiber'
import type { ReconcilerRoot } from '@react-three/fiber'
import { AmbientLight, BoxGeometry, DirectionalLight, Group, Mesh, MeshStandardMaterial } from 'three'
import { frameloopFor } from '@/lib/depth/frameloop'
import { MarkScene } from './mark-scene'

// Fiber's own <Canvas> extends the whole three namespace; createRoot with only
// the six intrinsics the scene uses keeps the rest of three out of the chunk.
extend({ AmbientLight, BoxGeometry, DirectionalLight, Group, Mesh, MeshStandardMaterial })

export interface MarkCanvasProps {
  size: number
  live: boolean
  motion: boolean
  onReady: () => void
  onLost: () => void
}

export default function MarkCanvas({ size, live, motion, onReady, onLost }: MarkCanvasProps) {
  const wrap = useRef<HTMLDivElement>(null)
  const canvasEl = useRef<HTMLCanvasElement>(null)
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
  const root = useRef<ReconcilerRoot<HTMLCanvasElement> | null>(null)
  const callbacks = useRef({ onReady, onLost })
  callbacks.current = { onReady, onLost }

  // One root per canvas element, configured again when the loop or the scene changes.
  useEffect(() => {
    const canvas = canvasEl.current
    if (!canvas) return
    root.current ??= createRoot(canvas)
    root.current.configure({
      orthographic: true,
      shadows: true,
      dpr: [1, 2],
      frameloop,
      gl: { alpha: true, antialias: true, powerPreference: 'low-power' },
      camera: { zoom: size / 2.8, position: [0, 0, 4], near: 0.1, far: 10 },
      size: { width: size, height: size, top: 0, left: 0 },
      onCreated: () => callbacks.current.onReady(),
    })
    root.current.render(<MarkScene live={live} motion={motion} />)
  }, [frameloop, size, live, motion])

  useEffect(() => {
    const canvas = canvasEl.current
    if (!canvas) return
    const lost = (e: Event) => {
      e.preventDefault()
      callbacks.current.onLost()
    }
    canvas.addEventListener('webglcontextlost', lost)
    return () => {
      canvas.removeEventListener('webglcontextlost', lost)
      root.current?.unmount()
      root.current = null
    }
  }, [])

  return (
    <div ref={wrap} style={{ width: size, height: size }} className="absolute inset-0">
      <canvas ref={canvasEl} style={{ width: size, height: size, display: 'block' }} />
    </div>
  )
}
