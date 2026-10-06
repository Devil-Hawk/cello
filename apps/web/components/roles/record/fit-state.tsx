'use client'

// The fit of one role as the record holds it: the items as read, with the person's corrections laid over
// them, so the strip on the first screen and the requirements lower down always count the same things.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import type { FitItem, FitStrip, FitVerdict, RoleFitView } from '@/lib/fit/types'
import { sendCorrection } from './fit-call'
import { stripOf } from './logic'

interface FitState {
  items: FitItem[]
  /** must, nice or other for each requirement, as the posting's own list put it. */
  kinds: Readonly<Record<string, 'must' | 'nice' | 'other'>>
  strip: FitStrip
  /** Where a correction is sent; null when nothing stores one yet, and then Correct is not offered. */
  correctable: boolean
  correct: (requirementId: string, verdict: FitVerdict, note: string) => Promise<boolean>
}

const Ctx = createContext<FitState | null>(null)

export function useFit(): FitState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useFit needs a FitProvider')
  return v
}

export function FitProvider({ view, kinds, correctUrl, children }: { view: RoleFitView; kinds: Readonly<Record<string, 'must' | 'nice' | 'other'>>; correctUrl: string | null; children: ReactNode }) {
  const [said, setSaid] = useState<Readonly<Record<string, { verdict: FitVerdict; note: string }>>>({})
  const items = useMemo<FitItem[]>(
    () => view.items.map((i) => (said[i.requirementId] ? { ...i, verdict: said[i.requirementId].verdict, origin: 'person', evidence: [], notFound: false, note: said[i.requirementId].note || undefined } : i)),
    [view.items, said],
  )
  const correct = useCallback(
    async (requirementId: string, verdict: FitVerdict, note: string) => {
      if (!correctUrl || !(await sendCorrection(correctUrl, requirementId, verdict, note))) return false
      setSaid((p) => ({ ...p, [requirementId]: { verdict, note } }))
      return true
    },
    [correctUrl],
  )
  const value = useMemo(() => ({ items, kinds, strip: stripOf(items), correctable: correctUrl !== null, correct }), [items, kinds, correctUrl, correct])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
