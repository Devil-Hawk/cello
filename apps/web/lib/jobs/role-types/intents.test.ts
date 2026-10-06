import { describe, expect, it } from 'vitest'
import { ROLE_TAXONOMY } from '../role-taxonomy'
import { INTENT_ROLE_TYPES, ROLE_TYPE_IDS, roleTypesForIntent } from './index'

describe('main\'s 14 intents map into the taxonomy', () => {
  it('every old intent id has a row, and every row is an old intent id', () => {
    expect(Object.keys(INTENT_ROLE_TYPES).sort()).toEqual(ROLE_TAXONOMY.map((i) => i.id).sort())
    expect(ROLE_TAXONOMY).toHaveLength(14)
  })

  it('every mapped id is a role type of the module', () => {
    for (const [intent, ids] of Object.entries(INTENT_ROLE_TYPES)) {
      expect(ids.length, intent).toBeGreaterThan(0)
      for (const id of ids) expect(ROLE_TYPE_IDS, `${intent} -> ${id}`).toContain(id)
    }
  })

  it('an intent that stands for two types gives both, and an unknown id gives none', () => {
    expect(roleTypesForIntent('swe-ai-ml')).toEqual(['ai-engineer', 'ml-engineer'])
    expect(roleTypesForIntent('devops-sre')).toEqual(['platform-engineer'])
    expect(roleTypesForIntent('nope')).toEqual([])
    expect(roleTypesForIntent('toString')).toEqual([])
  })
})
