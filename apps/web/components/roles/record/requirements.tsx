'use client'

import { useState } from 'react'
import { Key } from '@/components/ui/key'
import type { FitItem, FitVerdict } from '@/lib/fit/types'
import { Evidence } from './fit-strip'
import { useFit } from './fit-state'

const GROUPS: Array<{ verdict: FitVerdict; title: string }> = [
  { verdict: 'strength', title: 'Pluses' },
  { verdict: 'gap', title: 'Minuses' },
  { verdict: 'unknown', title: 'Not sure' },
]

const KIND_ORDER = { must: 0, nice: 1, other: 2 } as const
const KIND_LABEL = { must: 'Required', nice: 'Nice to have', other: '' } as const

function Correct({ item }: { item: FitItem }) {
  const { correct } = useFit()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function pick(verdict: FitVerdict) {
    setError(null)
    if (await correct(item.requirementId, verdict, note)) return setOpen(false)
    setError('Could not save that. Try again.')
  }

  if (!open)
    return (
      <Key variant="ghost" aria-expanded={false} onClick={() => setOpen(true)}>
        Correct
      </Key>
    )
  return (
    <div className="space-y-2" role="group" aria-label="Correct this">
      <div className="flex flex-wrap gap-2">
        <Key variant="raised" onClick={() => pick('strength')}>
          It is a plus
        </Key>
        <Key variant="raised" onClick={() => pick('gap')}>
          It is a minus
        </Key>
        <Key variant="raised" onClick={() => pick('unknown')}>
          Not sure
        </Key>
      </div>
      <label className="block space-y-1.5">
        <span className="r-meta">A note, if you want to add one</span>
        <input className="r-field" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </label>
      {error && (
        <p role="alert" className="r-meta">
          {error}
        </p>
      )}
    </div>
  )
}

// Requirements, one by one: the employer's words (must have, then nice to have, in the posting's order),
// read as Pluses, Minuses and Not sure. Each carries its evidence or its reason; a model's verdict carries
// Cello's read mark, a person's correction reads "You said", and Correct is offered only where a correction
// can be stored.
export function Requirements() {
  const { items, kinds, correctable } = useFit()
  const kindOf = (id: string) => kinds[id] ?? 'other'
  return (
    <div className="space-y-6">
      {GROUPS.map(({ verdict, title }) => {
        const rows = items
          .map((item, at) => ({ item, at }))
          .filter((r) => r.item.verdict === verdict)
          .sort((a, b) => KIND_ORDER[kindOf(a.item.requirementId)] - KIND_ORDER[kindOf(b.item.requirementId)] || a.at - b.at)
        if (rows.length === 0) return null
        return (
          <section key={verdict} aria-label={title} className="space-y-3">
            <h3 className="r-title">
              {title}, {rows.length}
            </h3>
            <ol className="space-y-4">
              {rows.map(({ item }) => (
                <li key={item.requirementId} id={`req-${item.requirementId}`} className="space-y-1.5">
                  <p className="r-body">{item.requirement}</p>
                  {KIND_LABEL[kindOf(item.requirementId)] && <p className="r-meta">{KIND_LABEL[kindOf(item.requirementId)]}</p>}
                  <Evidence item={item} />
                  {correctable && <Correct item={item} />}
                </li>
              ))}
            </ol>
          </section>
        )
      })}
    </div>
  )
}
