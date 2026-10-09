'use client'

import { Mark } from './mark'

/**
 * The mark beside "Cello is working", 24px. It moves only while work runs, and
 * only while it is on screen in a visible tab. Mount it only while something
 * runs: it takes the page's second canvas slot.
 */
export function WorkingMark({ className }: { className?: string }) {
  return <Mark size={24} working className={className} />
}
