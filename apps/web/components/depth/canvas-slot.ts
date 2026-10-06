// At most two WebGL canvases a page. Without drei every Fiber canvas is its
// own GPU context, so a third is never mounted: the bar mark takes one, the
// working mark takes the other, and anything else keeps its SVG twin.

export const MAX_CANVASES = 2

let held = 0

/** Take a canvas slot, or null when the page already holds two. Call the result to give it back. */
export function claimCanvas(): (() => void) | null {
  if (held >= MAX_CANVASES) return null
  held += 1
  let released = false
  return () => {
    if (released) return
    released = true
    held -= 1
  }
}

/** For tests. */
export function canvasesHeld(): number {
  return held
}
