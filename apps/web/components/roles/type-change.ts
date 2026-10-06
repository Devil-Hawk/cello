// Change type, as the page holds it: what the person changed, kept above the rows so a row that moves
// to another type group keeps its Undo, and the one call that writes it. Pure apart from the call.

import { UNDO_MS } from './reactions'
import type { RoleItem, RoleTypeView } from './types'

export interface TypeChange {
  /** The type the row now shows. */
  to: RoleTypeView
  /** What Undo sends: the person's own word before this change, or null when they had none. */
  prevOwn: string | null
  /** When the server accepted it (ms). */
  at: number
}

export type TypeChanges = Readonly<Record<string, TypeChange>>

/** The rows as the person has changed them, so a row lands in its new type's group at once. */
export function applyTypeChanges<T extends RoleItem>(items: readonly T[], changes: TypeChanges): T[] {
  return items.map((i) => (changes[i.id] ? { ...i, type: changes[i.id].to } : i))
}

/** What Undo would send for a row: its own word for the title, which is none unless the person gave one. */
export function previousOwn(item: Pick<RoleItem, 'type'>): string | null {
  return item.type?.own ? item.type.id : null
}

export const typeUndoOpen = (c: TypeChange | undefined, now: number) => !!c && now - c.at < UNDO_MS

/** POST /api/roles/:id/type. True when the server accepted it. typeId null takes the person's word back. */
export async function postType(jobId: string, typeId: string | null): Promise<boolean> {
  try {
    const res = await fetch(`/api/roles/${jobId}/type`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ typeId }) })
    return res.ok
  } catch {
    return false
  }
}
