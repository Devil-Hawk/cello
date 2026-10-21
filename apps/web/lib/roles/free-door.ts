// The one door a roles model step goes through (role.requirements, role.evidence). Nothing else under lib/roles
// calls a model, and nothing here decides a fact: a step hands in its prompt, its input and the schema its answer
// must fit, and gets the checked answer with its provenance, or the reason there was none.
//
// Which model answers, first that applies:
//   1. the person's own OpenRouter key (rung R4, or R3 when they chose a free model), through callLlm
//   2. the platform's free models (rung R3), paced at 20 calls a minute and held to a daily budget shared fairly
//   3. a local model when this server is self-hosted and the person chose one (rung R2)
// An answer that is not JSON of the schema's shape is `bad_answer`, never a guess.
//
// ponytail: the minute bucket lives in one process. On Vercel each instance has its own, so the true rate is 20 a
// minute per instance; a slice runs its calls one after another (about 10 s each), so one slice stays far below it.
// The day's total is counted in the database (judge_budget), which is shared. Upgrade: put the bucket in the database.

import type { z } from 'zod'
import { freeFallbackModels } from '@/lib/agents/model'
import { loadApiKeys } from '@/lib/harness/keys'
import { callLlm, isSelfHosted, parseJsonLoose, resolveProviderId } from '@/lib/harness/llm'
import { rungFor } from '@/lib/harness/spend'
import type { AdminClient, DecryptedApiKeys, LlmResult } from '@/lib/harness/types'
import { freeModelKeys } from '@/lib/ingest/model'
import type { Prov } from '@/lib/provenance/types'

export type JudgeLimit = 'minute' | 'day' | 'no_model' | 'bad_answer'

export interface JudgeCallInput<T> {
  userId: string
  /** The declared step, written to the ledger and to the provenance: role.requirements or role.evidence. */
  step: string
  /** The system prompt. */
  prompt: string
  /** What the model reads: the user message. */
  input: string
  schema: z.ZodType<T>
  promptRef?: { name: string; hash?: string }
  maxTokens?: number
}

export type JudgeResult<T> = { ok: true; json: T; prov: Prov } | { ok: false; limit: JudgeLimit }

/** Free calls a day for the whole server when JUDGE_FREE_DAILY_CALLS is not set. OpenRouter allows 1,000 a day on a funded account. */
export const DEFAULT_DAILY_CALLS = 800
/** The fewest calls a person's day share can be, however many people are waiting. */
export const MIN_SHARE = 20
export const CALLS_PER_MINUTE = 20

/** An in-process token bucket: `rate` calls refill over `perMs`. */
export class Bucket {
  private tokens: number
  private last: number
  constructor(
    private readonly rate = CALLS_PER_MINUTE,
    private readonly perMs = 60_000,
    private readonly now: () => number = Date.now
  ) {
    this.tokens = rate
    this.last = now()
  }
  take(): boolean {
    const t = this.now()
    this.tokens = Math.min(this.rate, this.tokens + ((t - this.last) / this.perMs) * this.rate)
    this.last = t
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }
}

export interface DoorDeps {
  call: typeof callLlm
  loadKeys: (db: AdminClient, userId: string) => Promise<DecryptedApiKeys>
  /** The platform's OpenRouter key; the free models are asked with it and never with a model that is not free. */
  platformKey: () => string | undefined
  selfHosted: () => boolean
  bucket: { take(): boolean }
  now: () => Date
  dailyCap: () => number
  models: () => string[]
}

