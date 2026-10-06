'use client'

// One still object on one canvas, for scripts/depth-stills.mjs. Open it as
// /fixtures/depth-stills?still=quiet&dpr=2, wait for window.__stillReady, and
// read the canvas. A tool page, never part of a product screen.

import { Suspense, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { StillCanvas } from '@/components/depth/still-canvas'
import { STILLS, type StillName } from '@/components/ui/contract'

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
