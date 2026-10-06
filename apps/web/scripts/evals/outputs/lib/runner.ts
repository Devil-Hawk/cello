// An LlmRunner (the function type every agent takes) backed by a free model, so
// the evals drive the real agent code with only the transport swapped.

import type { LlmRunner, LlmRunOptions } from '@/lib/harness/types'
import { TruncatedResponseError } from '@/lib/harness/providers'
import { chat } from './free-model'

export function freeRunner(model: string, log?: { calls: number; tokens: number }): LlmRunner {
  return async (opts: LlmRunOptions) => {
    const maxTokens = opts.maxTokens ?? 1500
    const res = await chat({
      model,
      system: opts.system,
      prompt: opts.prompt,
      messages: opts.messages,
      json: opts.json,
      // Free reasoning models spend part of the cap thinking, so give the same headroom a paid call gets.
      maxTokens: Math.max(maxTokens, 1200) + (opts.reasoning && opts.reasoning.effort !== 'none' ? 1500 : 0),
      temperature: opts.temperature ?? 0.4,
    })
    if (log) {
      log.calls++
      log.tokens += res.tokensUsed
    }
    if (res.finishReason === 'length') throw new TruncatedResponseError(res.tokensUsed, maxTokens)
    return {
      content: res.content,
      tokensUsed: res.tokensUsed,
      promptTokens: 0,
      completionTokens: res.tokensUsed,
      model,
      finishReason: res.finishReason,
    }
  }
}
