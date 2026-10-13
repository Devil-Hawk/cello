// One notion of a model choice for Chat (blueprint 5.3, directive 36): {rung, model, effort}.
//
// A turn resolves its choice in this order, and always at or under the highest the person allows:
//   the turn's choice, the chat's (chats.model_choice), the person's Chat model in Settings > Models,
//   their default model, then whatever the ladder picks.
// A stored choice is data a person (or a forged request) can write, so it is parsed strictly each time
// it is read; a choice that cannot run steps down and says so, so `ran` never claims a model that did not run.
//
// Pure functions: the caller supplies which rungs are set up and which model a rung would use, from the
// ladder (lib/models/ladder.ts, through chatLimits). celloChatModel(choice) builds the model from the result.
//
// Each role (the chat loop, the Researcher, the Writer, background work) has its own choice, kept in the same shape:
// roleChoice reads it, resolveChoice holds it to the highest and to what is set up, keysForRole makes the keys a role's
// model calls run on, and the factory (lib/models/factory.ts) builds the client, with the effort, for any way in.

import { z } from 'zod'
import { MAX_TOKENS, tagRun, type ModelPurpose } from '@/lib/agents/model'
import { estimateCostUsd, hasListedPrice } from '@/lib/harness/spend'
import { REASONING_EFFORTS, type AdminClient, type DecryptedApiKeys, type ReasoningEffort } from '@/lib/harness/types'
import { ALLOWED_MODELS } from '@/lib/models'
import type { Ceiling, Rung } from './doors.types'
import { chatModelFor } from './factory'
import type { Role } from './roles'
import { availableRungs, directModel, routeFor } from './ladder'

export { ROLES, ROLE_LABELS, type Role } from './roles'

// The rungs a Chat turn can run on: local, free hosted, paid hosted.
export const CHOICE_RUNGS = ['R2', 'R3', 'R4'] as const
export type ChoiceRung = Extract<Rung, 'R2' | 'R3' | 'R4'>
/** "Highest Cello may use": R0 none, R2 local, R3 free models, R4 paid models. */
export type ChoiceCeiling = 'R0' | ChoiceRung

const RANK: Record<ChoiceCeiling, number> = { R0: 0, R2: 1, R3: 2, R4: 3 }

/** True when a rung is at or under the highest the person allows. */
export const withinCeiling = (rung: ChoiceRung, ceiling: ChoiceCeiling) => RANK[rung] <= RANK[ceiling]

export const ModelChoiceSchema = z.strictObject({
  rung: z.enum(CHOICE_RUNGS),
  model: z.string().min(1).max(200),
  effort: z.enum(REASONING_EFFORTS),
})
export type ModelChoice = z.infer<typeof ModelChoiceSchema>

