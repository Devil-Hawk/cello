// Local server provider — any OpenAI-compatible endpoint on the user's own
// network: Ollama (http://localhost:11434/v1), LM Studio, vLLM, etc. No
// vendor key required; the base URL and model id are both user-supplied.
//
// ONLY WORKS SELF-HOSTED in practice: Vercel serverless functions cannot
// reach a `localhost` address on the user's machine, so this backend is
// gated by isSelfHosted() exactly like local-cli, even though nothing here
// technically *requires* a spawned process.

import OpenAI from 'openai'
import type {
  ChatCompletionMessageParam,
  ChatCompletionCreateParamsNonStreaming,
} from 'openai/resources/chat/completions'
import type { DecryptedApiKeys, LlmResult, LlmRunOptions } from '../types'
import { ProviderUnavailableError, TruncatedResponseError, estimateTokens, isSelfHosted } from './index'

/** Timeout for the lightweight reachability probe used by the settings route. */
const PROBE_TIMEOUT_MS = 2_500

/** Strip a trailing slash so `${baseUrl}/models` never doubles up. */
function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

export interface LocalServerAvailability {
  available: boolean
  reason?: string
  /** Model ids the server reported, when reachable and it supports GET /models. */
  models?: string[]
}

/**
 * Probe an OpenAI-compatible server's `/models` endpoint. Used by
 * GET /api/settings/providers to report live reachability — never called
 * from the hot call path itself (callLocalServer just makes the real
 * chat-completions request and lets it fail with its own clear error).
 */
export async function detectLocalServer(baseUrl: string): Promise<LocalServerAvailability> {
  const trimmed = baseUrl.trim()
  if (!trimmed) return { available: false, reason: 'No local server URL configured.' }
  if (!isSelfHosted()) {
    return {
      available: false,
      reason: 'Requires self-hosting — this Cello instance is running on Vercel serverless, which cannot reach a local network address.',
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(`${normalizeBaseUrl(trimmed)}/models`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) {
      return { available: false, reason: `Server responded ${res.status} ${res.statusText}.` }
    }
    const body = (await res.json().catch(() => null)) as { data?: Array<{ id?: string }> } | null
    const models = Array.isArray(body?.data)
      ? body!.data.map((m) => m.id).filter((id): id is string => typeof id === 'string')
      : undefined
    return { available: true, models }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { available: false, reason: `Not reachable: ${message}` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Call an OpenAI-compatible local server's chat-completions endpoint. No key
 * is required — a placeholder is sent because the OpenAI SDK insists on a
 * non-empty apiKey string, but local servers generally never check it.
 *
 * Honors AbortSignal and opts.maxTokens (both map directly onto the
 * OpenAI-compatible request). Does NOT honor opts.reasoning or
 * opts.cachePrefix — no standard covers either across arbitrary local
 * servers — see PROVIDER_CAPABILITIES['local-server'] in ./index.
 */
export async function callLocalServer(
  apiKeys: DecryptedApiKeys,
  opts: LlmRunOptions,
  signal?: AbortSignal
): Promise<LlmResult> {
  if (!isSelfHosted()) {
    throw new ProviderUnavailableError(
      'Local server providers only work when Cello is self-hosted (they call an address on your own ' +
        'network) — this instance is running on Vercel serverless. Switch to OpenRouter in Settings → Model.'
    )
  }

  const baseUrl = apiKeys.provider?.localServerBaseUrl?.trim()
  if (!baseUrl) {
    throw new ProviderUnavailableError(
      'No local server URL configured — set one (e.g. http://localhost:11434/v1 for Ollama) in Settings → Model.'
    )
  }

  const model = opts.model || apiKeys.provider?.localServerModel || apiKeys.model
  if (!model) {
    throw new ProviderUnavailableError(
      'No model id configured for the local server — set one in Settings → Model (the exact id your server expects, e.g. "llama3.1" for Ollama).'
    )
  }

  const client = new OpenAI({
    apiKey: 'local-server-no-key-required',
    baseURL: normalizeBaseUrl(baseUrl),
  })

  const messages: ChatCompletionMessageParam[] = []
  if (opts.system) messages.push({ role: 'system', content: opts.system })
  if (opts.messages && opts.messages.length > 0) {
    for (const m of opts.messages) messages.push({ role: m.role, content: m.content })
  } else if (opts.prompt) {
    messages.push({ role: 'user', content: opts.prompt })
  }

  const maxTokens = opts.maxTokens ?? 2048
  const body: ChatCompletionCreateParamsNonStreaming = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature: opts.temperature ?? 0.4,
    ...(opts.json ? { response_format: { type: 'json_object' as const } } : {}),
  }

  const response = await client.chat.completions.create(body, { signal }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    throw new ProviderUnavailableError(`Local server at ${baseUrl} did not respond: ${message}`)
  })

  const choice = response.choices[0]
  const content = choice?.message?.content ?? ''
  const finishReason = choice?.finish_reason ?? undefined
  const usage = response.usage
  const promptTokens = usage?.prompt_tokens ?? estimateTokens(messages.map((m) => String(m.content)).join('\n'))
  const completionTokens = usage?.completion_tokens ?? estimateTokens(content)
  const tokensUsed = usage?.total_tokens ?? promptTokens + completionTokens

  // Same cap semantics as OpenRouter: a JSON response cut off at max_tokens
  // is unrecoverable, so fail loudly instead of handing the caller
  // unparseable JSON to puzzle over.
  if (opts.json && finishReason === 'length') {
    throw new TruncatedResponseError(completionTokens, maxTokens)
  }

  return { content, tokensUsed, promptTokens, completionTokens, model, finishReason }
}
