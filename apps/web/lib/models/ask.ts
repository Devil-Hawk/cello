// A model completion that a person would accept, through a declared step (lib/steps): the ladder picks the way in and the
// ceiling holds. On a free rung the chosen model is asked first, then the other free ones, and an answer is taken only when
// it passes the caller's own check (not empty, not thinking aloud, in the shape asked for: JSON, or what `valid` says).
// A reasoning model spends its tokens thinking and can return nothing, so thinking is off on a free rung.
//
// ponytail: up to four attempts, in the list's order; a better order (fastest first) waits until the free list has timings.

import type { DecryptedApiKeys, LlmRunner, LlmRunOptions } from '@/lib/harness/types'
import { legacyStep } from '@/lib/steps/legacy'
import { FreeCapError } from './caps'
import { freeModels, isFreeModel } from './free'

const looksLikeJson = (s: string) => {
  try {
    JSON.parse(s.trim())
    return true
  } catch {
    return /[[{][\s\S]*[\]}]/.test(s)
  }
}

/**
 * A runner for a declared step that tries the next free model when one throws or does not answer acceptably, and counts the
 * day's free cap once. When every free model fails the error says what each said; nothing is made up.
 */
export function stepRunner(stepId: string, keys: DecryptedApiKeys, signal?: AbortSignal, valid?: (text: string) => boolean): LlmRunner {
  // One piece of work is one use of the day's free cap, however many calls it makes (a tailoring is score, rewrite, rescore).
  let counted = false
  return async (opts) => {
    const free = keys.models?.ceiling !== 'R4'
    const first = keys.model && isFreeModel(keys.model) ? [keys.model] : []
    const models = free ? [...new Set([...first, ...freeModels()])].slice(0, 4) : [undefined]
    const failures: string[] = []
    let last: unknown = new Error('No model answered.')
    let attempted = counted
    for (const model of models) {
      try {
        // A free reasoning model spends its whole budget thinking and returns nothing, so thinking is off on a free rung.
        counted = true
        const out = await legacyStep(stepId).call(model ? { ...keys, model } : keys, free ? { ...opts, reasoning: { effort: 'none' } } : opts, { signal, ...(attempted ? { slots: { take: async () => true } } : {}) })
        if (!out.content.trim()) throw new Error(`${out.model} returned nothing`)
        if ((opts.json || opts.jsonSchema) && !looksLikeJson(out.content)) throw new Error(`${out.model} did not answer in JSON`)
        if (valid && !valid(out.content.trim())) throw new Error(`${out.model} did not follow the instructions`)
        return out
      } catch (e) {
        if (signal?.aborted || e instanceof FreeCapError) throw e
        attempted = true
        last = e
        failures.push(`${model ?? 'the chosen model'}: ${String(e instanceof Error ? e.message : e).replace(/\s+/g, ' ').slice(0, 140)}`)
      }
    }
    throw models.length > 1 ? new Error(`No free model could do this just now. ${failures.join(' | ')}`) : last
  }
}

export interface Asked {
  text: string
  model: string
}

/** One completion from the chosen model (then the other free ones) that passes `valid`; null, with the reasons in `errors`, when none does. */
export async function askModel(
  keys: DecryptedApiKeys,
  chosen: string,
  opts: Omit<LlmRunOptions, 'model'>,
  valid: (text: string) => boolean,
  signal?: AbortSignal,
  errors: string[] = [],
  step = 'write-summary'
): Promise<Asked | null> {
  try {
    const out = await stepRunner(step, { ...keys, model: chosen }, signal, valid)({ maxTokens: 1500, temperature: 0.3, ...opts })
    return { text: out.content.trim(), model: out.model }
  } catch (e) {
    if (signal?.aborted || e instanceof FreeCapError) throw e
    errors.push(String(e instanceof Error ? e.message : e).slice(0, 400))
    return null
  }
}
