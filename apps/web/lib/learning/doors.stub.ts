// lane-stub: K14 doors
// Implements registry-models' pushed `lib/models/doors.types.ts` over today's callLlm until
// K14's ladder is on main. It defines no shape of its own; a change to the type fails the
// build here. Deleted when this lane rebases after K14 (lanes.md step 10).

import { loadApiKeys } from '../harness/keys'
import { callLlm } from '../harness/llm'
import { createAdminClient } from '../harness/supabase-admin'
import type { DecryptedApiKeys } from '../harness/types'
import type { ModelDoor, Rung, RungPick } from '../models/doors.types'

const ORDER: Rung[] = ['R0', 'R0s', 'R1', 'R2', 'R3', 'R4']

/** The rungs today's keys can reach: a local server or CLI is R2, an OpenRouter key is R3. */
export function availableRungs(keys: DecryptedApiKeys): Rung[] {
  const active = keys.provider?.active
  if (active === 'local-server' || active === 'local-cli') return ['R2']
  return keys.openrouter ? ['R3'] : []
}

function rungOf(keys: DecryptedApiKeys): Rung {
  return availableRungs(keys)[0] ?? 'R3'
}

export const doorsStub: ModelDoor = {
  pickRung(step, person, available): RungPick {
    const ceiling = ORDER.indexOf(person.ceiling)
    const usable = ORDER.filter((r) => available.includes(r) && ORDER.indexOf(r) <= ceiling)
    const rung = usable.find((r) => ORDER.indexOf(r) >= ORDER.indexOf(step.minRung))
    if (rung) return { rung, model: 'default', via: rung === 'R2' ? 'local-server' : 'openrouter' }
    if (usable.length > 0) return { rung: null, reason: 'below_min', sentence: 'The model you have is too small for this one. Cello leaves it for now.' }
    return { rung: null, reason: 'none_available', sentence: 'Cello has no model to read this with. Add a free model key or run one on this computer.' }
  },

  async complete(step, opts, ctx) {
    if (!ctx.userId) throw new Error('doors stub: a model call needs the person it is for')
    const keys = await loadApiKeys(createAdminClient(), ctx.userId)
    const res = await callLlm(keys, { ...opts, name: opts.name ?? step.id }, ctx.signal)
    return { ...res, prov: { step: step.id, model: res.model, rung: rungOf(keys), evidence: [], at: new Date().toISOString() } }
  },

  async chatModel() {
    throw new Error('doors stub: chatModel arrives with K14')
  },
}
