// Free models only, for the agent evals.
//
// Everything the evals send to a model goes through this file, and it refuses any model id that
// does not end in ":free", so an eval can never spend money. It also holds what makes live evals
// workable on free models: a disk cache keyed by the whole request (a re-run costs nothing for
// cases whose prompt did not change), backoff with jitter on 429 and 5xx, and a hard cap on the
// number of real requests per process.
//
// The key is OPENROUTER_API_KEY from the environment or ~/.cello-secrets.env. It is read here and
// sent as a header, and never printed or logged.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import type { ChatResult } from '@langchain/core/outputs'
import { z } from 'zod'
import { celloChatModel } from '@/lib/agents/model'

export const GENERATORS = ['qwen/qwen3.8-27b:free', 'google/gemma-4-31b-it:free', 'nvidia/nemotron-3-super-120b-a12b:free'] as const
/** A different family from the generators it judges (qwen and gemma). */
export const JUDGE = 'nvidia/nemotron-3-super-120b-a12b:free'

export const OUT_DIR = process.env.AGENT_EVAL_OUT ?? path.join(os.homedir(), 'cello-scratch', 'evals', 'agent')
const CACHE_DIR = process.env.AGENT_EVAL_CACHE ?? path.join(OUT_DIR, '.cache')
const MAX_REQUESTS = Number(process.env.AGENT_EVAL_MAX_REQUESTS ?? 450)
const BACKOFF_MS = [2000, 4000, 8000, 16_000]

export const stats = { requests: 0, cacheHits: 0, retries: 0 }

export const RUN_LIVE = process.env.RUN_AGENT_EVALS === '1'

export function assertFree(model: string): void {
  if (!model.endsWith(':free')) throw new Error(`Eval refused: "${model}" is not a :free model.`)
}

