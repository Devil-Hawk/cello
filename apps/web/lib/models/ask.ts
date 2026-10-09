// One model completion that a person would accept: the chosen model first, then the other free ones, each asked
// again only when its answer fails the caller's own check (empty, thinking aloud, not the shape asked for).
// A reasoning model spends its tokens thinking and can return nothing at a small budget, so reasoning is off and the
// budget generous. Every attempt goes through callLlm, so it is reserved, settled and written to llm_spend.
//
// ponytail: three attempts, in order; a better order (fastest first) waits until the free list has timings.

import { callLlm } from '@/lib/harness/llm'
import type { DecryptedApiKeys, LlmRunner, LlmRunOptions } from '@/lib/harness/types'
import { legacyStep } from '@/lib/steps/legacy'
import { FreeCapError } from './caps'
import { freeModels, isFreeModel } from './free'

export interface Asked {
  text: string
  model: string
}

/** Null when no model's answer passed `valid`; `errors` collects what each attempt said, for the caller to show. */
export async function askModel(
  keys: DecryptedApiKeys,
  chosen: string,
  opts: Omit<LlmRunOptions, 'model'>,
  valid: (text: string) => boolean,
  signal?: AbortSignal,
  errors: string[] = []
): Promise<Asked | null> {
  const tried = [chosen, ...freeModels().filter((m) => m !== chosen)].slice(0, 4)
  for (const model of tried) {
    try {
      const out = await callLlm(keys, { maxTokens: 1500, temperature: 0.3, reasoning: { effort: 'none' }, ...opts, model }, signal)
      const text = out.content.trim()
      if (valid(text)) return { text, model }
      console.warn('askModel: answer rejected', model, JSON.stringify(text).slice(0, 400))
      errors.push(`${model}: ${text ? 'did not follow the instructions' : 'returned nothing'} (finish ${out.finishReason ?? '?'}, ${out.completionTokens} tokens, ${out.reasoningTokens ?? 0} reasoning)`)
    } catch (e) {
      if (signal?.aborted) throw e
      errors.push(`${model}: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`)
    }
  }
  return null
}

/**
 * A model runner for an old caller (the resume optimizer, the Writer) that goes through its declared step, so the ladder
 * picks the model and the ceiling holds, and that, on a free rung, tries the next free model when one throws or does not
 * answer in the shape asked for (JSON, when the caller asked for JSON). The error of the last attempt stands when all fail.
 */
export function stepRunner(stepId: string, keys: DecryptedApiKeys, signal?: AbortSignal): LlmRunner {
  return async (opts) => {
    const free = keys.models?.ceiling !== 'R4'
    const first = keys.model && isFreeModel(keys.model) ? [keys.model] : []
    const models = free ? [...new Set([...first, ...freeModels()])].slice(0, 4) : [undefined]
    const failures: string[] = []
    let last: unknown = new Error('No model answered.')
    // The day's free cap counts the step once, not once per model tried.
    let attempted = false
    for (const model of models) {
      try {
        // A free reasoning model spends its whole budget thinking and returns nothing, so thinking is off on a free rung.
        const out = await legacyStep(stepId).call(model ? { ...keys, model } : keys, free ? { ...opts, reasoning: { effort: 'none' } } : opts, { signal, ...(attempted ? { slots: { take: async () => true } } : {}) })
        if (!out.content.trim()) throw new Error(`${out.model} returned nothing`)
        if ((opts.json || opts.jsonSchema) && !looksLikeJson(out.content)) throw new Error(`${out.model} did not answer in JSON`)
        return out
      } catch (e) {
        if (signal?.aborted || e instanceof FreeCapError) throw e
        attempted = true
        last = e
        failures.push(`${model ?? 'the chosen model'}: ${String(e instanceof Error ? e.message : e).replace(/\s+/g, ' ').slice(0, 140)}`)
      }
    }
    // Every free model failed: say so with what each said, never a made-up result.
    throw models.length > 1 ? new Error(`No free model could do this just now. ${failures.join(' | ')}`) : last
  }
}

const looksLikeJson = (s: string) => {
  try {
    JSON.parse(s.trim())
    return true
  } catch {
    return /[[{][\s\S]*[\]}]/.test(s)
  }
}
