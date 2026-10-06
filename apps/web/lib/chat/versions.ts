// "Version 1 of 2": editing the person's earlier turn forks the chat (edit.ts), and every turn from there on stays,
// marked superseded. This picks the turns to show: for each turn that was edited, one version of it and the turns
// that followed that version, the newest unless the person picked another. Pure; it only reads what is stored.

import type { TurnRow } from './types'

export interface VersionSlot {
  /** 1-based version shown, and how many there are. */
  index: number
  count: number
  /** The first version's turn id: the key `pick` is given in. */
  root: string
  /** The turn id of each version, oldest first. */
  versions: string[]
}

export interface Visible {
  turns: TurnRow[]
  /** The switcher to draw, keyed by the id of the turn it sits on. */
  slots: Record<string, VersionSlot>
}

/** `pick` maps a slot's root (its first version's id) to the version the person chose, 0-based. */
export function visibleTurns(turns: TurnRow[], pick: Record<string, number> = {}): Visible {
  const out: Visible = { turns: [], slots: {} }
  walk(turns, pick, out)
  return out
}

function walk(turns: TurnRow[], pick: Record<string, number>, out: Visible) {
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]
    if (t.kind !== 'person' || t.branch_of) {
      out.turns.push(t)
      continue
    }
    // Every later version of this turn: a turn that replaced it, or replaced one that did.
    const chain = new Set([t.id])
    const starts = [i]
    turns.forEach((u, at) => {
      if (at > i && u.branch_of && chain.has(u.branch_of)) {
        chain.add(u.id)
        starts.push(at)
      }
    })
    if (starts.length === 1) {
      out.turns.push(t)
      continue
    }
    const at = Math.min(Math.max(pick[t.id] ?? starts.length - 1, 0), starts.length - 1)
    const slice = turns.slice(starts[at], starts[at + 1] ?? turns.length)
    out.slots[slice[0].id] = { index: at + 1, count: starts.length, root: t.id, versions: starts.map((s) => turns[s].id) }
    // The version's own first turn, then the rest of it, which may hold edits of its own.
    out.turns.push(slice[0])
    walk(slice.slice(1), pick, out)
    return
  }
}
