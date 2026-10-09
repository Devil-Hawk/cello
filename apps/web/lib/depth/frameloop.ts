// When a rendered object may draw. Fiber's `frameloop` takes exactly these.
//   never   the tab is hidden: nothing draws
//   always  the working mark, while work runs, on screen, with motion allowed
//   demand  everything else: draw when something changes (a pointer, a resize)

export type Frameloop = 'always' | 'demand' | 'never'

export interface FrameState {
  /** document.visibilityState is visible. */
  visible: boolean
  /** The canvas is inside the viewport. */
  onScreen: boolean
  /** This is the working mark and Cello is working. */
  working: boolean
  /** Motion is allowed (not prefers-reduced-motion). */
  motion: boolean
}

export function frameloopFor({ visible, onScreen, working, motion }: FrameState): Frameloop {
  if (!visible) return 'never'
  if (working && onScreen && motion) return 'always'
  return 'demand'
}
