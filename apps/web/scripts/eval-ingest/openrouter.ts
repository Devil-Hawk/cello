// A direct OpenRouter client for the ingestion evals. Free models only (the id
// must end in ":free"), temperature 0, answers cached on disk by (model, prompts,
// max tokens) so a rerun costs nothing and an interrupted run resumes. It writes
// nothing to any database. The key comes from OPENROUTER_API_KEY or
// ~/.cello-secrets.env and is never printed.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const CACHE = path.join(__dirname, '.cache')

export class QuotaError extends Error {
  constructor() {
    super('free_model_daily_limit')
    this.name = 'QuotaError'
  }
}

function key(): string {
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
  system: string
  user: string
  maxTokens: number
}
export interface ChatResult {
  content: string | null
  cached: boolean
  error?: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function chat(args: ChatArgs): Promise<ChatResult> {
  if (!args.model.endsWith(':free')) throw new Error('the eval only uses free models')
  mkdirSync(CACHE, { recursive: true })
  const id = createHash('sha256').update(JSON.stringify([args.model, args.system, args.user, args.maxTokens])).digest('hex')
  const file = path.join(CACHE, `${id}.json`)
  if (existsSync(file)) return { ...(JSON.parse(readFileSync(file, 'utf8')) as { content: string | null }), cached: true }

  let lastError = 'unknown'
  for (let attempt = 0; attempt < 4; attempt++) {
    let res: Response
    try {
      res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://cello.app', 'X-Title': 'Cello ingestion eval' },
        body: JSON.stringify({
          model: args.model,
          messages: [...(args.system ? [{ role: 'system', content: args.system }] : []), { role: 'user', content: args.user }],
          max_tokens: args.maxTokens,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(120_000),
      })
    } catch {
      lastError = 'network'
      await sleep(2000 * (attempt + 1))
      continue
    }
    if (res.ok) {
      const body = (await res.json()) as { choices?: { message?: { content?: string | null } }[]; error?: unknown }
      const content = body.choices?.[0]?.message?.content ?? null
      if (content) {
        writeFileSync(file, JSON.stringify({ content }))
        return { content, cached: false }
      }
      lastError = 'empty'
      await sleep(1500)
      continue
    }
    const text = await res.text().catch(() => '')
    if (res.status === 429) {
      if (/per-day/i.test(text)) throw new QuotaError()
      lastError = 'rate_limited'
      await sleep(8000 * (attempt + 1))
      continue
    }
    lastError = `http_${res.status}`
    if (res.status >= 500) {
      await sleep(3000 * (attempt + 1))
      continue
    }
    break
  }
  return { content: null, cached: false, error: lastError }
}
