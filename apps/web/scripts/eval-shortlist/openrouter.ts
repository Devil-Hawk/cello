// OpenRouter client for the shortlist evaluation. FREE MODELS ONLY: a model id
// that does not end in ":free" is refused before any request leaves. Requests are
// paced under the free-tier rate limit, cached on disk by request hash (so a
// crashed or repeated run costs nothing for work already done), and counted
// against a hard budget, because the free tier allows a fixed number of requests
// a day.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { LlmResult, LlmRunOptions } from '@/lib/harness/types'
import type { Embedder } from '@/lib/scoring/pipeline'

export interface ClientOptions {
  apiKey: string
  cacheDir: string
  /** Hard cap on answered live requests this run may make (refused ones are retried and capped separately). */
  maxRequests: number
  /** Minimum spacing between live requests. The free tier allows 20 a minute. */
  minGapMs?: number
}

export class FreeModelClient {
  live = 0
  cached = 0
  failures = 0
  /** Set when a request cap stopped the run, so a report built after that can say its figures are incomplete. */
  stoppedBy: string | null = null
  private last = 0
  private chain: Promise<void> = Promise.resolve()
  readonly byModel = new Map<string, number>()

  constructor(private readonly opts: ClientOptions) {
    mkdirSync(opts.cacheDir, { recursive: true })
  }

  private key(parts: unknown): string {
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24)
  }

  /** Serialises live requests and spaces them out. */
  private stop(message: string): Error {
    this.stoppedBy = message
    return new Error(message)
  }

  private async slot(): Promise<void> {
    const prev = this.chain
    let release!: () => void
    this.chain = new Promise<void>((r) => (release = r))
    await prev
    const wait = this.last + (this.opts.minGapMs ?? 3200) - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    this.last = Date.now()
    release()
  }

  private async post(url: string, body: unknown, timeoutMs: number): Promise<{ status: number; json: any }> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.opts.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { status: res.status, json: await res.json().catch(() => null) }
  }

  private async live_(url: string, body: unknown, model: string, timeoutMs = 240_000, attempts = 8): Promise<any> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (this.live >= this.opts.maxRequests) throw this.stop(`request budget of ${this.opts.maxRequests} live requests reached`)
      // Refused attempts cost time and no quota, so they get their own, larger cap.
      if (this.failures >= this.opts.maxRequests * 4) throw this.stop('too many failed requests, stopping')
      await this.slot()
      let r: { status: number; json: any }
      try {
        r = await this.post(url, body, timeoutMs)
      } catch {
        this.failures += 1
        await new Promise((res) => setTimeout(res, 4000 * (attempt + 1)))
        continue
      }
      // The daily allowance does not come back by waiting a few seconds, so stop and say when it does.
      if (r.status === 429 && String(r.json?.error?.message ?? '').includes('per-day')) {
        const reset = Number(r.json?.error?.metadata?.headers?.['X-RateLimit-Reset'])
        throw this.stop(`the free-model daily limit is used up${Number.isFinite(reset) ? `; it resets at ${new Date(reset).toISOString()}` : ''}`)
      }
      // A rate-limited or overloaded answer is not an answer: it costs no quota and is retried after a pause.
      if (r.status === 429 || r.status >= 500 || !r.json || r.json.error) {
        this.failures += 1
        await new Promise((res) => setTimeout(res, Math.min(45_000, 5000 * 2 ** Math.min(attempt, 3))))
        continue
      }
      this.live += 1
      this.byModel.set(model, (this.byModel.get(model) ?? 0) + 1)
      return r.json
    }
    throw new Error(`${model}: gave up after repeated failures`)
  }

  private chatBody(model: string, opts: LlmRunOptions) {
    return {
      model,
      temperature: opts.temperature ?? 0,
      max_tokens: Math.max(opts.maxTokens ?? 2000, 3000),
      reasoning: { effort: 'low' },
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
        { role: 'user', content: opts.prompt ?? '' },
      ],
    }
  }

  private chatFile(model: string, opts: LlmRunOptions): string {
    return path.join(this.opts.cacheDir, `chat-${this.key(this.chatBody(model, opts))}.json`)
  }

  /** The stored answer for this exact request, if one exists. Costs nothing. */
  cachedChat(model: string, opts: LlmRunOptions): LlmResult | null {
    const file = this.chatFile(model, opts)
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as LlmResult) : null
  }

  async chat(model: string, opts: LlmRunOptions, attempts = 8): Promise<LlmResult> {
    if (!model.endsWith(':free')) throw new Error(`refusing non-free model ${model}`)
    const body = this.chatBody(model, opts)
    const file = this.chatFile(model, opts)
    if (existsSync(file)) {
      this.cached += 1
      return JSON.parse(readFileSync(file, 'utf8')) as LlmResult
    }
    // A reply the model could not finish or that came back empty is retried once at a larger budget.
    let j = await this.live_('https://openrouter.ai/api/v1/chat/completions', body, model, 240_000, attempts)
    let choice = j.choices?.[0]
    if (!choice?.message?.content) {
      j = await this.live_('https://openrouter.ai/api/v1/chat/completions', { ...body, max_tokens: body.max_tokens * 2 }, model, 240_000, attempts)
      choice = j.choices?.[0]
    }
    const out: LlmResult = {
      content: choice?.message?.content ?? '',
      tokensUsed: j.usage?.total_tokens ?? 0,
      promptTokens: j.usage?.prompt_tokens ?? 0,
      completionTokens: j.usage?.completion_tokens ?? 0,
      model: j.model ?? model,
      finishReason: choice?.finish_reason,
    }
    if (out.content) writeFileSync(file, JSON.stringify(out))
    return out
  }

  /** A model runner in the shape the production modules take. Falls back through `models` on an empty reply. */
  runner(models: string[]) {
    return async (opts: LlmRunOptions): Promise<LlmResult> => {
      let last: LlmResult | null = null
      // An answer any listed model already gave to this exact request is reused.
      for (const m of models) {
        const hit = this.cachedChat(m, opts)
        if (hit?.content) {
          this.cached += 1
          return hit
        }
      }
      for (const m of models) {
        try {
          // A model that keeps refusing is given up on quickly so the next one gets the work.
          const out = await this.chat(m, opts, m === models[models.length - 1] ? 8 : 3)
          if (out.content) return out
          last = out
        } catch (err) {
          if (m === models[models.length - 1]) throw err
        }
      }
      return last ?? { content: '', tokensUsed: 0, promptTokens: 0, completionTokens: 0, model: models[0] }
    }
  }

  async embeddings(model: string, texts: string[]): Promise<number[][]> {
    if (!model.endsWith(':free')) throw new Error(`refusing non-free model ${model}`)
    const body = { model, input: texts }
    const file = path.join(this.opts.cacheDir, `emb-${this.key(body)}.json`)
    if (existsSync(file)) {
      this.cached += 1
      return JSON.parse(readFileSync(file, 'utf8'))
    }
    const j = await this.live_('https://openrouter.ai/api/v1/embeddings', body, model, 120_000)
    const vectors = [...j.data].sort((a: any, b: any) => a.index - b.index).map((d: any) => d.embedding as number[])
    writeFileSync(file, JSON.stringify(vectors))
    return vectors
  }

  embedder(model: string): Embedder {
    return { model, embed: (texts) => this.embeddings(model, texts) }
  }
}
