// The model door the learning and fit modules call: the rung comes from the ladder
// (lib/models/ladder.ts) and every call goes through a declared step (lib/steps), so the
// ceiling, the spend ledger and the trace sit in front of it.

import { loadApiKeys } from '../harness/keys'
import { createAdminClient } from '../harness/supabase-admin'
import { availableRungs, pickRung } from '../models/ladder'
import { defineModelStep, type ModelStep } from '../steps'
import type { ModelDoor, StepRef } from '../models/doors.types'

export { availableRungs }

/** The register's measure for each step this door serves. */
const MEASURE: Record<string, string> = { 'learning.read': 'S16', 'role.evidence': 'S20', 'role.type': 'S2' }

const declared = new Map<string, ModelStep>()

function stepFor(ref: StepRef): ModelStep {
  let step = declared.get(ref.id)
  if (!step) {
    step = defineModelStep({ id: ref.id, kind: 'step', measure: MEASURE[ref.id] ?? 'S16', minRung: ref.minRung, below: ref.below })
    declared.set(ref.id, step)
  }
  return step
}

export const modelDoor: ModelDoor = {
  pickRung: (step, person, available, keys) => pickRung(step, person, available, keys),

  async complete(step, opts, ctx) {
    if (!ctx.userId) throw new Error('model door: a model call needs the person it is for')
    const keys = await loadApiKeys(createAdminClient(), ctx.userId)
    return stepFor(step).call(keys, opts, { door: ctx.door, signal: ctx.signal })
  },

  async chatModel() {
    throw new Error('model door: chat models are built by lib/models/factory')
  },
}
