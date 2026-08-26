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
import { assertWithinBudget, estimateCostUsd, recordSpend } from './spend'
import { createAdminClient } from './supabase-admin'
import { resolveProviderId, MissingKeyError } from './providers'
import { callOpenRouter, DEFAULT_MODEL } from './providers/openrouter'
import { callLocalCli } from './providers/local-cli'
import { callLocalServer } from './providers/local-server'
import { isTransient } from '../util/retry'
import { acquireSpanScope, withSpan } from '../trace/spans'
import {
  EMBEDDING_MODEL,
  EMBEDDING_DIMS,
  testEmbedding,
  callOpenRouterEmbedding,
  callOpenAiDirectEmbedding,
  callLocalServerEmbedding,
  type EmbedBatchResult,
} from './providers/embeddings'

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
export { EMBEDDING_MODEL, EMBEDDING_DIMS, testEmbedding }

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
  const runProviderCall = () =>
    pRetry(
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

  // Span emission — lib/trace/spans.ts's header explains the AsyncLocalStorage
  // reuse. Every call that carries a userId gets an 'llm' span, metered or
  // not (this doubles as chokepoint-coverage insurance: a model call with no
  // userId at all is invisible to trace_spans the same way it's invisible to
  // the spend cap — see spend-chokepoints.test.ts for that half of the
  // guarantee). No userId at all means no user_id to satisfy trace_spans'
  // NOT NULL column, so there is nothing honest to record.
  const scope = apiKeys.userId ? acquireSpanScope(apiKeys.userId) : null
  let result: LlmResult
  if (scope) {
    try {
      result = await withSpan(
        scope.buffer,
        { parentSpanId: scope.parentSpanId, runId: scope.runId, kind: 'llm', name: 'llm' },
        () => runProviderCall(),
        (r, err) =>
          r
            ? {
                model: r.model,
                promptTokens: r.promptTokens,
                completionTokens: r.completionTokens,
                tokensUsed: r.tokensUsed,
                costUsd: estimateCostUsd(r.model, r.promptTokens, r.completionTokens),
                metered,
                userId: apiKeys.userId,
              }
            : {
                model: effectiveOpts.model ?? DEFAULT_MODEL,
                metered,
                userId: apiKeys.userId,
                error: err instanceof Error ? err.message : String(err),
              }
      )
    } finally {
      // Only the invocation that CREATED this buffer flushes it — a call
      // nested inside an ambient graph/unit context leaves flushing to
      // whichever of those created the buffer (see acquireSpanScope's doc).
      if (scope.owns) await scope.buffer.flush(admin ?? createAdminClient())
    }
  } else {
    result = await runProviderCall()
  }

  if (admin && apiKeys.userId) {
    await recordSpend(admin, apiKeys.userId, result.model, result.promptTokens, result.completionTokens)
  }

  return result
}

export interface EmbedResult {
  embeddings: number[][]
  model: string
  promptTokens: number
}

/**
 * Embed a batch of texts through the same spend chokepoint callLlm lives
 * behind — lives in THIS file deliberately (same reason as callLlm's own
 * header: scan roots and reviewer habits already cover lib/harness/llm.ts,
 * so a second chokepoint file would just be a second thing to remember to
 * scan). Unlike callLlm, this is a FALLBACK CHAIN, not a single provider
 * pick — OpenRouter, then OpenAI-direct, then a configured local server (see
 * ./providers/embeddings) — because text-embedding-3-small produces
 * identical vectors from OpenRouter and OpenAI-direct (ruling 10), so
 * falling through between them is free, and a local server only enters the
 * chain when the user has explicitly pointed one at an embedding model.
 *
 * Per attempt: `metered = provider === 'openrouter' && Boolean(apiKeys.userId)`
 * — the exact same expression callLlm uses — so only the OpenRouter leg is
 * checked against/recorded to the monthly cap; a self-supplied OpenAI key or
 * a local server costs Cello's own ledger nothing, mirroring why local-cli/
 * local-server are unmetered for chat.
 *
 * Throws MissingKeyError when no attempt was even possible (no key, no
 * local-server model configured) or when every attempted backend failed —
 * the last error is unwrapped and rethrown as-is so a caller can distinguish
 * BudgetCapError, ProviderUnavailableError, etc.
 */
export async function callEmbedding(
  apiKeys: DecryptedApiKeys,
  opts: { texts: string[]; model?: string },
  signal?: AbortSignal
): Promise<EmbedResult> {
  if (opts.texts.length === 0) return { embeddings: [], model: opts.model || EMBEDDING_MODEL, promptTokens: 0 }

  const attempts: Array<{ provider: 'openrouter' | 'openai-direct' | 'local-server'; run: () => Promise<EmbedBatchResult> }> = []
  if (apiKeys.openrouter) {
    attempts.push({
      provider: 'openrouter',
      run: () => callOpenRouterEmbedding(apiKeys, opts.texts, opts.model, signal),
    })
  }
  if (apiKeys.openai) {
    attempts.push({
      provider: 'openai-direct',
      run: () => callOpenAiDirectEmbedding(apiKeys, opts.texts, opts.model, signal),
    })
  }
  if (apiKeys.provider?.localServerEmbeddingModel) {
    attempts.push({ provider: 'local-server', run: () => callLocalServerEmbedding(apiKeys, opts.texts, signal) })
  }

  if (attempts.length === 0) {
    throw new MissingKeyError(
      'No embedding provider configured — set an OpenRouter or OpenAI key, or a local-server embedding model.'
    )
  }

  let lastErr: unknown
  for (const attempt of attempts) {
    const metered = attempt.provider === 'openrouter' && Boolean(apiKeys.userId)
    const admin = metered ? createAdminClient() : null

    let result: EmbedBatchResult
    try {
      if (admin && apiKeys.userId) {
        // Refuse BEFORE spending, same reason as callLlm: a request already
        // made cannot be refunded. Inside the try (unlike callLlm, which has
        // only one backend to fail over to): a BudgetCapError on this leg is
        // still worth falling through on — a self-supplied OpenAI key or a
        // local server costs Cello's own ledger nothing, so an unrelated
        // OpenRouter cap must not block them.
        await assertWithinBudget(admin, apiKeys.userId)
      }
      result = await attempt.run()
    } catch (err) {
      lastErr = err
      continue
    }

    if (admin && apiKeys.userId) {
      await recordSpend(admin, apiKeys.userId, EMBEDDING_MODEL, result.promptTokens, 0)
    }
    return result
  }

  throw lastErr instanceof Error ? lastErr : new MissingKeyError('No embedding provider reachable')
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
