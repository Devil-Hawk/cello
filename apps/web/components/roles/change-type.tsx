'use client'

import { useState } from 'react'
import { Check } from 'lucide-react'
import { Key } from '@/components/ui/key'
import { postType, previousOwn, typeUndoOpen, type TypeChange } from './type-change'
import type { RoleItem } from './types'

export interface ChangeTypeProps {
  /** The row as it is drawn now: its type is the changed one while a change stands. */
  item: Pick<RoleItem, 'id' | 'type'>
  /** Every type a person can pick, by label. */
  options: readonly { id: string; label: string }[]
  change: TypeChange | undefined
  /** The page's clock, so Undo closes on its own. */
  now: number
  onChange: (id: string, c: TypeChange) => void
  onUndo: (id: string) => void
  /** "Change type" on a row; "Set type" on a role Cello could not place. */
  label?: string
  /** Called after a write that has no type to draw (None of these), so the page reads the row again. */
  onReset?: () => void
}

// Change type (roles.set_type): the person's word for this role's title, which applies to every role
// of theirs with that title. A native select, so it works with the keyboard and a screen reader, and
// the 44px target is the field's own. Undo for ten seconds sends back what the person had before.
export function ChangeType({ item, options, change, now, onChange, onUndo, label = 'Change type', onReset }: ChangeTypeProps) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const undoable = typeUndoOpen(change, now)
  const name = item.type?.label

  async function choose(value: string) {
    setError(null)
    const typeId = value === '' ? null : value
    const prev = previousOwn(item)
    if (!(await postType(item.id, typeId))) return setError('Could not change the type. Try again.')
    setOpen(false)
    const to = typeId ? options.find((o) => o.id === typeId) : null
    if (to) onChange(item.id, { to: { id: to.id, label: to.label, own: true, origin: null }, prevOwn: prev, at: Date.now() })
    else onReset?.()
  }

  async function undo() {
    setError(null)
    if (!(await postType(item.id, change?.prevOwn ?? null))) return setError('Could not take that back. Try again.')
    onUndo(item.id)
    onReset?.()
  }

  if (undoable && name) {
    return (
      <div className="flex flex-wrap items-center gap-3 px-2 pb-3">
        <span className="r-meta flex min-h-11 items-center gap-1.5" role="status">
          <Check className="h-4 w-4" aria-hidden /> Cello will count titles like this as {name} for you.
        </span>
        <Key variant="raised" onClick={undo}>
          Undo
        </Key>
        {error && (
          <span role="alert" className="r-meta">
            {error}
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-3 px-2 pb-3">
      {open ? (
        <label className="flex flex-wrap items-center gap-2">
          <span className="r-meta">{label === 'Set type' ? 'Role type' : 'Change type to'}</span>
          <select className="r-field" defaultValue="__" onChange={(e) => e.target.value !== '__' && choose(e.target.value)}>
            <option value="__" disabled>
              Choose a type
            </option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
            <option value="">None of these</option>
          </select>
        </label>
      ) : (
        <Key variant="ghost" aria-expanded={false} onClick={() => setOpen(true)}>
          {label}
        </Key>
      )}
      {error && (
        <span role="alert" className="r-meta">
          {error}
        </span>
      )}
    </div>
  )
}
