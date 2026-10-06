// OpenRouter provider — pay-per-token chat completions through ChatOpenRouter,
// built by the model factory (lib/models/factory.ts).
//
// This is Cello's original (and still default) LLM backend. The request it makes
// is the one lib/harness/llm.ts always made: the system block (with a cache
// breakpoint when asked for), `user` as a hashed tag, reasoning translated per
// vendor, a JSON response format, and the provider-reported cost kept for the
// ledger. What changed is who builds the call, and the two errors below.

import type { DecryptedApiKeys, LlmResult, LlmRunOptions } from '../types'
import { MissingKeyError } from './index'
import { chatModelFor, completeOn, openRouterUserTag } from '../../models/factory'
import { FreeLimitReachedError, NegativeBalanceError, nextUtcMidnight } from '../../models/waiting'

export const DEFAULT_MODEL = 'anthropic/claude-sonnet-5'
export { openRouterUserTag }

/** OpenRouter's two limits that are not worth a retry become their own errors (blueprint 11.3):
 *  the daily free-model 429 and a negative balance (402, which blocks free models too). */
function mapOpenRouterError(error: unknown): unknown {
  const code = (error as { statusCode?: unknown } | null)?.statusCode
  if (typeof code !== 'number') return error
  if (code === 429 && /free-models-per-day/i.test((error as Error).message)) return new FreeLimitReachedError(nextUtcMidnight())
  if (code === 402) return new NegativeBalanceError()
  // The retry classifier and the spend ledger read `status`; OpenRouter's errors carry `statusCode`.
  return Object.assign(error as object, { status: code })
}

/**
 * Call OpenRouter once and return the assistant content plus token accounting.
 * Throws MissingKeyError when the user hasn't configured an OpenRouter key.
 */
export async function callOpenRouter(
  apiKeys: DecryptedApiKeys,
  opts: LlmRunOptions,
  signal?: AbortSignal
): Promise<LlmResult> {
  if (!apiKeys.openrouter) throw new MissingKeyError('No OpenRouter API key configured')
  const model = opts.model || apiKeys.model || DEFAULT_MODEL
  try {
    return await completeOn(chatModelFor('openrouter', model, apiKeys, opts), model, 'openrouter', opts, signal)
  } catch (error) {
    throw mapOpenRouterError(error)
  }
}
