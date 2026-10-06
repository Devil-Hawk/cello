// Local server provider — any OpenAI-compatible endpoint on the user's own
// network: Ollama (http://localhost:11434/v1), LM Studio, vLLM, etc. No
// vendor key required; the base URL and model id are both user-supplied.
//
// ONLY WORKS SELF-HOSTED in practice: Vercel serverless functions cannot
// reach a `localhost` address on the user's machine, so this backend is
// gated by isSelfHosted() exactly like local-cli, even though nothing here
// technically *requires* a spawned process.

import type { DecryptedApiKeys, LlmResult, LlmRunOptions } from '../types'
import { chatModelFor, completeOn } from '../../models/factory'
import { ProviderUnavailableError, TruncatedResponseError, isSelfHosted } from './index'

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
 * Call an OpenAI-compatible local server's chat-completions endpoint through the
 * factory (ChatOpenAI pointed at the server). No key is required: a placeholder
 * is sent because the client insists on a non-empty apiKey string, but local
 * servers generally never check it.
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

  try {
    return await completeOn(chatModelFor('local-server', model, apiKeys, opts), model, 'local-server', opts, signal)
  } catch (err) {
    // A JSON reply cut off at max_tokens is the model's answer, not an unreachable server.
    if (err instanceof TruncatedResponseError) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new ProviderUnavailableError(`Local server at ${baseUrl} did not respond: ${message}`)
  }
}
