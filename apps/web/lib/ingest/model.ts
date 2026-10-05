// The one place ingestion talks to a model.
//
// Ingestion only ever uses OpenRouter's free models (ids ending in ":free"),
// with the platform's own key, on behalf of the user whose company is being
// read. It goes through callLlm so the call is budget-checked, spend-recorded
// (a free model books $0 but still counts as a metered call) and traced like
// every other model call in the app.
//
// The ceiling: free models are rate limited and sometimes unavailable. Callers
// treat a failure as "no model answer", never as a reason to guess, and a run
// caps how many model calls it makes (see MODEL_CALL_BUDGET).

import { callLlm } from '../harness/llm'
import type { DecryptedApiKeys } from '../harness/types'
import { warnLlmFallback } from '../observability/llm-fallback'

/** Tried in order; the next one is used when the first errors or is rate limited. */
export const INGEST_MODELS = ['google/gemma-4-31b-it:free', 'qwen/qwen3.8-27b:free'] as const

/** Model calls one scheduled run may make in total, across all users and both uses. */
export const MODEL_CALL_BUDGET = 60

export interface ModelRequest {
  system: string
  prompt: string
  /** Langfuse generation name, a lowercase constant. */
  name: string
  maxTokens: number
  promptRef?: { name: string; hash?: string }
}

/** Returns the model's text, or null when no free model produced one. */
export type ModelCall = (req: ModelRequest) => Promise<string | null>

export function makeIngestModelCall(userId: string, key: string | undefined, models: readonly string[] = INGEST_MODELS): ModelCall {
  return async (req) => {
    if (!key) return null
    const apiKeys: DecryptedApiKeys = { openrouter: key, userId }
    for (const model of models) {
      if (!model.endsWith(':free')) throw new Error('ingestion only uses free models')
      try {
        const result = await callLlm(
          apiKeys,
          {
            model,
            system: req.system,
            prompt: req.prompt,
            maxTokens: req.maxTokens,
            temperature: 0,
            reasoning: { effort: 'none' },
            name: req.name,
            ...(req.promptRef ? { promptRef: req.promptRef } : {}),
          },
          AbortSignal.timeout(60_000)
        )
        if (result.content?.trim()) return result.content
      } catch (error) {
        warnLlmFallback(req.name, 'next-free-model', error)
      }
    }
    return null
  }
}
