// role_types.list: the types a person can choose, searched by label, synonym and id, with each type's
// related types. Code over the taxonomy module: the same answer on the server and in the chooser.

import { getRoleType, MAX_ROLE_TYPES, ROLE_TYPES } from './taxonomy'

export { MAX_ROLE_TYPES }

export interface RoleTypeListing {
  id: string
  label: string
  family: string
  synonyms: string[]
  related: { id: string; label: string }[]
}

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

/** A type scores 0 when its label starts with the query, 1 when its label has it, 2 when a synonym or id does; null when none. */
function score(query: string, tokens: string[], label: string, haystack: string[]): number | null {
  const l = label.toLowerCase()
  if (l.startsWith(query)) return 0
  if (tokens.every((t) => l.includes(t))) return 1
  const text = haystack.join(' | ')
  return tokens.every((t) => text.includes(t)) ? 2 : null
}

/** `other` is what the typing tiers answer when nothing fits; nobody chooses it. */
export function listRoleTypes(query = '', opts: { exclude?: readonly string[]; limit?: number } = {}): RoleTypeListing[] {
  const q = query.trim().toLowerCase()
  const tokens = words(q)
  const out: { at: number; listing: RoleTypeListing }[] = []
  for (const type of ROLE_TYPES) {
    if (type.id === 'other' || opts.exclude?.includes(type.id)) continue
    const at = tokens.length === 0 ? 0 : score(q, tokens, type.label, [type.id.replace(/-/g, ' '), ...type.synonyms])
    if (at === null) continue
    out.push({
      at,
      listing: {
        id: type.id,
        label: type.label,
        family: type.family,
        synonyms: [...type.synonyms],
        related: type.related.flatMap((id) => {
          const r = getRoleType(id)
          return r ? [{ id, label: r.label }] : []
        }),
      },
    })
  }
  // taxonomy order breaks a tie, so the list never reshuffles between keystrokes
  return out.sort((a, b) => a.at - b.at).slice(0, opts.limit ?? 8).map((o) => o.listing)
}
