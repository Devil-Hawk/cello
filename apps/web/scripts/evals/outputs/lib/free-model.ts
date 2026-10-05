// Free-model client for the output evals. It only ever talks to OpenRouter
// models whose id ends in ":free", paces requests under the free-tier rate
// limit, caches every answer on disk so a re-run costs nothing, and counts
// requests so a CI run can cap itself.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const WRITER_MODEL = 'google/gemma-4-31b-it:free'
export const PRODUCTION_JUDGE_MODEL = 'qwen/qwen3.8-27b:free'
export const YARDSTICK_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free'

const ENDPOINT = 'https://openrouter.ai/api/v1'
const PER_MINUTE = 18
const CACHE_DIR = join(process.cwd(), '.cache', 'evals-outputs')

export interface ChatArgs {
  model: string
  system?: string
  prompt?: string
  messages?: { role: 'system' | 'user' | 'assistant'; content: string }[]
  json?: boolean
  maxTokens?: number
  temperature?: number
}

export interface ChatResult {
  content: string
  finishReason: string
  tokensUsed: number
  cached: boolean
}

export class EvalBudgetError extends Error {}

/** `--stub`: no network, every call answers with this text. For checking a script's plumbing, never for numbers. */
let stubContent: string | null = null
export function setStub(content: string | null): void {
  stubContent = content
}

let apiKey: string | null | undefined
let requests = 0
let maxRequests = Infinity
const stamps: number[] = []
let verifiedModels: Set<string> | null = null

export function setMaxRequests(n: number): void {
  maxRequests = n
}
export function requestCount(): number {
  return requests
}

/** Key from the environment, else ~/.cello-secrets.env. Never printed. */
export function loadKey(): string | null {
  if (apiKey !== undefined) return apiKey
  let key = process.env.OPENROUTER_API_KEY?.trim() || null
  if (!key) {
    const file = join(homedir(), '.cello-secrets.env')
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const m = line.match(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.*)$/)
        if (m) key = m[1].trim().replace(/^['"]|['"]$/g, '') || null
      }
    }
  }
  apiKey = key
  return key
}

/** Exit 0 with "skipped" when there is no key, so CI without secrets stays green. */
export function requireKeyOrSkip(): string {
  const key = loadKey()
  if (!key) {
    console.log('skipped: OPENROUTER_API_KEY is not set')
    process.exit(0)
  }
  return key
}

async function pace(): Promise<void> {
  for (;;) {
    const now = Date.now()
    while (stamps.length && now - stamps[0] > 60_000) stamps.shift()
    if (stamps.length < PER_MINUTE) {
      stamps.push(now)
      return
    }
    await new Promise((r) => setTimeout(r, 60_000 - (now - stamps[0]) + 50))
  }
}

async function assertFreeAndReal(model: string, key: string): Promise<void> {
  if (!model.endsWith(':free')) throw new Error(`eval models must end in ":free", got ${model}`)
  if (!verifiedModels) {
    const res = await fetch(`${ENDPOINT}/models`, { headers: { Authorization: `Bearer ${key}` } })
    const body = (await res.json()) as { data?: { id: string }[] }
    verifiedModels = new Set((body.data ?? []).map((m) => m.id))
  }
  if (!verifiedModels.has(model)) throw new Error(`model ${model} is not listed by OpenRouter`)
}

function cachePath(args: ChatArgs, messages: unknown): string {
  const hash = createHash('sha256')
    .update(JSON.stringify({ m: args.model, messages, j: !!args.json, t: args.temperature ?? 0, k: args.maxTokens ?? 0 }))
    .digest('hex')
  return join(CACHE_DIR, `${hash}.json`)
}

export async function chat(args: ChatArgs): Promise<ChatResult> {
  if (stubContent !== null) {
    requests++
    return { content: stubContent, finishReason: 'stop', tokensUsed: 0, cached: false }
  }
  const messages =
    args.messages ??
    [
      ...(args.system ? [{ role: 'system' as const, content: args.system }] : []),
      { role: 'user' as const, content: args.prompt ?? '' },
    ]
  const file = cachePath(args, messages)
  if (existsSync(file)) {
    const hit = JSON.parse(readFileSync(file, 'utf8')) as Omit<ChatResult, 'cached'>
    return { ...hit, cached: true }
  }
  const key = requireKeyOrSkip()
  await assertFreeAndReal(args.model, key)
  if (requests >= maxRequests) throw new EvalBudgetError(`request cap of ${maxRequests} reached`)

  let lastError = ''
  for (let attempt = 0; attempt < 5; attempt++) {
    await pace()
    requests++
    let res: Response
    try {
      res = await fetch(`${ENDPOINT}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: args.model,
          messages,
          max_tokens: args.maxTokens ?? 1500,
          temperature: args.temperature ?? 0,
          ...(args.json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: AbortSignal.timeout(150_000),
      })
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)))
      continue
    }
    if (res.status === 429 || res.status >= 500) {
      lastError = `HTTP ${res.status}`
      // The free tier has a daily pool shared by everything on the account. When it is spent,
      // waiting does not help: stop the run and say when it resets instead of retrying for an hour.
      if (res.status === 429 && /per-day|daily/i.test(await res.text().catch(() => ''))) {
        throw new EvalBudgetError('the free-model daily limit is used up; it resets at 00:00 UTC')
      }
      await new Promise((r) => setTimeout(r, 8000 * (attempt + 1)))
      continue
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string | null }; finish_reason?: string }[]
      usage?: { total_tokens?: number }
      error?: { message?: string }
    }
    const choice = body.choices?.[0]
    const content = choice?.message?.content
    if (!res.ok || content == null) {
      lastError = body.error?.message ?? `HTTP ${res.status} with no content`
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)))
      continue
    }
    const out = { content, finishReason: choice?.finish_reason ?? 'stop', tokensUsed: body.usage?.total_tokens ?? 0 }
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(file, JSON.stringify(out))
    return { ...out, cached: false }
  }
  throw new Error(`free model call failed after retries: ${lastError.replace(/sk-[\w-]+/g, '[redacted]')}`)
}
