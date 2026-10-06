'use client'

import { useState, type Dispatch, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { Key } from '@/components/ui/key'
import type { PassReason } from '@/lib/scoring/types'
import { NOT_FOR_ME_REASONS, deleteReaction, postReaction, undoOpen, type ReactionAction, type ReactionState } from './reactions'

export interface UseRoleReactions {
  id: string
  /** The person's earlier reaction, from the stored row. */
  reaction: 'interested' | 'not_for_me' | 'applied' | null
  state: ReactionState
  dispatch: Dispatch<ReactionAction>
  /** The page's clock, so Undo closes on its own. */
  now: number
  pickKind?: 'top' | 'explore'
  surface?: 'roles' | 'record'
}

/**
 * Interested and Not for me for one role: the two 44px keys, the row of eight
 * reasons with an optional note, and Undo for ten seconds. Used by a row on Roles
 * and by the head of the record, so the two cannot drift. `keys` goes beside the
 * role; `panel` goes under it.
 */
export function useRoleReactions({ id, reaction: stored, state, dispatch, now, pickKind, surface }: UseRoleReactions): { keys: ReactNode; panel: ReactNode } {
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const done = state.done[id]
  const reaction = done?.reaction ?? stored
  const asking = state.asking === id
  const canUndo = undoOpen(done, now)

  async function react(next: 'interested' | 'not_for_me', reason: PassReason | null = null) {
    setError(null)
    const ok = await postReaction(id, { reaction: next, reason, note: note.trim() || null, pickKind, surface })
    if (!ok) return setError('Could not save that. Try again.')
    setNote('')
    dispatch({ type: 'done', id, value: { reaction: next, reason, at: Date.now() } })
  }

  async function undo() {
    setError(null)
    if (!(await deleteReaction(id))) return setError('Could not take that back. Try again.')
    dispatch({ type: 'undo', id })
  }

  const keys = (
    <div className="flex w-full gap-2 sm:w-auto">
      {canUndo ? (
        <>
          <span className="r-meta flex min-h-11 flex-1 items-center gap-1.5 sm:flex-none" role="status">
            <Check className="h-4 w-4" aria-hidden /> {done?.reaction === 'interested' ? 'Saved as interested' : 'Hidden from For you'}
          </span>
          <Key variant="raised" className="flex-1 sm:flex-none" onClick={undo}>
            Undo
          </Key>
        </>
      ) : (
        <>
          <Key className="flex-1 sm:flex-none" aria-pressed={reaction === 'interested'} onClick={() => (reaction === 'interested' ? undo() : react('interested'))}>
            Interested
          </Key>
          <Key variant="raised" className="flex-1 sm:flex-none" aria-expanded={asking} onClick={() => dispatch({ type: asking ? 'close' : 'ask', id })}>
            Not for me
          </Key>
        </>
      )}
    </div>
  )

  const panel =
    asking || error ? (
      <div className="space-y-3 px-2 pb-4 pt-1">
        {asking && (
          <>
            <p className="r-meta" id={`why-${id}`}>
              What is it about this role
            </p>
            <div className="flex flex-wrap gap-2" role="group" aria-labelledby={`why-${id}`}>
              {NOT_FOR_ME_REASONS.map((r) => (
                <Key key={r.reason} variant="raised" onClick={() => react('not_for_me', r.reason)}>
                  {r.label}
                </Key>
              ))}
              <Key variant="ghost" onClick={() => react('not_for_me')}>
                No reason
              </Key>
            </div>
            <label className="block space-y-1.5">
              <span className="r-meta">A note, if you want to add one</span>
              <input className="r-field" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
            </label>
          </>
        )}
        {error && (
          <p role="alert" className="r-meta">
            {error}
          </p>
        )}
      </div>
    ) : null

  return { keys, panel }
}
