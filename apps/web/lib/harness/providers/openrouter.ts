// OpenRouter provider — pay-per-token chat completions via the OpenAI SDK
// pointed at OpenRouter's base URL.
//
// This is Cello's original (and still default) LLM backend. Its behavior
// here is BYTE-IDENTICAL to what lib/harness/llm.ts used to do directly —
// this file is a pure extraction behind the ProviderCall contract in ./index
// so llm.ts can pick between backends without any existing caller noticing.

import { createHash } from 'node:crypto'
import OpenAI from 'openai'
import type {
  ChatCompletionMessageParam,
  ChatCompletionCreateParamsNonStreaming,
} from 'openai/resources/chat/completions'
import type { DecryptedApiKeys, LlmResult, LlmRunOptions } from '../types'
import { ANTHROPIC_THINKING_BUDGET } from '../types'
import { MissingKeyError, TruncatedResponseError, estimateTokens, tokenBuckets } from './index'
import { actualCostUsd, DEFAULT_MAX_TOKENS } from '../spend'

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-5'

const HEADERS = {
  'HTTP-Referer': 'https://cello.app',
  'X-Title': 'Cello - Job Search Assistant',
}

/** Stable, non-reversible tag for OpenRouter's `user` field, so the owner can
 *  tell users apart in OpenRouter's activity view without a raw id or email
 *  ever leaving Cello. Domain-separated SHA-256; a Cello user id is a random
 *  UUID, so there is nothing to brute-force from the tag alone. */
export function openRouterUserTag(userId: string): string {
  return `cello_${createHash('sha256').update(`cello:openrouter-user:${userId}`).digest('hex').slice(0, 32)}`
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
  const key = apiKeys.openrouter
  if (!key) throw new MissingKeyError('No OpenRouter API key configured')

  const model = opts.model || apiKeys.model || DEFAULT_MODEL
  const client = new OpenAI({
    apiKey: key,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: HEADERS,
  })

  const messages: ChatCompletionMessageParam[] = []
  if (opts.system) {
    if (opts.cachePrefix) {
      // Anthropic requires an explicit breakpoint on a content block; the
      // OpenAI SDK's types don't model cache_control, hence the cast. Other
      // providers ignore the field and cache implicitly.
      messages.push({
        role: 'system',
        content: [
          { type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } },
        ],
      } as unknown as ChatCompletionMessageParam)
    } else {
      messages.push({ role: 'system', content: opts.system })
    }
  }
  if (opts.messages && opts.messages.length > 0) {
    for (const m of opts.messages) messages.push({ role: m.role, content: m.content })
  } else if (opts.prompt) {
    messages.push({ role: 'user', content: opts.prompt })
  }

  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS
  const body: ChatCompletionCreateParamsNonStreaming = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature: opts.temperature ?? 0.4,
    // `user` is deprecated in the OpenAI SDK types but is the field OpenRouter
    // documents for end-user attribution.
    ...(apiKeys.userId ? { user: openRouterUserTag(apiKeys.userId) } : {}),
    ...(opts.jsonSchema
      ? {
          response_format: {
            type: 'json_schema' as const,
            json_schema: { name: opts.jsonSchema.name, strict: true, schema: opts.jsonSchema.schema },
          },
        }
      : opts.json
        ? { response_format: { type: 'json_object' as const } }
        : {}),
  }
  // Heals malformed JSON server-side. Deliberately NOT provider.require_parameters,
  // which would route away from (or fail on) the user's chosen model: Zod catches
  // whatever a non-strict provider gets wrong.
  if (opts.jsonSchema) {
    ;(body as unknown as Record<string, unknown>).plugins = [{ id: 'response-healing' }]
  }
  // OpenRouter's `reasoning` field isn't in the OpenAI SDK's types. Attach it
  // after construction so the non-streaming overload still resolves.
  //
  // Anthropic models don't accept an effort string — they want an explicit
  // thinking-token budget — so the ladder is translated for them. Everyone
  // else takes the effort verbatim (Gemini quietly caps it at 'high').
  if (opts.reasoning && opts.reasoning.effort !== 'none') {
    const effort = opts.reasoning.effort
    const reasoning = model.startsWith('anthropic/')
      ? { max_tokens: Math.min(ANTHROPIC_THINKING_BUDGET[effort], Math.max(1024, maxTokens - 1)) }
      : { effort }
    ;(body as unknown as Record<string, unknown>).reasoning = reasoning
  }

  const response = await client.chat.completions.create(body, { signal })

  const choice = response.choices[0]
  const content = choice?.message?.content ?? ''
  const finishReason = choice?.finish_reason ?? undefined
  // OpenRouter returns the reasoning trace on the message; it isn't in the
  // OpenAI SDK's types, so read it defensively.
  const reasoning =
    (choice?.message as unknown as { reasoning?: unknown } | undefined)?.reasoning
  const reasoningText = typeof reasoning === 'string' && reasoning.trim() ? reasoning : undefined
  const usage = response.usage
  const promptTokens = usage?.prompt_tokens ?? estimateTokens(messages.map((m) => String(m.content)).join('\n'))
  const completionTokens = usage?.completion_tokens ?? estimateTokens(content)
  const tokensUsed = usage?.total_tokens ?? promptTokens + completionTokens

  // Truncated JSON is unrecoverable, so fail loudly here rather than letting
  // the caller's parse report a generic "not valid JSON".
  if (opts.json && finishReason === 'length') {
    throw new TruncatedResponseError(completionTokens, maxTokens)
  }

  return {
    content,
    tokensUsed,
    promptTokens,
    completionTokens,
    model,
    finishReason,
    reasoning: reasoningText,
    // What OpenRouter says the call cost (usage.cost), so the ledger settles the real figure.
    costUsd: actualCostUsd(usage),
    ...tokenBuckets(usage),
  }
}
