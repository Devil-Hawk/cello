// The chat-model factory (blueprint 11.1, 12): every chat call is built here, so
// the ceiling is checked in one place and no other file says `new Chat...(`.
//
//   openrouter    ChatOpenRouter
//   openai        ChatOpenAI on the person's own OpenAI key
//   local-server  ChatOpenAI pointed at an OpenAI-compatible server (Ollama, LM Studio)
//   anthropic     ChatAnthropic on the person's own Anthropic key
//
// completeOn runs one call on any of them and returns the LlmResult callLlm has
// always returned. callLlm keeps the reserve, settle, spans and retries; the
// provider files (openrouter.ts, local-server.ts) keep their signatures.

import { createHash } from 'node:crypto'
import { ChatAnthropic } from '@langchain/anthropic'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages'
import { ChatOpenAI } from '@langchain/openai'
import { ChatOpenRouter } from '@langchain/openrouter'
import { MissingKeyError, ProviderUnavailableError, TruncatedResponseError, estimateTokens } from '../harness/providers'
import { DEFAULT_MAX_TOKENS, actualCostUsd } from '../harness/spend'
import { ANTHROPIC_THINKING_BUDGET, type DecryptedApiKeys, type LlmResult, type LlmRunOptions, type ReasoningEffort } from '../harness/types'
import type { RungVia } from './doors.types'
import { isFreeModel } from './free'
import { directModel } from './ladder'

/** A paid model asked for under a ceiling below R4. Nothing was reserved or sent. */
export class CeilingError extends Error {
  constructor() {
    super('Your highest setting does not allow paid models.')
    this.name = 'CeilingError'
  }
}

/** Both model doors refuse a paid model id unless the ceiling is R4 (11.1). A person
 *  with no ceiling on their keys (a script, an operator key) is not limited here. */
export function assertCeiling(keys: DecryptedApiKeys, via: RungVia | 'local-cli', model: string): void {
  if (!keys.models || keys.models.ceiling === 'R4') return
  if (via === 'local-server' || via === 'local-cli' || isFreeModel(model)) return
  throw new CeilingError()
}

/** Stable, non-reversible tag for OpenRouter's `user` field, so the owner can
 *  tell users apart in OpenRouter's activity view without a raw id or email
 *  ever leaving Cello. Domain-separated SHA-256; a Cello user id is a random
 *  UUID, so there is nothing to brute-force from the tag alone. */
export function openRouterUserTag(userId: string): string {
  return `cello_${createHash('sha256').update(`cello:openrouter-user:${userId}`).digest('hex').slice(0, 32)}`
}

/** The model ids a local server or CLI is asked for are the person's own; nothing to check. */
const LOCAL_PLACEHOLDER_KEY = 'local-server-no-key-required'

const normalizeBaseUrl = (url: string) => url.trim().replace(/\/+$/, '')

/** The Claude models that think adaptively (the client's own list). */
const ADAPTIVE_ONLY = /^claude-(opus-4-[78]|opus-5|sonnet-5|fable-5|mythos)/

const OPENAI_REASONING = /^(gpt-5|o\d)/

/** OpenAI takes up to xhigh; Cello's "max" is the same ask. */
const openAiEffort = (e: ReasoningEffort) => (e === 'max' ? 'xhigh' : e)