const intFromEnv = (v: string | undefined, fallback: number) => {
  const n = Number.parseInt(v ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export const realDoor: DoorDeps = {
  call: callLlm,
  loadKeys: loadApiKeys,
  platformKey: () => process.env.OPENROUTER_API_KEY?.trim() || undefined,
  selfHosted: isSelfHosted,
  bucket: new Bucket(),
  now: () => new Date(),
  dailyCap: () => intFromEnv(process.env.JUDGE_FREE_DAILY_CALLS, DEFAULT_DAILY_CALLS),
  models: () => freeFallbackModels(),
}

/** The day's share of the free calls for one person: the cap over the people with roles waiting, at least MIN_SHARE. */
export function dayShare(cap: number, people: number): number {
  return Math.max(MIN_SHARE, Math.floor(cap / Math.max(1, people)))
}

/**
 * People with kept roles still waiting to be judged, the asker counted. Reads the first 2,000 waiting rows.
 * ponytail: past 2,000 waiting rows the divisor stops growing; count with a database function if that is ever reached.
 */
async function peopleWaiting(db: AdminClient, userId: string): Promise<number> {
  const { data } = await db.from('person_roles').select('user_id').is('judged_at', null).is('hidden_reason', null).limit(2000)
  return new Set([userId, ...((data as { user_id: string }[] | null) ?? []).map((r) => r.user_id)]).size
}

/** Takes one call from the day's budget for the person. False when the day's cap or their share is used. */
async function takeFreeCall(db: AdminClient, userId: string, deps: DoorDeps): Promise<boolean> {
  const cap = deps.dailyCap()
  const share = dayShare(cap, await peopleWaiting(db, userId))
  const { data, error } = await db.rpc('take_judge_call', { p_day: deps.now().toISOString().slice(0, 10), p_user: userId, p_share: share, p_cap: cap })
  return !error && data === true
}

function checked<T>(raw: string | null | undefined, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(parseJsonLoose(raw ?? ''))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

const provOf = (step: string, result: LlmResult, provider: Parameters<typeof rungFor>[0], deps: DoorDeps): Prov => ({
  step,
  model: result.model,
  rung: rungFor(provider, result.model),
  evidence: [],
  at: deps.now().toISOString(),
})

/** Whether an error says the provider's day is spent, as OpenRouter words its free-model limit. */
const isDaily = (e: unknown) => /per[- ]day|daily/i.test(e instanceof Error ? e.message : String(e))

export async function judgeCall<T>(db: AdminClient, args: JudgeCallInput<T>, deps: DoorDeps = realDoor): Promise<JudgeResult<T>> {
  let keys: DecryptedApiKeys
  try {
    keys = await deps.loadKeys(db, args.userId)
  } catch {
    // An expired demo and an unreadable profile both end here: nothing is asked of any model for them.
    return { ok: false, limit: 'no_model' }
  }
  const request = { system: args.prompt, prompt: args.input, json: true, temperature: 0, maxTokens: args.maxTokens ?? 1500, name: args.step, door: 'routine' as const, ...(args.promptRef ? { promptRef: args.promptRef } : {}) }
  const provider = resolveProviderId(keys.provider?.active)
  let answered: 'bad' | null = null

  // 1. The person's own key. A key that fails or has no budget left falls through to the free path.
  if (keys.openrouter) {
    try {
      const result = await deps.call(keys, request, AbortSignal.timeout(90_000))
      const json = checked(result.content, args.schema)
      if (json !== null) return { ok: true, json, prov: provOf(args.step, result, provider, deps) }
      answered = 'bad'
    } catch {
      /* the next rung */
    }
  }

  // 2. The platform's free models, paced and budgeted. Models are tried in order; the first that answers in shape wins.
  const platform = deps.platformKey()
  if (platform) {
    if (!deps.bucket.take()) return { ok: false, limit: 'minute' }
    if (!(await takeFreeCall(db, args.userId, deps))) return { ok: false, limit: 'day' }
    const free = freeModelKeys(keys, platform)
    let failure: unknown = null
    for (const model of deps.models()) {
      if (!model.endsWith(':free')) continue
      try {
        const result = await deps.call(free, { ...request, model, reasoning: { effort: 'none' } }, AbortSignal.timeout(60_000))
        const json = checked(result.content, args.schema)
        if (json !== null) return { ok: true, json, prov: provOf(args.step, result, 'openrouter', deps) }
        answered = 'bad'
      } catch (error) {
        failure = error
      }
    }
    if (answered === 'bad') return { ok: false, limit: 'bad_answer' }
    return { ok: false, limit: isDaily(failure) ? 'day' : 'minute' }
  }

  // 3. A local model on a self-hosted server, when the person chose one.
  if (provider !== 'openrouter' && deps.selfHosted()) {
    try {
      const result = await deps.call(keys, request, AbortSignal.timeout(180_000))
      const json = checked(result.content, args.schema)
      if (json !== null) return { ok: true, json, prov: provOf(args.step, result, provider, deps) }
      return { ok: false, limit: 'bad_answer' }
    } catch {
      return { ok: false, limit: 'no_model' }
    }
  }
  return { ok: false, limit: answered === 'bad' ? 'bad_answer' : 'no_model' }
}