/** A stored or posted value as a choice, or null when it is not one. */
export function parseChoice(value: unknown): ModelChoice | null {
  const parsed = ModelChoiceSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

const isFree = (model: string) => model.endsWith(':free')

/**
 * Checks a choice the person is setting (chat.settings): a rung above their highest is refused, and so is a paid
 * model on a free rung, so a forged request cannot reach a paid door with the highest set to Free models.
 */
export function validateChoice(value: unknown, ceiling: ChoiceCeiling): { ok: true; choice: ModelChoice } | { ok: false; error: string; fix: string } {
  const choice = parseChoice(value)
  if (!choice) return { ok: false, error: 'That is not a model choice.', fix: 'Pick one from the model list.' }
  if (RANK[choice.rung] > RANK[ceiling]) {
    return { ok: false, error: 'That is above the highest model you allow.', fix: 'Raise it in Settings under Models, or pick a lower one.' }
  }
  if (choice.rung === 'R3' && !isFree(choice.model)) return { ok: false, error: 'That model is not free.', fix: 'Pick a free model, or choose a paid rung.' }
  if (choice.rung === 'R4' && !(ALLOWED_MODELS as readonly string[]).includes(choice.model)) {
    return { ok: false, error: 'Cello does not offer that model.', fix: 'Pick one from the model list.' }
  }
  return { ok: true, choice }
}

export interface ChoiceLimits {
  ceiling: ChoiceCeiling
  /** The rungs that are set up for this person. */
  available: ChoiceRung[]
  /** The model a rung would use, from the ladder. */
  route: (rung: ChoiceRung) => string
  effort: ReasoningEffort
}

/** What the picker may offer this person, from the ladder: the rungs set up, the highest allowed, the model a rung uses. */
export function chatLimits(keys: DecryptedApiKeys): ChoiceLimits {
  const ceiling = (keys.models?.ceiling ?? 'R3') as Ceiling
  const chat = (r: Rung): r is ChoiceRung => r === 'R2' || r === 'R3' || r === 'R4'
  return {
    ceiling: ceiling === 'R0' || ceiling === 'R1' ? 'R0' : ceiling,
    available: availableRungs(keys, ceiling).filter(chat),
    route: (rung) => routeFor(rung, keys).model,
    effort: 'low',
  }
}

export interface Ran {
  rung: ChoiceRung
  model: string
  effort: ReasoningEffort
  /** Present when the turn did not run on what was chosen. */
  steppedDown?: { wanted: ModelChoice; why: 'above_highest' | 'not_set_up' | 'model' }
}

/**
 * What the turn runs on: the first usable candidate in order, held to the highest and to what is set up.
 * Null when nothing can run, so the caller can say so instead of guessing a model.
 */
export function resolveChoice(candidates: unknown[], limits: ChoiceLimits): Ran | null {
  const usable = limits.available.filter((r) => RANK[r] <= RANK[limits.ceiling]).sort((a, b) => RANK[b] - RANK[a])
  if (usable.length === 0) return null
  const wanted = candidates.map(parseChoice).find((c) => c !== null) ?? null
  const rung = wanted && usable.includes(wanted.rung) ? wanted.rung : (usable.find((r) => !wanted || RANK[r] < RANK[wanted.rung]) ?? usable[0])
  // A model that does not belong on the rung (a paid id on a free rung) is replaced by the rung's own, never run.
  const keep = wanted !== null && wanted.rung === rung && (rung === 'R4' ? (ALLOWED_MODELS as readonly string[]).includes(wanted.model) : rung === 'R3' ? isFree(wanted.model) : false)
  const model = keep && wanted ? wanted.model : limits.route(rung)
  const effort = wanted?.effort ?? limits.effort
  if (!wanted) return { rung, model, effort }
  const why = RANK[wanted.rung] > RANK[limits.ceiling] ? 'above_highest' : wanted.rung !== rung ? 'not_set_up' : model !== wanted.model ? 'model' : null
  return why ? { rung, model, effort, steppedDown: { wanted, why } } : { rung, model, effort }
}

export interface Estimate {
  /** False when the model has no listed price: then there is nothing true to show before sending. */
  known: boolean
  usd: number | null
  text: string
}

/** The line next to the Send button: Free, an amount, or that the cost is not known before sending. */
export function estimateChoice(choice: Pick<ModelChoice, 'rung' | 'model'>, tokens: { prompt: number; completion: number }): Estimate {
  if (choice.rung !== 'R4' || isFree(choice.model)) return { known: true, usd: 0, text: 'Free' }
  if (!hasListedPrice(choice.model)) return { known: false, usd: null, text: 'Cost not known before sending' }
  const usd = estimateCostUsd(choice.model, tokens.prompt, tokens.completion)
  return { known: true, usd, text: usd < 0.01 ? 'Under $0.01' : `About $${usd.toFixed(2)}` }
}

/**
 * The stored choice for a role, or null. `chat` is the person's Chat model; the others are kept in preferences.role_choices
 * and fall back to `fallback` (the turn's own choice, so a role the person never set runs where Chat runs), then to the Chat model.
 * What comes back is still data: resolveChoice holds it to the highest and to what is set up.
 */
export function roleChoice(prefs: Record<string, unknown>, role: Role, fallback?: unknown): ModelChoice | null {
  const own = role === 'chat' ? null : (prefs.role_choices as Record<string, unknown> | null | undefined)?.[role]
  return parseChoice(own) ?? parseChoice(fallback) ?? parseChoice(prefs.chat_choice)
}

/**
 * The keys a role's model calls run on: the rung first in the order, the model and the effort the person chose for it, so
 * the ladder, the factory and the ledger all see the same choice. Without a ceiling on the keys (a script) they are returned as they were.
 */
export function keysForRole(keys: DecryptedApiKeys, ran: Pick<Ran, 'rung' | 'model' | 'effort'>, role: Role): DecryptedApiKeys {
  const models = keys.models ? { ...keys.models, order: [ran.rung, ...keys.models.order.filter((r) => r !== ran.rung)] } : keys.models
  return { ...keys, role, model: ran.model, roleEffort: ran.effort, ...(models ? { models } : {}) }
}

/**
 * The keys a role runs on, for a caller that has only the person (and the chat, when it runs inside one): their setting for
 * the role, else the chat's model, else Chat's default, held to the highest and to what is set up. Unchanged keys when
 * nothing can be chosen, so nothing moves for a person who set nothing.
 */
export async function roleKeys(db: AdminClient, userId: string, keys: DecryptedApiKeys, role: Role, chatId?: string | null): Promise<DecryptedApiKeys> {
  const { data } = await db.from('profiles').select('preferences').eq('id', userId).maybeSingle()
  const prefs = ((data as { preferences: Record<string, unknown> | null } | null)?.preferences ?? {}) as Record<string, unknown>
  const chat = chatId ? await db.from('chats').select('model_choice').eq('id', chatId).eq('user_id', userId).maybeSingle() : null
  const ran = resolveChoice([roleChoice(prefs, role, (chat?.data as { model_choice: unknown } | null)?.model_choice)], chatLimits(keys))
  return ran ? keysForRole(keys, ran, role) : keys
}

/**
 * The one constructor for the model a resolved choice runs on (Chat, the Researcher and the declared steps share it): the
 * way in the rung gives (free models or the person's key through OpenRouter, their OpenAI or Anthropic key, a local server),
 * built by the model factory with the effort chosen. A free rung only ever gets a free id, so a forged paid id cannot spend;
 * a model without a thinking setting is simply not sent one.
 */
export function celloChatModel(ran: Pick<ModelChoice, 'rung' | 'model' | 'effort'>, apiKeys: DecryptedApiKeys, purpose: ModelPurpose = 'orchestrator') {
  if (ran.rung === 'R3' && !isFree(ran.model)) throw new Error('A free choice was given a model that is not free.')
  const keys = keysForRole(apiKeys, ran, purpose === 'researcher' ? 'researcher' : 'chat')
  const { via } = routeFor(ran.rung, keys)
  if (via === 'local-cli') throw new Error('This computer cannot run Chat through a command line tool. Use a local server.')
  const model = via === 'openai' || via === 'anthropic' ? directModel(via, ran.model) : ran.model
  const built = chatModelFor(via, model, keys, { maxTokens: MAX_TOKENS[purpose], temperature: 0.2, reasoning: { effort: ran.effort } })
  return tagRun(built, { rung: ran.rung, via, effort: ran.effort })
}
