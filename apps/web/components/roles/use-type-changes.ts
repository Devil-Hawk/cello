'use client'

import { useCallback, useEffect, useState } from 'react'
import { UNDO_MS } from './reactions'
import type { TypeChange, TypeChanges } from './type-change'

/** The type changes made on a page, and a clock that only runs while an Undo is open. */
export function useTypeChanges() {
  const [changes, setChanges] = useState<TypeChanges>({})
  const [now, setNow] = useState(() => Date.now())
  const open = Object.values(changes).some((c) => now - c.at < UNDO_MS)
  useEffect(() => {
    if (!open) return
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [open])
  const set = useCallback((id: string, c: TypeChange) => setChanges((p) => ({ ...p, [id]: c })), [])
  const clear = useCallback(
    (id: string) =>
      setChanges((p) => {
        const { [id]: _gone, ...rest } = p
        return rest
      }),
    [],
  )
  return { changes, now, set, clear }
}
