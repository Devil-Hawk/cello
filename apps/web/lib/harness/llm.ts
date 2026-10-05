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
import type { AdminClient, DecryptedApiKeys, LlmResult, LlmRunOptions } from './types'
import {
  BudgetCapError,
  DEFAULT_MAX_TOKENS,
  estimateCostDetails,
  estimateCostUsd,
  estimatePromptTokens,
  hasListedPrice,
  reserveSpend,
  settleSpend,
  type SpendReservation,
  rungFor,
} from './spend'
import { createAdminClient } from './supabase-admin'
import { resolveProviderId, resolveLocalCliId, MissingKeyError } from './providers'
import { callOpenRouter, DEFAULT_MODEL } from './providers/openrouter'
import { callLocalCli } from './providers/local-cli'
import { callLocalServer } from './providers/local-server'
import { isTransient } from '../util/retry'
import { acquireSpanScope, currentTraceContext, withSpan, type LfPayload } from '../trace/spans'
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

/** The request as the model sees it (system, then messages or the prompt).
 *  Held in memory on the span record for the Langfuse export only: flush()
 *  strips it before the Postgres insert, and langfuse.ts redacts and caps it
 *  before it leaves the process. Built only when content capture is on. */
function requestMessages(opts: LlmRunOptions): { role: string; content: string }[] {
  const input: { role: string; content: string }[] = []
  if (opts.system) input.push({ role: 'system', content: opts.system })
  if (opts.messages && opts.messages.length > 0) input.push(...opts.messages.map((m) => ({ role: m.role, content: m.content })))
  else if (opts.prompt) input.push({ role: 'user', content: opts.prompt })
  return input
}

/** The model a call was aimed at, for a call that failed before any result
 *  named it (so errors can be grouped by model). DEFAULT_MODEL is only the
 *  OpenRouter default; the local backends name their own. */
/** A ledger client for a call that costs nothing. Without a service key (a
 *  self-hosted setup that never configured one) it is null and the call carries on
 *  unrecorded: bookkeeping never fails a free call. */
function tryAdminClient(): AdminClient | null {
  try {
    return createAdminClient()
  } catch {
    return null
  }
}

function requestedModel(opts: LlmRunOptions, apiKeys: DecryptedApiKeys, provider: string): string {
  if (provider === 'local-cli') return `local-cli/${resolveLocalCliId(apiKeys.provider?.localCli)}`
  if (provider === 'local-server') return opts.model || apiKeys.provider?.localServerModel || apiKeys.model || 'local-server'
  return opts.model || apiKeys.model || DEFAULT_MODEL
}

/** Exclusive buckets: cached prompt tokens and reasoning tokens are taken out of
 *  input and output, so Langfuse prices and sums each token once. */
function usageDetails(r: LlmResult): Record<string, number> {
  const cached = Math.min(r.cachedTokens ?? 0, r.promptTokens)
  const reasoning = Math.min(r.reasoningTokens ?? 0, r.completionTokens)
  return {
    input: r.promptTokens - cached,
    output: r.completionTokens - reasoning,
    total: r.tokensUsed,
    ...(cached > 0 ? { input_cached_tokens: cached } : {}),
    ...(reasoning > 0 ? { output_reasoning_tokens: reasoning } : {}),
  }
}

/** The Langfuse generation for one callLlm: model, parameters, usage, cost
 *  and (capture on) the prompt and the reply. Cost comes from OUR price
 *  table. Unmetered backends (local CLI, local server) get explicit zeros so
 *  Langfuse does not infer a price from its own model table. */
