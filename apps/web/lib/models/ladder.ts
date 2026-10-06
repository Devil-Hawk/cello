// The ladder (blueprint 11.1): which rung a model step runs on.
//
// The person sets "Highest Cello may use" and an order. A step names the lowest
// rung at which it still does its job. pickRung takes the rungs at or under the
// ceiling and at or above that minimum, in the person's order, and the first one
// that is set up wins. Nothing climbs above the ceiling; a step with no rung left
// says what happens instead (BelowRungError carries that sentence).

import { DEFAULT_MODEL_ID } from '@/lib/models'
import { MissingKeyError } from '../harness/providers'
import type { DecryptedApiKeys } from '../harness/types'
import { isSelfHosted } from '../self-hosted'
import type { Ceiling, PersonModels, Rung, RungPick, RungVia, StepRef } from './doors.types'
import { freeModels, isFreeModel } from './free'

const RANK: Record<Rung, number> = { R0: 0, R0s: 1, R1: 2, R2: 3, R3: 4, R4: 5 }
const RUNGS = Object.keys(RANK) as Rung[]
const CEILINGS: Ceiling[] = ['R0', 'R1', 'R2', 'R3', 'R4']

/** The rungs a model call can run on today. R0s, R1 and hosted R2 are not offered:
 *  the browser model, the server embedder and the relay arrive with K22 and K15. */
export const CALLABLE = new Set<Rung>(['R2', 'R3', 'R4'])

/** Highest first: a step steps down from the ceiling when a rung is not set up. */
const DEFAULT_ORDER: Rung[] = ['R4', 'R3', 'R2', 'R1']
const LOCAL_FIRST: Rung[] = ['R2', 'R4', 'R3', 'R1']

export const isRung = (v: unknown): v is Rung => typeof v === 'string' && (RUNGS as string[]).includes(v)
export const isCeiling = (v: unknown): v is Ceiling => typeof v === 'string' && (CEILINGS as string[]).includes(v)

/** A step with no rung at or above its minimum under the person's ceiling. Extends
 *  MissingKeyError, so every caller that already handles "no usable model" keeps working. */
export class BelowRungError extends MissingKeyError {
  constructor(sentence: string) {
    super(sentence)
    this.name = 'BelowRungError'
  }
}

const hasLocal = (k: DecryptedApiKeys) =>
  isSelfHosted() && (k.provider?.active === 'local-cli' || (k.provider?.active === 'local-server' && Boolean(k.provider.localServerBaseUrl)))

const hasPaidKey = (k: DecryptedApiKeys) => Boolean(k.openrouter || k.openai || k.anthropic)

/** Rungs that are set up for this person. R4 only under a ceiling of R4. */
export function availableRungs(keys: DecryptedApiKeys, ceiling: Ceiling = keys.models?.ceiling ?? 'R4'): Rung[] {
  const out: Rung[] = ['R0']
  if (hasLocal(keys)) out.push('R2')
  if (keys.openrouter) out.push('R3')
  if (ceiling === 'R4' && hasPaidKey(keys)) out.push('R4')
  return out
}

/** The highest rung with no cost that is set up, unless the person already chose to pay: their own
 *  OpenAI or Anthropic key (only ever used to pay) or a paid model on OpenRouter. Then their choice
 *  stands, so turning the ladder on does not stop what they pay for today. */
function defaultCeiling(keys: DecryptedApiKeys): Ceiling {
  if (keys.openai || keys.anthropic || (keys.openrouter && keys.model && !isFreeModel(keys.model))) return 'R4'
  const free = availableRungs(keys, 'R3')
  return free.includes('R3') ? 'R3' : free.includes('R2') ? 'R2' : 'R0'
}

/** What this person allows, from preferences.models and preferences.pipeline.credit_bought
 *  (credit_bought sits in pipeline, which only set_autonomy writes). */
export function personModels(keys: DecryptedApiKeys, preferences: Record<string, unknown> | null | undefined, isDemo = false): PersonModels {
  // A demo spends the operator's capped allowance on paid models, as it always has.
  if (isDemo) return { ceiling: 'R4', order: DEFAULT_ORDER, creditBought: true }
  const saved = (preferences?.models ?? {}) as { ceiling?: unknown; order?: unknown }
  const pipeline = (preferences?.pipeline ?? {}) as { credit_bought?: unknown }
  const order = Array.isArray(saved.order) ? saved.order.filter(isRung) : []
  return {
    ceiling: isCeiling(saved.ceiling) ? saved.ceiling : defaultCeiling(keys),
    // A person running their own local model gets it first: it costs nothing and has no daily limit.
    order: order.length > 0 ? order : hasLocal(keys) ? LOCAL_FIRST : DEFAULT_ORDER,
    creditBought: pipeline.credit_bought === true,
  }
}

/** The id a vendor's own API takes, from the OpenRouter-style id the person picked ("openai/gpt-5.2"
 *  becomes "gpt-5.2"). Anything else gets the vendor's default. Anthropic's ids use dashes where OpenRouter's use dots. */
export function directModel(via: 'openai' | 'anthropic', id?: string): string {
  const bare = id?.startsWith(`${via}/`) ? id.slice(via.length + 1) : id && !id.includes('/') ? id : via === 'openai' ? 'gpt-5.2' : 'claude-sonnet-5'
  return via === 'anthropic' ? bare.replace(/\./g, '-') : bare
}

/** The model and the way in for a rung, from the person's keys. */
export function routeFor(rung: Rung, keys: DecryptedApiKeys): { model: string; via: RungVia } {
  if (rung === 'R2') {
    return keys.provider?.active === 'local-cli'
      ? { via: 'local-cli', model: `local-cli/${keys.provider.localCli}` }
      : { via: 'local-server', model: keys.provider?.localServerModel || keys.model || '' }
  }
  if (rung === 'R3') return { via: 'openrouter', model: keys.model && isFreeModel(keys.model) ? keys.model : freeModels()[0] }
  const chosen = keys.model && !isFreeModel(keys.model) ? keys.model : undefined
  if (keys.openrouter) return { via: 'openrouter', model: chosen ?? DEFAULT_MODEL_ID }
  const via = keys.openai ? 'openai' : 'anthropic'
  return { via, model: directModel(via, chosen) }
}

/** The rung a step runs on, or why none can. `keys` gives the model and the way in. */
export function pickRung(step: StepRef, person: PersonModels, available: Rung[], keys: DecryptedApiKeys): RungPick {
  const within = available.filter((r) => CALLABLE.has(r) && RANK[r] <= RANK[person.ceiling])
  const usable = within.filter((r) => RANK[r] >= RANK[step.minRung])
  const rung = [...person.order, ...usable].find((r) => usable.includes(r))
  if (!rung) {
    return { rung: null, reason: within.length > 0 ? 'below_min' : 'none_available', sentence: step.below }
  }
  return { rung, ...routeFor(rung, keys) }
}