let keyCache: string | undefined
/** The key, never printed. */
export function openRouterKey(): string {
  if (keyCache) return keyCache
  let key = process.env.OPENROUTER_API_KEY?.trim()
  if (!key) {
    const file = path.join(os.homedir(), '.cello-secrets.env')
    if (existsSync(file)) key = /^OPENROUTER_API_KEY=(.+)$/m.exec(readFileSync(file, 'utf8'))?.[1]?.trim().replace(/^["']|["']$/g, '')
  }
  if (!key) throw new Error('No OPENROUTER_API_KEY in the environment or ~/.cello-secrets.env.')
  keyCache = key
  return key
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const jitter = (ms: number) => ms + Math.floor(Math.random() * ms * 0.25)

function cachePath(key: string): string {
  return path.join(CACHE_DIR, `${key}.json`)
}

function readCache<T>(key: string): T | undefined {
  try {
    return JSON.parse(readFileSync(cachePath(key), 'utf8')) as T
  } catch {
    return undefined
  }
}

function writeCache(key: string, value: unknown): void {
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(cachePath(key), JSON.stringify(value))
}

export const hashOf = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 40)

/** Run `call` with backoff on a rate limit or a server error. Counts real requests against the cap. */
export async function withBackoff<T>(call: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    if (stats.requests >= MAX_REQUESTS) throw new Error(`Eval request cap reached (${MAX_REQUESTS}). Raise AGENT_EVAL_MAX_REQUESTS to go on.`)
    stats.requests += 1
    try {
      return await call()
    } catch (e) {
      lastError = e
      const text = `${(e as { status?: number })?.status ?? ''} ${e instanceof Error ? e.message : String(e)}`
      const retryable = /\b(429|500|502|503|504|529)\b|rate.?limit|timed? ?out|ECONNRESET|ETIMEDOUT|fetch failed|overloaded|provider returned error/i.test(text)
      if (!retryable || attempt === BACKOFF_MS.length) break
      stats.retries += 1
      await sleep(jitter(BACKOFF_MS[attempt]))
    }
  }
  throw lastError
}

// --- one completion, for judges and baselines ---------------------------------------

export interface CompleteInput {
  model: string
  system?: string
  user: string
  json?: boolean
  maxTokens?: number
  temperature?: number
}

export async function freeComplete(input: CompleteInput): Promise<string> {
  assertFree(input.model)
  const body = {
    model: input.model,
    messages: [...(input.system ? [{ role: 'system', content: input.system }] : []), { role: 'user', content: input.user }],
    max_tokens: input.maxTokens ?? 1024,
    temperature: input.temperature ?? 0,
    ...(input.json ? { response_format: { type: 'json_object' } } : {}),
  }
  const key = hashOf(body)
  const cached = readCache<{ text: string }>(key)
  if (cached) {
    stats.cacheHits += 1
    return cached.text
  }
  const text = await withBackoff(async () => {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openRouterKey()}`, 'Content-Type': 'application/json', 'X-Title': 'Cello evals' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
    const payload = (await res.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[]; error?: { message?: string; code?: number } } | null
    if (!res.ok || payload?.error) throw Object.assign(new Error(payload?.error?.message ?? `HTTP ${res.status}`), { status: res.status })
    const content = payload?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) throw Object.assign(new Error('empty completion, provider returned error'), { status: 502 })
    return content
  })
  writeCache(key, { text })
  return text
}

/** A JSON object out of a completion that may wrap it in text or a code fence. */
export function parseJson<T = unknown>(text: string): T | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1]
  for (const candidate of [text, fenced ?? '', text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
    try {
      return JSON.parse(candidate) as T
    } catch {
      // try the next shape
    }
  }
  return null
}

// --- a chat model for the real agent --------------------------------------------------

/** Thrown to end an agent run on purpose, after the calls an eval wanted. */
export class EvalStop extends Error {
  constructor() {
    super('eval stop')
    this.name = 'EvalStop'
  }
}

export interface RecordedCall {
  messages: BaseMessage[]
  toolNames: string[]
  response: AIMessage
}

const toolKey = (t: unknown): unknown => {
  const tool = t as { name?: string; description?: string; schema?: z.ZodType }
  let schema: unknown = null
  try {
    schema = tool.schema ? z.toJSONSchema(tool.schema as z.ZodType) : null
  } catch {
    schema = null
  }
  return { name: tool.name, description: tool.description, schema }
}

const messageKey = (m: BaseMessage) => ({ t: m.type, c: m.content, tc: (m as AIMessage).tool_calls ?? undefined, id: (m as { tool_call_id?: string }).tool_call_id })

/**
 * The real orchestrator or Researcher, with a free model behind it. Every model call is
 * recorded, cached and backed off. `stopAfterCalls` ends the run with EvalStop once that many
 * calls have been answered (1 reads only the first action).
 */
export class FreeChatModel extends BaseChatModel {
  model: string
  maxTokens: number
  calls: RecordedCall[] = []
  stopAfterCalls: number | undefined
  private tools: unknown[] = []
  private inner: ReturnType<typeof celloChatModel>

  constructor(opts: { model: string; maxTokens?: number; stopAfterCalls?: number }) {
    super({})
    assertFree(opts.model)
    this.model = opts.model
    this.maxTokens = opts.maxTokens ?? 2048
    this.stopAfterCalls = opts.stopAfterCalls
    this.inner = celloChatModel({ apiKeys: { openrouter: openRouterKey() }, model: opts.model, purpose: 'eval' })
  }

  _llmType(): string {
    return 'free-eval'
  }

  bindTools(tools: unknown[]): this {
    this.tools = tools
    return this
  }

  async _generate(messages: BaseMessage[], options: { signal?: AbortSignal }): Promise<ChatResult> {
    const toolNames = this.tools.map((t) => (t as { name?: string }).name ?? '')
    const key = hashOf({ model: this.model, messages: messages.map(messageKey), tools: this.tools.map(toolKey) })
    const cached = readCache<{ content: unknown; tool_calls: AIMessage['tool_calls']; usage_metadata?: AIMessage['usage_metadata'] }>(key)
    let response: AIMessage
    if (cached) {
      stats.cacheHits += 1
      response = new AIMessage({ content: cached.content as string, tool_calls: cached.tool_calls, usage_metadata: cached.usage_metadata })
    } else {
      const bound = this.tools.length ? this.inner.bindTools(this.tools as never) : this.inner
      const got = (await withBackoff(() => bound.invoke(messages, { signal: options.signal }))) as AIMessage
      response = new AIMessage({ content: got.content, tool_calls: got.tool_calls, usage_metadata: got.usage_metadata })
      writeCache(key, { content: response.content, tool_calls: response.tool_calls, usage_metadata: response.usage_metadata })
    }
    this.calls.push({ messages, toolNames, response })
    if (this.stopAfterCalls !== undefined && this.calls.length >= this.stopAfterCalls) throw new EvalStop()
    return { generations: [{ message: response, text: typeof response.content === 'string' ? response.content : '' }] }
  }
}

// --- running cases ----------------------------------------------------------------------

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i], i)
      }
    })
  )
  return out
}

/** Write a report: JSON with every case, and a markdown table. Returns the paths. */
export function writeReport(name: string, data: unknown, markdown: string): { json: string; md: string } {
  mkdirSync(OUT_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const json = path.join(OUT_DIR, `${name}-${stamp}.json`)
  const md = path.join(OUT_DIR, `${name}-${stamp}.md`)
  writeFileSync(json, JSON.stringify({ ...(data as object), requests: { ...stats } }, null, 2))
  writeFileSync(md, markdown)
  return { json, md }
}

export const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(0)}% (${n}/${d})`)
