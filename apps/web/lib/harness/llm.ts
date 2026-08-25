// Harness runtime — pluggable LLM call, one contract, three backends.
//
// callLlm's public signature and behavior are UNCHANGED for every existing
// caller: same (apiKeys, opts, signal?) => Promise<LlmResult>, same
// MissingKeyError / TruncatedResponseError classes (re-exported below so
// `import { MissingKeyError } from './llm'` keeps working everywhere it's
// written today), and — when apiKeys carries no provider preference, which
// is every account today — byte-identical OpenRouter behavior.
//
// What's new: apiKeys.provider (profiles.preferences.provider) picks which
// of three backends actually runs the call:
//   - openrouter    (default): today's pay-per-token API path. Works
//     everywhere Cello runs, including Vercel. See ./providers/openrouter.
//   - local-cli:    spawns the user's own subscription CLI (Claude Code /
//     Codex / Gemini), authenticated with their subscription account — no
//     API key. Only works self-hosted. See ./providers/local-cli.
//   - local-server: any OpenAI-compatible endpoint on the user's network
//     (Ollama, LM Studio, vLLM). No key required. Only works self-hosted.
//     See ./providers/local-server.
//
// apiKeys.reasoningEffort (profiles.preferences.reasoningEffort) is applied
// as the DEFAULT reasoning effort for any call that doesn't already set
// opts.reasoning — individual agent calls that explicitly ask for an effort
// (including 'none') always win. See lib/harness/providers/index.ts for the
// capability flags each backend honors; a backend that doesn't support
// reasoning/cachePrefix/a JSON guarantee/maxTokens just ignores the field
// rather than erroring — see each provider file's own docstring for exactly
// what it does and doesn't honor.

import pRetry from 'p-retry'
import type { DecryptedApiKeys, LlmResult, LlmRunOptions } from './types'
import { assertWithinBudget, recordSpend } from './spend'
import { createAdminClient } from './supabase-admin'
import { resolveProviderId } from './providers'
import { callOpenRouter, DEFAULT_MODEL } from './providers/openrouter'
import { callLocalCli } from './providers/local-cli'
import { callLocalServer } from './providers/local-server'
import { isTransient } from '../util/retry'

export {
  MissingKeyError,
  ProviderUnavailableError,
  TruncatedResponseError,
  PROVIDER_CAPABILITIES,
  PROVIDER_IDS,
  PROVIDER_LABELS,
  PROVIDER_DESCRIPTIONS,
  LOCAL_CLI_IDS,
  LOCAL_CLI_LABELS,
  isSelfHosted,
  resolveProviderId,
  resolveProviderPreferences,
} from './providers'
export { DEFAULT_MODEL }

/**
 * Call the user's configured LLM backend once and return the assistant
 * content plus token accounting. Throws MissingKeyError when nothing usable
 * is configured, or ProviderUnavailableError when something IS configured
 * but isn't reachable right now (CLI not installed, local server down, or a
 * self-hosted-only backend selected while running on Vercel).
 */
export async function callLlm(
  apiKeys: DecryptedApiKeys,
  opts: LlmRunOptions,
  signal?: AbortSignal
): Promise<LlmResult> {
  // Apply the user's default reasoning effort only when the call didn't
  // already ask for one — an explicit opts.reasoning (including {effort:
  // 'none'}) always wins over the account-wide default.
  const effectiveOpts: LlmRunOptions =
    opts.reasoning || !apiKeys.reasoningEffort || apiKeys.reasoningEffort === 'none'
      ? opts
      : { ...opts, reasoning: { effort: apiKeys.reasoningEffort } }

  const provider = resolveProviderId(apiKeys.provider?.active)

  // Only the metered path is capped. A local server costs nothing per token,
  // and a signed-in CLI bills a flat subscription, so charging them against a
  // dollar budget would be wrong — and would push users off the free options
  // exactly when they are trying to conserve credit.
  const metered = provider === 'openrouter' && Boolean(apiKeys.userId)
  const admin = metered ? createAdminClient() : null
  if (admin && apiKeys.userId) {
    // Refuse BEFORE spending: a request already made cannot be refunded.
    await assertWithinBudget(admin, apiKeys.userId)
  }

  // A transient failure (429/500/502/503/504/529, a dropped connection, a
  // timeout) gets retried with backoff before it's allowed to fail the call.
  // A permanent failure (MissingKeyError, TruncatedResponseError, a 400/401/
  // 402/403/404 from the provider) throws on the very first attempt — see
  // lib/util/retry's classifyError, plugged in below as p-retry's
  // `shouldRetry`. Each retry re-runs the full provider call, so spend is
  // only ever metered below on whichever attempt actually completes — a
  // retried-away attempt never reaches recordSpend. `signal` is passed
  // through to p-retry itself (not just the provider call) so a user
  // cancel/deadline stops retrying immediately instead of waiting out a
  // queued backoff.
  const result = await pRetry(
    () =>
      provider === 'local-cli'
        ? callLocalCli(apiKeys, effectiveOpts, signal)
        : provider === 'local-server'
          ? callLocalServer(apiKeys, effectiveOpts, signal)
          : callOpenRouter(apiKeys, effectiveOpts, signal),
    {
      retries: 3,
      factor: 2,
      minTimeout: 400,
      maxTimeout: 8_000,
      randomize: true,
      signal,
      shouldRetry: ({ error }) => isTransient(error),
    }
  )

  if (admin && apiKeys.userId) {
    await recordSpend(admin, apiKeys.userId, result.model, result.promptTokens, result.completionTokens)
  }

  return result
}

/** Best-effort JSON extraction from an LLM response (handles ```json fences). */
export function parseJsonLoose<T = unknown>(raw: string): T {
  const trimmed = raw.trim()
  try {
    return JSON.parse(trimmed) as T
  } catch {
    // Strip markdown fences / prose around the first JSON object or array.
    const match = trimmed.match(/[[{][\s\S]*[\]}]/)
    if (match) return JSON.parse(match[0]) as T
    throw new Error('LLM response was not valid JSON')
  }
}
