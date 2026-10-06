'use client'

import { useEffect, useReducer, useState } from 'react'
import { NO_REACTIONS, UNDO_MS, reactionReducer } from './reactions'

/** The reactions made on a page, and a clock that only runs while an Undo is open. */
export function useReactionState() {
  const [state, dispatch] = useReducer(reactionReducer, NO_REACTIONS)
  const [now, setNow] = useState(() => Date.now())
  const open = Object.values(state.done).some((d) => now - d.at < UNDO_MS)
  useEffect(() => {
    if (!open) return
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [open])
  return { state, dispatch, now }
}
