// Role types (blueprint 6.1): the taxonomy, the title normaliser and tier 1 typing, with one function that
// types a raw title the way the reader and the backfill do.

import type { TypeProv } from '../relevance-types'
import { normaliseDept, normaliseTitle, titleKey } from './normalise'
import { typeByCode } from './tier1'

export * from './taxonomy'
export * from './intents'
export { normaliseDept, normaliseTitle, titleKey } from './normalise'
export { typeByCode, type CodeType } from './tier1'
// The old intent engine, until K15b: callers import it from here, beside the ids its intents stand for.
export { classifyTitleForIntent, getRoleIntent, keywordsForIntent, resolveRoleIntent, type RoleIntentDef, type RoleIntentId } from '../role-taxonomy'

export interface TypedTitle {
  title_norm: string
  dept_norm: string
  role_type: string | null
  type_origin: 'code' | null
  type_prov: TypeProv | null
}

/** A raw title (and the posting's department or team, when it has one) to its key and its tier 1 type. */
export function typeTitle(rawTitle: string, rawDept?: string | null): TypedTitle {
  const key = titleKey(normaliseTitle(rawTitle).title_norm, normaliseDept(rawDept))
  const hit = typeByCode(key.title_norm, key.dept_norm)
  return { ...key, role_type: hit?.role_type ?? null, type_origin: hit ? 'code' : null, type_prov: hit?.prov ?? null }
}
