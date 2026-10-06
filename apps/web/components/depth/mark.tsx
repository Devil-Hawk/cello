'use client'

// The rendered Cello mark with its SVG twin. The box has a fixed width and
// height of its own, so the twin, the canvas and a lost context all occupy the
// same space and nothing shifts. The canvas mounts on idle, only when the
// device allows it (lib/depth/capabilities.ts) and the page still has a canvas
// slot (canvas-slot.ts).

import dynamic from 'next/dynamic'
import { useEffect, useReducer } from 'react'
import { useDepth } from '@/lib/depth/capabilities'
import { cn } from '@/lib/utils'
import { claimCanvas } from './canvas-slot'
import { markReducer, showTwin } from './mark-state'
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

  useEffect(() => {
    if (!depth.webgl) return
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
  }, [depth.webgl])

  const mounted = phase === 'loading' || phase === 'canvas'
  return (
    <span
      className={cn('relative inline-block flex-none', className)}
      style={{ width: size, height: size }}
      data-live={working ? '' : undefined}
      data-mark={phase}
    >
      <span style={{ visibility: showTwin(phase) ? 'visible' : 'hidden' }}>
        <MarkTwin size={size} />
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