export function chatModelFor(via: RungVia, model: string, keys: DecryptedApiKeys, opts: LlmRunOptions = {}): BaseChatModel {
  assertCeiling(keys, via, model)
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS
  const temperature = opts.temperature ?? 0.4
  const effort = opts.reasoning && opts.reasoning.effort !== 'none' ? opts.reasoning.effort : undefined
  // Retries belong to callLlm (p-retry, one reservation per attempt), not to the client.
  const common = { model, maxTokens, maxRetries: 0 }

  if (via === 'openrouter') {
    if (!keys.openrouter) throw new MissingKeyError('No OpenRouter API key configured')
    // Anthropic models want a thinking-token budget, everyone else the effort verbatim.
    const reasoning = effort
      ? model.startsWith('anthropic/')
        ? { max_tokens: Math.min(ANTHROPIC_THINKING_BUDGET[effort], Math.max(1024, maxTokens - 1)) }
        : { effort }
      : undefined
    return new ChatOpenRouter({
      ...common,
      temperature,
      apiKey: keys.openrouter,
      siteUrl: 'https://cello.app',
      siteName: 'Cello - Job Search Assistant',
      ...(keys.userId ? { user: openRouterUserTag(keys.userId) } : {}),
      ...(reasoning ? { modelKwargs: { reasoning } } : {}),
    })
  }
  if (via === 'openai') {
    if (!keys.openai) throw new MissingKeyError('No OpenAI API key configured')
    // OpenAI's reasoning models (gpt-5, o-series) refuse a temperature of their own choosing.
    return new ChatOpenAI({ ...common, ...(OPENAI_REASONING.test(model) ? {} : { temperature }), apiKey: keys.openai, ...(effort ? { reasoning: { effort: openAiEffort(effort) } } : {}) })
  }
  if (via === 'local-server') {
    const baseUrl = keys.provider?.localServerBaseUrl?.trim()
    if (!baseUrl) throw new ProviderUnavailableError('No local server URL configured: set one (for example http://localhost:11434/v1 for Ollama) in Settings.')
    // The chat completions endpoint, which is what every local server speaks.
    return new ChatOpenAI({ ...common, temperature, apiKey: LOCAL_PLACEHOLDER_KEY, useResponsesApi: false, configuration: { baseURL: normalizeBaseUrl(baseUrl) } })
  }
  if (via === 'anthropic') {
    if (!keys.anthropic) throw new MissingKeyError('No Anthropic API key configured')
    // The newest Claude models think adaptively and take an effort level, no temperature and no thinking
    // budget (the client refuses them); older ones take a budget of at least 1024, and no temperature while thinking.
    if (ADAPTIVE_ONLY.test(model)) {
      return new ChatAnthropic({ ...common, apiKey: keys.anthropic, ...(effort ? { outputConfig: { effort: effort === 'minimal' ? 'low' : effort } } : {}) })
    }
    const budget = effort ? Math.min(ANTHROPIC_THINKING_BUDGET[effort], maxTokens - 1) : 0
    return budget >= 1024
      ? new ChatAnthropic({ ...common, apiKey: keys.anthropic, thinking: { type: 'enabled', budget_tokens: budget } })
      : new ChatAnthropic({ ...common, temperature, apiKey: keys.anthropic })
  }
  throw new ProviderUnavailableError(`A ${via} model cannot answer a chat call from here.`)
}

function toMessages(opts: LlmRunOptions, via: RungVia): BaseMessage[] {
  const out: BaseMessage[] = []
  if (opts.system) {
    // An explicit cache breakpoint on the system block; providers that cache implicitly ignore it.
    out.push(
      opts.cachePrefix && (via === 'openrouter' || via === 'anthropic')
        ? new SystemMessage({ content: [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }] })
        : new SystemMessage(opts.system)
    )
  }
  if (opts.messages && opts.messages.length > 0) {
    for (const m of opts.messages) out.push(m.role === 'system' ? new SystemMessage(m.content) : m.role === 'assistant' ? new AIMessage(m.content) : new HumanMessage(m.content))
  } else if (opts.prompt) {
    out.push(new HumanMessage(opts.prompt))
  }
  if (opts.files?.length) {
    // The files ride on the last user message. Anthropic takes LangChain's standard file block;
    // OpenAI and OpenRouter take OpenAI's own.
    const last = out.findLastIndex((m) => m instanceof HumanMessage)
    const text = last >= 0 ? String(out[last].content) : ''
    const blocks = opts.files.map((f, i) =>
      via === 'anthropic'
        ? { type: 'file', mimeType: f.mimeType, data: f.data }
        : { type: 'file', file: { filename: `attachment-${i + 1}.${f.mimeType.split('/')[1] ?? 'bin'}`, file_data: `data:${f.mimeType};base64,${f.data}` } }
    )
    const withFiles = new HumanMessage({ content: [{ type: 'text', text }, ...blocks] as never })
    if (last >= 0) out[last] = withFiles
    else out.push(withFiles)
  }
  return out
}

