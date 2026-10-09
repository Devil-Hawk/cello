// One model completion that a person would accept: the chosen model first, then the other free ones, each asked
// again only when its answer fails the caller's own check (empty, thinking aloud, not the shape asked for).
// A reasoning model spends its tokens thinking and can return nothing at a small budget, so reasoning is off and the
// budget generous. Every attempt goes through callLlm, so it is reserved, settled and written to llm_spend.
//
// ponytail: three attempts, in order; a better order (fastest first) waits until the free list has timings.

import { callLlm } from '@/lib/harness/llm'
import type { DecryptedApiKeys, LlmRunOptions } from '@/lib/harness/types'
import { freeModels } from './free'

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
      errors.push(`${model}: ${text ? 'did not follow the instructions' : 'returned nothing'} (finish ${out.finishReason ?? '?'}, ${out.completionTokens} tokens, ${out.reasoningTokens ?? 0} reasoning)`)
    } catch (e) {
      if (signal?.aborted) throw e
      errors.push(`${model}: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`)
    }
  }
  return null
}
