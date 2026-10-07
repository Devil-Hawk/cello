// Free OpenRouter models for the quality evals, and nothing else.
//
// Refuses any model id that does not end in ":free". Answers are cached on disk
// by (model, messages, temperature, max tokens, sample), so a rerun costs no
// request and an interrupted run resumes. Pacing stays under the free tier's 20
// requests a minute, 429 and 5xx answers back off, and a daily-limit answer
// stops the run with QuotaError (the gate treats that as skipped, not failed).
// OPENROUTER_API_KEY comes from the environment or ~/.cello-secrets.env and is
// never printed.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const GENERATOR = process.env.EVAL_GENERATOR_MODEL ?? 'google/gemma-4-31b-it:free'
/** A different family from the generator, so a model never grades its own writing. */
export const JUDGE = process.env.EVAL_JUDGE_MODEL ?? 'nvidia/nemotron-3-super-120b-a12b:free'
/** Second labeler for the goal judge's reference labels. */
export const LABELER2 = process.env.EVAL_LABELER2_MODEL ?? 'poolside/laguna-s-2.1:free'

const BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1'
const MIN_GAP_MS = Number(process.env.EVAL_MIN_GAP_MS ?? 3200)
const BACKOFF_MS = (process.env.EVAL_BACKOFF_MS ?? '2000,4000,8000,16000').split(',').map(Number)

export class QuotaError extends Error {
  constructor(message = 'free model daily limit reached') {
    super(message)
    this.name = 'QuotaError'
  }
}
export class BudgetStop extends Error {
  constructor(message = 'request budget for this run is spent') {
    super(message)
    this.name = 'BudgetStop'
  }
}

export function apiKey(): string {
  const fromEnv = process.env.OPENROUTER_API_KEY?.trim()
  if (fromEnv) return fromEnv
  try {
    for (const line of readFileSync(path.join(homedir(), '.cello-secrets.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.*)$/)
      if (m) return m[1].trim().replace(/^['"]|['"]$/g, '')
    }
  } catch {
    /* fall through */
  }
  throw new Error('OPENROUTER_API_KEY is not set')
}

export interface ChatArgs {
  model: string
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  temperature?: number
  maxTokens?: number
  json?: boolean
  /** Same prompt, a different draw: part of the cache key. */
  sample?: number
}
export interface ChatResult {
  content: string | null
  cached: boolean
  model: string
  error?: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class FreeClient {
  /** Requests that went to the network (cache hits are free). */
  requests = 0
  private lastAt = 0
  readonly cacheDir: string

  constructor(
    private opts: { maxRequests: number; cacheDir?: string } = { maxRequests: Number(process.env.EVAL_MAX_REQUESTS ?? 260) }
  ) {
    this.cacheDir = opts.cacheDir ?? process.env.EVAL_CACHE_DIR ?? path.join(process.cwd(), '.cache/evals-quality')
    mkdirSync(this.cacheDir, { recursive: true })
  }

  /** Free requests left today according to OpenRouter, or null when it does not say. Never prints the key. */
  async remainingToday(): Promise<number | null> {
    try {
      const res = await fetch(`${BASE_URL}/key`, { headers: { Authorization: `Bearer ${apiKey()}` }, signal: AbortSignal.timeout(15_000) })
      if (!res.ok) return null
      const body = (await res.json()) as { data?: { free_model_daily_requests?: { remaining?: number } } }
      const left = body.data?.free_model_daily_requests?.remaining
      return typeof left === 'number' ? left : null
    } catch {
      return null
    }
  }

  async chat(args: ChatArgs): Promise<ChatResult> {
    if (!args.model.endsWith(':free')) throw new Error(`the evals only use free models, got ${args.model}`)
    const body = {
      model: args.model,
      messages: args.messages,
      temperature: args.temperature ?? 0.2,
      max_tokens: args.maxTokens ?? 1500,
      ...(args.json ? { response_format: { type: 'json_object' } } : {}),
    }
    const id = createHash('sha256').update(JSON.stringify([body, args.sample ?? 0])).digest('hex')
    const file = path.join(this.cacheDir, `${id}.json`)
    if (existsSync(file)) return { ...(JSON.parse(readFileSync(file, 'utf8')) as { content: string }), cached: true, model: args.model }

    let lastError = 'unknown'
    for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt += 1) {
      if (this.requests >= this.opts.maxRequests) throw new BudgetStop()
      const wait = this.lastAt + MIN_GAP_MS - Date.now()
      if (wait > 0) await sleep(wait)
      this.lastAt = Date.now()
      this.requests += 1
      let res: Response
      try {
        res = await fetch(`${BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://cello.app', 'X-Title': 'Cello quality eval' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(180_000),
        })
      } catch {
        lastError = 'network'
        await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)])
        continue
      }
      if (res.ok) {
        const data = (await res.json()) as { choices?: { message?: { content?: string | null } }[] }
        const content = data.choices?.[0]?.message?.content ?? null
        if (content && content.trim()) {
          writeFileSync(file, JSON.stringify({ content }))
          return { content, cached: false, model: args.model }
        }
        lastError = 'empty'
        await sleep(1500)
        continue
      }
      const text = await res.text().catch(() => '')
      if (res.status === 429 && /per-day|daily/i.test(text)) throw new QuotaError()
      lastError = `http_${res.status}`
      if (res.status === 429 || res.status >= 500) {
        await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)])
        continue
      }
      break
    }
    return { content: null, cached: false, model: args.model, error: lastError }
  }
}

/** Best-effort JSON from a model answer: fenced, or with prose around it. */
export function parseJson<T = unknown>(raw: string | null): T | null {
  if (!raw) return null
  const text = raw.trim()
  try {
    return JSON.parse(text) as T
  } catch {
    const m = text.match(/[[{][\s\S]*[\]}]/)
    if (!m) return null
    try {
      return JSON.parse(m[0]) as T
    } catch {
      return null
    }
  }
}
