// Tier 1 of typing a title: code only (blueprint 6.1). Cheapest first, and the first that answers wins:
//
//   exclusions    "AI Product Manager" is never an AI engineer: a title that is another job goes to its own type
//   synonyms      the whole normalised title is a type's synonym
//   patterns      a phrase on word boundaries inside the title; the longest phrase wins, then taxonomy order,
//                 and `software-engineer` last, because it matches nearly every engineering title
//   department    a title that names no particular job ("member of technical staff") is read by the same
//                 patterns on the posting's department or team; with none, it goes on to tier 2
//   family        main's classify.ts rules type the other families (sales, support, ...)
//
// Returns null for a title no rule places: it goes on to tier 2, never to `other`.

import { classifyJob } from '../classify'
import type { TypeProv } from '../relevance-types'
import { AMBIGUOUS_TITLES, EXCLUDED_FAMILIES, ROLE_TYPES, SHARED_EXCLUSIONS, TAXONOMY_VERSION } from './taxonomy'

export interface CodeType {
  role_type: string
  prov: TypeProv
}

const FALLBACK = 'software-engineer'
const OTHER_FAMILIES = new Map(ROLE_TYPES.filter((r) => r.id.startsWith('other-')).map((r) => [r.family, r.id]))

const has = (padded: string, phrase: string) => padded.includes(` ${phrase} `)

interface Hit {
  id: string
  rule: 'synonym' | 'pattern'
  pattern: string
  score: number
}

function match(titleNorm: string): Hit | null {
  const padded = ` ${titleNorm} `
  const excluded = SHARED_EXCLUSIONS.some((x) => has(padded, x))
  let best: Hit | null = null
  for (const type of ROLE_TYPES) {
    const synonym = type.synonyms.find((s) => s === titleNorm)
    let hit: Hit | null = synonym ? { id: type.id, rule: 'synonym', pattern: synonym, score: 10_000 + synonym.length } : null
    if (!hit && !(excluded && EXCLUDED_FAMILIES.includes(type.family))) {
      const longest = type.patterns.filter((p) => has(padded, p)).sort((a, b) => b.length - a.length)[0]
      if (longest) hit = { id: type.id, rule: 'pattern', pattern: longest, score: type.id === FALLBACK ? longest.length - 1000 : longest.length }
    }
    // taxonomy order breaks a tie: only a strictly better score replaces the first
    if (hit && (!best || hit.score > best.score)) best = hit
  }
  return best
}

export function typeByCode(titleNorm: string, deptNorm = ''): CodeType | null {
  if (!titleNorm) return null
  const prov = (extra: Partial<TypeProv>): TypeProv => ({ taxonomy_version: TAXONOMY_VERSION, ...extra })

  if (AMBIGUOUS_TITLES.includes(titleNorm)) {
    if (!deptNorm) return null
    // "applied ai" is read as the job it names: an applied ai engineer
    const hit = match(`${deptNorm} engineer`)
    return hit && hit.id !== FALLBACK ? { role_type: hit.id, prov: prov({ rule: 'department', pattern: hit.pattern }) } : null
  }

  const hit = match(titleNorm)
  if (hit) return { role_type: hit.id, prov: prov({ rule: hit.rule, pattern: hit.pattern }) }

  const family = OTHER_FAMILIES.get(classifyJob({ title: titleNorm }).jobFunction)
  return family ? { role_type: family, prov: prov({ rule: 'pattern', pattern: `classify.ts ${family.slice(6)}` }) } : null
}