function generationPayload(
  opts: LlmRunOptions,
  apiKeys: DecryptedApiKeys,
  provider: string,
  metered: boolean,
  capture: boolean,
  result: LlmResult | undefined,
  attempt: number
): LfPayload {
  const modelParameters: Record<string, string | number> = {}
  if (opts.maxTokens !== undefined) modelParameters.max_tokens = opts.maxTokens
  if (opts.temperature !== undefined) modelParameters.temperature = opts.temperature
  if (opts.json !== undefined) modelParameters.json = opts.json ? 'true' : 'false'
  if (opts.reasoning) modelParameters.reasoning_effort = opts.reasoning.effort
  const lf: LfPayload = {
    name: opts.name ?? 'call-llm',
    type: 'generation',
    modelParameters,
    ...(opts.promptRef?.hash ? { version: opts.promptRef.hash } : {}),
    metadata: {
      provider,
      metered,
      // 1 is the first try; higher means the provider call was retried.
      attempt,
      // Local backends report char/4 estimates, not provider token counts.
      ...(provider !== 'openrouter' ? { usage_estimated: true } : {}),
      ...(opts.promptRef ? { prompt_name: opts.promptRef.name } : {}),
      ...(opts.promptRef?.hash ? { prompt_hash: opts.promptRef.hash } : {}),
    },
    ...(capture ? { input: requestMessages(opts) } : {}),
  }
  if (!result) return { ...lf, model: requestedModel(opts, apiKeys, provider) }
  return {
    ...lf,
    model: result.model,
    usage: usageDetails(result),
    cost: !metered
      ? { input: 0, output: 0 }
      : result.costUsd !== undefined
        ? { total: result.costUsd }
        : estimateCostDetails(result.model, result.promptTokens, result.completionTokens),
    metadata: {
      ...lf.metadata,
      ...(result.finishReason ? { finish_reason: result.finishReason } : {}),
      ...(metered && !hasListedPrice(result.model) ? { cost_estimated: true } : {}),
    },
    ...(result.finishReason === 'length' ? { level: 'WARNING' as const, errorCode: 'truncated' } : {}),
    ...(capture
      ? {
          output: {
            role: 'assistant',
            content: result.content,
            ...(result.reasoning ? { reasoning: result.reasoning } : {}),
          },
        }
      : {}),
  }
}

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
  const provider = resolveProviderId(apiKeys.provider?.active)

  // Only the metered path is capped in dollars. A local server costs nothing per
  // token, and a signed-in CLI bills a flat subscription, so charging them against
  // a dollar budget would be wrong, and would push users off the free options
  // exactly when they are trying to conserve credit. They still write a $0 ledger
  // row per attempt (see spend.ts), so the daily free count has something to read.
  const metered = provider === 'openrouter' && Boolean(apiKeys.userId)
  const admin = metered ? createAdminClient() : apiKeys.userId ? tryAdminClient() : null

  // Apply the user's default reasoning effort only when the call didn't
  // already ask for one: an explicit opts.reasoning (including {effort:
  // 'none'}) always wins over the account-wide default. A metered call always
  // carries a max_tokens, because its reservation is priced from it.
  const withReasoning: LlmRunOptions =
    opts.reasoning || !apiKeys.reasoningEffort || apiKeys.reasoningEffort === 'none'
      ? opts
      : { ...opts, reasoning: { effort: apiKeys.reasoningEffort } }
  const effectiveOpts: LlmRunOptions =
    metered && withReasoning.maxTokens === undefined ? { ...withReasoning, maxTokens: DEFAULT_MAX_TOKENS } : withReasoning

  // Span emission (lib/trace/spans.ts's header explains the AsyncLocalStorage
  // reuse) is acquired up front so a reservation can carry the trace id. Every
  // call that carries a userId gets an 'llm' span, metered or not (this doubles
  // as chokepoint-coverage insurance: see spend-chokepoints.test.ts). No userId
  // at all means no user_id to satisfy trace_spans' NOT NULL column, so there is
  // nothing honest to record.
  const scope = apiKeys.userId ? acquireSpanScope(apiKeys.userId, apiKeys.isDemo) : null

  // One provider attempt. Every attempt with a user reserves BEFORE the request and
  // settles AFTER it. A paid attempt reserves its worst case (a BudgetCapError means
  // the provider is never called) and settles the provider-reported cost; a free or
  // local attempt reserves and settles $0. Each retry is its own reservation, so a
  // retried-away attempt that failed with an HTTP status settles at zero.
  let attempt = 0
  const runAttempt = async (): Promise<LlmResult> => {
    attempt += 1
    const call = () =>
      provider === 'local-cli'
        ? callLocalCli(apiKeys, effectiveOpts, signal)
        : provider === 'local-server'
          ? callLocalServer(apiKeys, effectiveOpts, signal)
          : callOpenRouter(apiKeys, effectiveOpts, signal)
    if (!admin || !apiKeys.userId) return call()

    const messages = requestMessages(effectiveOpts)
    const model = requestedModel(effectiveOpts, apiKeys, provider)
    const reservation = await reserveSpend(admin, {
      userId: apiKeys.userId,
      model,
      promptTokens: estimatePromptTokens(messages.map((m) => m.content).join('\n'), messages.length),
      maxTokens: effectiveOpts.maxTokens ?? DEFAULT_MAX_TOKENS,
      rung: rungFor(provider, model),
      step: effectiveOpts.name ?? 'call-llm',
      door: effectiveOpts.door,
      traceId: scope?.buffer.traceId,
    })
    try {
      const out = await call()
      await settleSpend(admin, reservation, {
        model: out.model,
        promptTokens: out.promptTokens,
        completionTokens: out.completionTokens,
        costUsd: out.costUsd,
      })
      return out
    } catch (err) {
      await settleSpend(admin, reservation, { failed: err })
      throw err
    }
  }

  // A transient failure (429/500/502/503/504/529, a dropped connection, a
  // timeout) gets retried with backoff before it's allowed to fail the call.
  // A permanent failure (MissingKeyError, TruncatedResponseError, BudgetCapError,
  // a 400/401/402/403/404 from the provider) throws on the very first attempt;
  // see lib/util/retry's classifyError, plugged in below as p-retry's
  // `shouldRetry`. `signal` is passed through to p-retry itself (not just the
  // provider call) so a user cancel/deadline stops retrying immediately instead
  // of waiting out a queued backoff.
  const runProviderCall = () =>
    pRetry(runAttempt, {
      retries: 3,
      factor: 2,
      minTimeout: 400,
      maxTimeout: 8_000,
      randomize: true,
      signal,
      shouldRetry: ({ error }) => isTransient(error),
    })

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
                costUsd: r.costUsd ?? estimateCostUsd(r.model, r.promptTokens, r.completionTokens),
                metered,
                userId: apiKeys.userId,
              }
            : {
                model: requestedModel(effectiveOpts, apiKeys, provider),
                metered,
                userId: apiKeys.userId,
                error: err instanceof Error ? err.message : String(err),
              },
        (r, _err, capture) => generationPayload(effectiveOpts, apiKeys, provider, metered, capture, r, attempt)
      )
    } finally {
      // Only the invocation that CREATED this buffer flushes it — a call
      // nested inside an ambient graph/unit context leaves flushing to
      // whichever of those created the buffer (see acquireSpanScope's doc).
      // Without a service key (nothing to write spans with either) the call still
      // returns; only the trace is dropped.
      const flushClient = admin ?? tryAdminClient()
      if (scope.owns && flushClient) await scope.buffer.flush(flushClient)
    }
  } else {
    result = await runProviderCall()
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
  opts: { texts: string[]; model?: string; name?: string },
  signal?: AbortSignal
): Promise<EmbedResult> {
  if (opts.texts.length === 0) return { embeddings: [], model: opts.model || EMBEDDING_MODEL, promptTokens: 0 }

  // No provider at all is a normal configuration (a self-hosted user without an
  // embedding key), and every caller degrades. Refuse before any observation
  // opens, so it costs no Langfuse unit and never shows up as an error.
  if (!hasEmbeddingProvider(apiKeys)) throw new MissingKeyError(NO_EMBEDDING_PROVIDER)

  // Inside a retriever or memory write that folds embeddings, the usage and
  // cost go onto that parent's metadata and the call has no observation of its
  // own: a query embedding has only a count and a size to show.
  const fold = currentTraceContext()?.embed
  if (fold) {
    const out = await embedWithFallback(apiKeys, opts, signal)
    fold.calls += 1
    fold.tokens += out.result.promptTokens
    if (out.metered) fold.costUsd += estimateCostDetails(out.result.model, out.result.promptTokens, 0).input
    return out.result
  }

  // One Langfuse `embedding` observation per call (never a trace_spans row:
  // persist:false). Counts and sizes only: the texts are resumes, job
  // descriptions and notes, so they are never captured.
  const scope = apiKeys.userId ? acquireSpanScope(apiKeys.userId, apiKeys.isDemo) : null
  if (!scope) return (await embedWithFallback(apiKeys, opts, signal)).result
  try {
    const out = await withSpan(
      scope.buffer,
      { parentSpanId: scope.parentSpanId, runId: scope.runId, kind: 'llm', name: 'embedding', persist: false },
      () => embedWithFallback(apiKeys, opts, signal),
      undefined,
      (o, err) => {
        const model = o?.result.model ?? opts.model ?? EMBEDDING_MODEL
        const tokens = o?.result.promptTokens ?? 0
        // A monthly cap is an expected skip: the caller falls back, so it is
        // not an error. Real provider failures stay ERROR.
        const capped = err instanceof BudgetCapError
        return {
          name: opts.name ?? 'embed-texts',
          type: 'embedding',
          model,
          input: { count: opts.texts.length, chars: opts.texts.reduce((n, t) => n + t.length, 0) },
          ...(capped ? { expected: true } : {}),
          metadata: { provider: o?.provider ?? 'none', metered: o?.metered ?? false, ...(capped ? { skipped: 'budget_cap' } : {}) },
          ...(o ? { usage: { input: tokens }, cost: o.metered ? estimateCostDetails(model, tokens, 0) : { input: 0, output: 0 } } : {}),
        }
      }
    )
    return out.result
  } finally {
    if (scope.owns && scope.buffer.exportEnabled) await scope.buffer.flush(createAdminClient())
  }
}

