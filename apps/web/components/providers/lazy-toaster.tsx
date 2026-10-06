'use client'

import dynamic from 'next/dynamic'

// A toast only appears after something was done, so its code (about 10 KB gzipped
// with the Radix layers under it) loads after the page, not with it.
export const Toaster = dynamic(() => import('@/components/ui/toaster').then((m) => m.Toaster), { ssr: false })
