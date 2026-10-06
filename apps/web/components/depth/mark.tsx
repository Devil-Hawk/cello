'use client'

// The rendered Cello mark with its SVG twin. The box has a fixed width and
// height of its own, so the twin, the canvas and a lost context all occupy the
// same space and nothing shifts. A resting mark is the pre-rendered still over
// its twin: the scene only turns for the pointer, so the canvas mounts when a
// mouse or pen first arrives (or focus does), never on load, and three stays
// out of the page's first paint. A working mark moves on its own and mounts on
// idle. Both only when the device allows it (lib/depth/capabilities.ts) and the
// page still has a canvas slot (canvas-slot.ts). Phones keep the still.

import dynamic from 'next/dynamic'
import { useEffect, useReducer, useState } from 'react'
import { useDepth } from '@/lib/depth/capabilities'
import { claimCanvas } from './canvas-slot'
import { markReducer, showTwin } from './mark-state'
import { Still } from './still'
import { MarkTwin } from './twins'

const MarkCanvas = dynamic(() => import('./mark-canvas'), { ssr: false })

function onIdle(run: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(run)
    return () => cancelIdleCallback(id)
  }
  const id = setTimeout(run, 200)
  return () => clearTimeout(id)
}

export interface MarkProps {
  size?: number
  /** Cello is working: the mark turns on a 1.6 second breath. */
  working?: boolean
  className?: string
}

export function Mark({ size = 36, working = false, className }: MarkProps) {
  const depth = useDepth()
  const [phase, dispatch] = useReducer(markReducer, 'twin')
  const [arrived, setArrived] = useState(false)
  const armed = working || arrived

  useEffect(() => {
    if (!depth.webgl || !armed) return
    let release: (() => void) | null = null
    const cancel = onIdle(() => {
      release = claimCanvas()
      dispatch(release ? 'allow' : 'deny')
    })
    return () => {
      cancel()
      release?.()
      dispatch('release')
    }
  }, [depth.webgl, armed])

  const mounted = phase === 'loading' || phase === 'canvas'
  return (
    <span
      className={`relative inline-block flex-none${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
      onPointerEnter={(e) => e.pointerType !== 'touch' && setArrived(true)}
      onFocus={() => setArrived(true)}
      data-live={working ? '' : undefined}
      data-mark={phase}
    >
      <span style={{ visibility: showTwin(phase) ? 'visible' : 'hidden' }}>
        {working ? <MarkTwin size={size} /> : <Still name="mark" size={size} />}
      </span>
      {mounted && (
        <MarkCanvas
          size={size}
          live={working}
          motion={depth.motion}
          onReady={() => dispatch('ready')}
          onLost={() => dispatch('lost')}
        />
      )}
    </span>
  )
}