/** One non-streaming call on `chat`, in the shape callLlm returns. */
export async function completeOn(chat: BaseChatModel, model: string, via: RungVia, opts: LlmRunOptions, signal?: AbortSignal): Promise<LlmResult> {
  const messages = toMessages(opts, via)
  // A strict schema goes to OpenRouter as response_format json_schema plus the response-healing plugin (it heals
  // malformed JSON server-side; deliberately not provider.require_parameters, which would route away from the
  // person's chosen model). Anywhere else a schema falls back to a JSON object; callers validate the result.
  const jsonMode =
    opts.jsonSchema && via === 'openrouter'
      ? {
          response_format: { type: 'json_schema', json_schema: { name: opts.jsonSchema.name, strict: true, schema: opts.jsonSchema.schema } },
          plugins: [{ id: 'response-healing' }],
        }
      : opts.json && via !== 'anthropic'
        ? { response_format: { type: 'json_object' } }
        : {}
  const result = await chat.generate([messages], { signal, ...jsonMode } as never)
  const generation = result.generations[0][0] as { text: string; message: AIMessage }
  const { message } = generation
  const meta = (message.response_metadata ?? {}) as Record<string, unknown>

  const content = generation.text
  const usage = message.usage_metadata
  const promptTokens = usage?.input_tokens ?? estimateTokens(messages.map((m) => String(m.content)).join('\n'))
  const completionTokens = usage?.output_tokens ?? estimateTokens(content)
  const stop = (meta.finish_reason ?? meta.stop_reason) as string | undefined
  const finishReason = stop === 'max_tokens' ? 'length' : stop

  // Truncated JSON is unrecoverable, so fail loudly here rather than letting the
  // caller's parse report a generic "not valid JSON".
  if (opts.json && finishReason === 'length') throw new TruncatedResponseError(completionTokens, opts.maxTokens ?? DEFAULT_MAX_TOKENS)

  const blocks = (Array.isArray(message.content) ? message.content : []) as { type?: string; thinking?: string }[]
  const thinking = blocks.filter((b) => b.type === 'thinking').map((b) => b.thinking ?? '').join('\n')
  const reasoning = (message.additional_kwargs?.reasoning_content as string | undefined) || thinking || undefined
  const cached = usage?.input_token_details?.cache_read
  const reasoned = usage?.output_token_details?.reasoning

  return {
    content,
    tokensUsed: usage?.total_tokens ?? promptTokens + completionTokens,
    promptTokens,
    completionTokens,
    model,
    finishReason,
    reasoning: reasoning?.trim() ? reasoning : undefined,
    // What OpenRouter says the call cost (usage.cost), so the ledger settles the real figure.
    costUsd: via === 'openrouter' ? actualCostUsd(meta.usage) : undefined,
    ...(cached && cached > 0 ? { cachedTokens: cached } : {}),
    ...(reasoned && reasoned > 0 ? { reasoningTokens: reasoned } : {}),
  }
}

/** A call on the person's own OpenAI or Anthropic key. Metered like OpenRouter, and always rung R4. */
export async function callDirect(via: 'openai' | 'anthropic', keys: DecryptedApiKeys, opts: LlmRunOptions, signal?: AbortSignal): Promise<LlmResult> {
  const model = directModel(via, opts.model || keys.model)
  const result = await completeOn(chatModelFor(via, model, keys, opts), model, via, opts, signal)
  // Named the way the price table and the ledger know it (OpenRouter's ids carry the vendor).
  return { ...result, model: `${via}/${model}` }
}
