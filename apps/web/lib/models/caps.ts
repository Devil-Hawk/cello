// What a free key gets without credit (blueprint 11.3). The caps are step caps inside
// workflows, applied only when the rung picked is R3 and no credit was ever bought
// (a person with credit, a model on their computer or their own key gets the limits of
// lib/commands/limits.ts instead).
//
// Daily caps are counted in command_slots on channel "free", in UTC days, the way
// OpenRouter counts its own. The per-run and per-turn numbers are for the callers that
// own a run or a turn: the morning pick (K20) counts 15 model steps, Chat (K24) 8 calls.

import { rootCause } from '../agents/spend-port'
import { rpcSlotStore, type SlotStore } from '../commands/slots'
import { createAdminClient } from '../harness/supabase-admin'
import type { DecryptedApiKeys } from '../harness/types'
import type { Rung } from './doors.types'

export const FREE_KEY_CAPS = {
  pick: { perRun: 15 },
  chat: { perTurn: 8 },
  research: { perDay: 3, subjectsPerDay: 1 },
  drafts: { perDay: 5 },
  chance: { perDay: 24 },
} as const

type DailyKind = 'drafts' | 'chance' | 'research'

/** The steps each daily cap counts. A step in none of these has no daily cap. */
const KIND_OF_STEP: Record<string, DailyKind> = {
  'writer.draft': 'drafts',
  'draft-outreach-message': 'drafts',
  'draft-follow-up': 'drafts',
  'draft-application-follow-up': 'drafts',
  'tailor-cv': 'drafts',
  'optimize-resume': 'drafts',
  'write-resume': 'drafts',
  'write-cover_letter': 'drafts',
  'write-message': 'drafts',
  'write-follow_up': 'drafts',
  'write-reply': 'drafts',
  'write-note': 'drafts',
  'answer.draft': 'drafts',
  chance: 'chance',
  'role.evidence': 'chance',
  'research.summary': 'research',
  'research-company': 'research',
}

const WHAT: Record<DailyKind, string> = { drafts: '5 drafts', chance: '24 role checks', research: '1 research subject' }

/** After a cap, what the person can press: Settings for credit, the picker for another model. A row holds the plain words; the chat's answer renders Markdown, so there the action is a link. */
export const CAP_FIX = {
  plain: 'Add credit in Settings, under Models, or choose another model.',
  chat: '[Add credit in Settings](/settings#models) or choose another model under the compose box.',
} as const

export class FreeCapError extends Error {
  constructor(readonly kind: DailyKind) {
    super(`Free models allow ${WHAT[kind]} a day. ${CAP_FIX.plain}`)
    this.name = 'FreeCapError'
  }
}

/** The graph hit its step cap (langgraph's GraphRecursionError). Its own message is a docs link, so this line replaces it. */
export const STEP_LIMIT_LINE = 'Cello took too many steps on this and stopped. Nothing was changed. Ask again with one thing at a time.'

export const NO_MODEL_LINE = 'Cello has no model to run on. Add a key or pick Free models in Settings, under Models.'
const NO_MODEL_CHAT = 'Cello has no model to run on. Add a key or pick Free models in [Settings, under Models](/settings#models).'

/** The failures whose message is already a plain sentence a person can read. */
const SAID_PLAINLY = new Set(['FreeCapError', 'BelowRungError', 'CeilingError', 'BudgetCapError', 'CommandRefusal'])

/**
 * The real reason behind a failure code knows about (a free cap, a spend cap, the ceiling, a missing key, a refusal),
 * however many layers wrapped it; null for anything else, so the caller keeps its own generic line. One function for
 * every catch between a model call and the person, so no catch replaces the reason with "could not finish".
 * For the chat's answer (`as: 'chat'`, rendered as Markdown) the action after a cap or a missing key is a link.
 */
export function reasonOf(e: unknown, as: 'plain' | 'chat' = 'plain'): string | null {
  const root = rootCause(e) as { name?: unknown; message?: unknown; lc_error_code?: unknown } | null
  const name = typeof root?.name === 'string' ? root.name : ''
  const message = typeof root?.message === 'string' ? root.message.trim() : ''
  if (name === 'MissingKeyError') return as === 'chat' ? NO_MODEL_CHAT : NO_MODEL_LINE
  if (name === 'GraphRecursionError' || root?.lc_error_code === 'GRAPH_RECURSION_LIMIT') return STEP_LIMIT_LINE
  if (!SAID_PLAINLY.has(name) || !message) return null
  return as === 'chat' ? message.replace(CAP_FIX.plain, CAP_FIX.chat) : message
}

/**
 * Counts one use against the day's cap when a free key without credit is about to run
 * `stepId` on R3, and throws FreeCapError past it. Anything else passes.
 * ponytail: a call that then fails still used its slot; credit the slot back if that ever bites.
 */
export async function takeFreeCap(stepId: string, rung: Rung, keys: DecryptedApiKeys, slots?: SlotStore): Promise<void> {
  const kind = KIND_OF_STEP[stepId]
  if (!kind || rung !== 'R3' || keys.models?.creditBought || !keys.userId) return
  const store = slots ?? rpcSlotStore(createAdminClient())
  const ok = await store.take({ userId: keys.userId, channel: 'free', bucket: kind, limit: FREE_KEY_CAPS[kind].perDay, windowSeconds: 86_400 })
  if (!ok) throw new FreeCapError(kind)
}
