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
import { BudgetCapError } from '../harness/spend'
import type { DecryptedApiKeys } from '../harness/types'

/** Tried in order; the next one is used when the first errors or is rate limited. */
export const INGEST_MODELS = ['google/gemma-4-31b-it:free', 'qwen/qwen3.8-27b:free'] as const

/** Model calls one scheduled check may make for one user, page reading and requirements together. Free accounts get about 50 requests a day. */
export const DEFAULT_MODEL_CALLS = 40

/**
 * What is left to spend. Shared by everything one user's check does, so page
 * reading (which goes first) and requirements (which gets the rest) draw on the
 * same allowance. `hit` records that something was refused for want of it.
 */
export interface ModelBudget {
  n: number
  hit: boolean
  /** Calls that no free model answered (a rate limit, a model that is down). Counted, never logged: the Actions log is public. */
  failed: number
}

export function newModelBudget(n: number = DEFAULT_MODEL_CALLS): ModelBudget {
  return { n, hit: false, failed: 0 }
}

/** The answer when the allowance is spent or the user's own spend cap is reached: not "the model said nothing". */
export const MODEL_LIMIT: unique symbol = Symbol('model-limit')

export interface ModelRequest {
  system: string
  prompt: string
  /** Langfuse generation name, a lowercase constant. */
  name: string
  maxTokens: number
  promptRef?: { name: string; hash?: string }
}

/** The model's text; null when no free model produced one; MODEL_LIMIT when the allowance or the spend cap stopped the call. */
export type ModelCall = (req: ModelRequest) => Promise<string | null | typeof MODEL_LIMIT>

export function makeIngestModelCall(
  userId: string,
  key: string | undefined,
  opts: { budget?: ModelBudget; models?: readonly string[] } = {}
): ModelCall {
  const models = opts.models ?? INGEST_MODELS
  const budget = opts.budget
  return async (req) => {
    if (!key) return null
    if (budget) {
      if (budget.n <= 0) {
        budget.hit = true
        return MODEL_LIMIT
      }
      budget.n -= 1
    }
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
        if (error instanceof BudgetCapError) {
          // The user's own cap: nothing further this check, for anything.
          if (budget) {
            budget.n = 0
            budget.hit = true
          }
          return MODEL_LIMIT
        }
        // Next free model. The error text is not logged: this runs where the log is public.
      }
    }
    if (budget) budget.failed += 1
    return null
  }
}