const NO_EMBEDDING_PROVIDER =
  'No embedding provider configured — set an OpenRouter or OpenAI key, or a local-server embedding model.'

function hasEmbeddingProvider(apiKeys: DecryptedApiKeys): boolean {
  return Boolean(apiKeys.openrouter || apiKeys.openai || apiKeys.provider?.localServerEmbeddingModel)
}

/** True for the two expected reasons an embedding does not happen: no provider
 *  configured, or this month's cap reached. Callers fall back and carry on, so
 *  none of this is an error. */
export function isEmbeddingFallback(err: unknown): boolean {
  return err instanceof MissingKeyError || err instanceof BudgetCapError
}

/** The fallback chain itself, plus which backend answered and whether it was
 *  metered (for the Langfuse observation). */
async function embedWithFallback(
  apiKeys: DecryptedApiKeys,
  opts: { texts: string[]; model?: string; name?: string },
  signal?: AbortSignal
): Promise<{ result: EmbedBatchResult; provider: string; metered: boolean }> {
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

  if (attempts.length === 0) throw new MissingKeyError(NO_EMBEDDING_PROVIDER)

  let lastErr: unknown
  for (const attempt of attempts) {
    const metered = attempt.provider === 'openrouter' && Boolean(apiKeys.userId)
    // The OpenRouter leg is paid (R4) and the local-server leg is local (R2, $0).
    // OpenAI-direct is the person's own key and stays outside the ledger.
    const rung = attempt.provider === 'openrouter' ? 'R4' : attempt.provider === 'local-server' ? 'R2' : null
    const admin = !rung || !apiKeys.userId ? null : metered ? createAdminClient() : tryAdminClient()

    let result: EmbedBatchResult
    let reservation: SpendReservation | undefined
    try {
      if (admin && apiKeys.userId && rung) {
        // Reserve BEFORE spending, same reason as callLlm: a request already
        // made cannot be refunded. Inside the try (unlike callLlm, which has
        // only one backend to fail over to): a BudgetCapError on this leg is
        // still worth falling through on, since a self-supplied OpenAI key or a
        // local server costs Cello's own ledger nothing, so an unrelated
        // OpenRouter cap must not block them. Embeddings have no output tokens.
        reservation = await reserveSpend(admin, {
          userId: apiKeys.userId,
          model: attempt.provider === 'local-server' ? apiKeys.provider?.localServerEmbeddingModel || 'local-server' : opts.model || EMBEDDING_MODEL,
          promptTokens: estimatePromptTokens(opts.texts.join('\n'), opts.texts.length),
          maxTokens: 0,
          rung,
          step: opts.name ?? 'embed-texts',
        })
      }
      result = await attempt.run()
    } catch (err) {
      if (admin && reservation) await settleSpend(admin, reservation, { failed: err })
      lastErr = err
      continue
    }

    if (admin && reservation) {
      await settleSpend(admin, reservation, {
        model: EMBEDDING_MODEL,
        promptTokens: result.promptTokens,
        completionTokens: 0,
        costUsd: result.costUsd,
      })
    }
    return { result, provider: attempt.provider, metered }
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
