// The life of one rendered mark, as a pure reducer so it can be tested without
// a GPU. The twin is what renders on the server and until the canvas is ready,
// and it is what comes back when a context is lost.

export type MarkPhase = 'twin' | 'loading' | 'canvas' | 'lost'
export type MarkAction = 'allow' | 'deny' | 'ready' | 'lost' | 'release'

export function markReducer(phase: MarkPhase, action: MarkAction): MarkPhase {
  switch (action) {
    case 'allow':
      // A lost context is not retried on this page.
      return phase === 'lost' ? 'lost' : 'loading'
    case 'ready':
      return phase === 'loading' ? 'canvas' : phase
    case 'lost':
      return 'lost'
    case 'deny':
    case 'release':
      return phase === 'lost' ? 'lost' : 'twin'
  }
}

/** The twin stays in the box until the canvas has drawn, and comes back when it is lost. */
export function showTwin(phase: MarkPhase): boolean {
  return phase !== 'canvas'
}
