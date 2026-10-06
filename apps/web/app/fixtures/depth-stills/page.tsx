'use client'

// One still object on one canvas, for scripts/depth-stills.mjs. Open it as
// /fixtures/depth-stills?still=quiet&dpr=2, wait for window.__stillReady, and
// read the canvas. A tool page, never part of a product screen. The canvas
// loads through next/dynamic so three stays out of first-load JS here too.

import dynamic from 'next/dynamic'
import { Suspense, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { STILLS, type StillName } from '@/components/ui/contract'

const StillCanvas = dynamic(() => import('@/components/depth/still-canvas').then((m) => m.StillCanvas), {
  ssr: false,
})

function Still() {
  const params = useSearchParams()
  const asked = params.get('still') as StillName | null
  const still: StillName = asked && STILLS.includes(asked) ? asked : 'quiet'
  const dpr = params.get('dpr') === '2' ? 2 : 1
  useEffect(() => {
    window.__stillReady = false
  }, [still, dpr])
  return <StillCanvas still={still} dpr={dpr} />
}

export default function DepthStillsPage() {
  return (
    <Suspense fallback={null}>
      <Still />
    </Suspense>
  )
}
