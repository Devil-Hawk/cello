// OpenRouter provider — pay-per-token chat completions via the OpenAI SDK
// pointed at OpenRouter's base URL.
//
// This is Cello's original (and still default) LLM backend. Its behavior
// here is BYTE-IDENTICAL to what lib/harness/llm.ts used to do directly —
// this file is a pure extraction behind the ProviderCall contract in ./index
// so llm.ts can pick between backends without any existing caller noticing.

import OpenAI from 'openai'
import type {
  ChatCompletionMessageParam,
  ChatCompletionCreateParamsNonStreaming,
} from 'openai/resources/chat/completions'
import type { DecryptedApiKeys, LlmResult, LlmRunOptions } from '../types'
import { ANTHROPIC_THINKING_BUDGET } from '../types'
import { MissingKeyError, TruncatedResponseError, estimateTokens } from './index'

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-5'

const HEADERS = {
  'HTTP-Referer': 'https://cello.app',
  'X-Title': 'Cello - Job Search Assistant',
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

  const maxTokens = opts.maxTokens ?? 2048
  const body: ChatCompletionCreateParamsNonStreaming = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature: opts.temperature ?? 0.4,
    ...(opts.json ? { response_format: { type: 'json_object' as const } } : {}),
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

  return { content, tokensUsed, promptTokens, completionTokens, model, finishReason, reasoning: reasoningText }
}
