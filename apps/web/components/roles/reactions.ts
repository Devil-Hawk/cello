// What the person did on this page, held above the rows so it survives the rows
// moving: a regroup, a filter or a refresh of the list never loses an Undo that
// is still open. Pure, so a test can run the clock.

import type { PassReason, Reaction } from '@/lib/scoring/types'
import type { RoleItem } from './types'

export const UNDO_MS = 10_000

/** The eight reasons Not for me offers, in the order of the page. */
export const NOT_FOR_ME_REASONS: ReadonlyArray<{ reason: PassReason; label: string }> = [
  { reason: 'level', label: 'Level' },
  { reason: 'location', label: 'Location' },
  { reason: 'relocation', label: 'Relocation' },
  { reason: 'role_type', label: 'Role type' },
  { reason: 'company', label: 'Company' },
  { reason: 'pay', label: 'Pay' },
  { reason: 'agency', label: 'Agency' },
  { reason: 'other', label: 'Other' },
]

export interface Done {
  reaction: Extract<Reaction, 'interested' | 'not_for_me'>
  reason: PassReason | null
  /** When the server accepted it (ms). */
  at: number
}

export interface ReactionState {
  /** The role whose reasons are open. Only one at a time. */
  asking: string | null
  done: Readonly<Record<string, Done>>
}

export type ReactionAction =
  | { type: 'ask'; id: string }
  | { type: 'close' }
  | { type: 'done'; id: string; value: Done }
  | { type: 'undo'; id: string }

export const NO_REACTIONS: ReactionState = { asking: null, done: {} }

export function reactionReducer(state: ReactionState, action: ReactionAction): ReactionState {
  switch (action.type) {
    case 'ask':
      return { ...state, asking: action.id }
    case 'close':
      return { ...state, asking: null }
    case 'done':
      return { asking: null, done: { ...state.done, [action.id]: action.value } }
    case 'undo': {
      const { [action.id]: _removed, ...rest } = state.done
      return { ...state, done: rest }
    }
  }
}

/** Undo is offered for ten seconds from the moment the server accepted the reaction. */
export function undoOpen(done: Done | undefined, now: number): boolean {
  return !!done && now - done.at < UNDO_MS
}

/**
 * The rows to draw. A role the person just passed on stays as a line with its
 * Undo while that is open, wherever the grouping puts it, and leaves the list
 * when the ten seconds are over.
 */
export function visibleItems<T extends RoleItem>(items: readonly T[], state: ReactionState, now: number): T[] {
  return items.filter((i) => {
    const d = state.done[i.id]
    return !(d?.reaction === 'not_for_me' && !undoOpen(d, now))
  })
}

// --- the two calls the buttons make ---------------------------------------------

export interface ReactBody {
  reaction: 'interested' | 'not_for_me' | 'applied'
  reason?: PassReason | null
  note?: string | null
  pickKind?: 'top' | 'explore' | null
  /** Where the person is looking; Roles by default. */
  surface?: 'roles' | 'record'
}

/** POST /api/roles/:id/reaction. True when the server accepted it. */
export async function postReaction(jobId: string, body: ReactBody): Promise<boolean> {
  try {
    const res = await fetch(`/api/roles/${jobId}/reaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, surface: body.surface ?? 'roles' }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** DELETE /api/roles/:id/reaction. True when it was taken back. */
export async function deleteReaction(jobId: string): Promise<boolean> {
  try {
    return (await fetch(`/api/roles/${jobId}/reaction`, { method: 'DELETE' })).ok
  } catch {
    return false
  }
}
