// The Langfuse names per unit type are code constants. Every unit type must have
// both, they must pass the name rule, and no two may collide, so a new unit
// cannot ship as `call-llm` or share a trace row label with another.

import { describe, expect, it, vi } from 'vitest'
import { UNIT_TYPES } from '../harness/schemas'
import { safeName } from '../observability/langfuse'

vi.mock('../harness/registry', () => ({ UNIT_REGISTRY: {} }))

const { UNIT_AGENT_NAME, UNIT_GENERATION_NAME } = await import('./unit')

describe('Langfuse unit names', () => {
  it('every unit type has an agent name and a generation name, and nothing else does', () => {
    expect(Object.keys(UNIT_AGENT_NAME).sort()).toEqual([...UNIT_TYPES].sort())
    expect(Object.keys(UNIT_GENERATION_NAME).sort()).toEqual([...UNIT_TYPES].sort())
  })

  it('all names are valid (safeName leaves them alone) and unique', () => {
    const all = [...Object.values(UNIT_AGENT_NAME), ...Object.values(UNIT_GENERATION_NAME)]
    for (const n of all) {
      expect(safeName(n)).toBe(n)
      expect(n).not.toBe('call-llm')
    }
    expect(new Set(all).size).toBe(all.length)
    for (const n of Object.values(UNIT_AGENT_NAME)) expect(n.startsWith('run-')).toBe(true)
  })
})
