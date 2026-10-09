// What a free key gets without credit (blueprint 11.3). The caps are step caps inside
// workflows, applied only when the rung picked is R3 and no credit was ever bought
// (a person with credit, a model on their computer or their own key gets the limits of
// lib/commands/limits.ts instead).
//
// Daily caps are counted in command_slots on channel "free", in UTC days, the way
// OpenRouter counts its own. The per-run and per-turn numbers are for the callers that
// own a run or a turn: the morning pick (K20) counts 15 model steps, Chat (K24) 8 calls.

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
  chance: 'chance',
  'role.evidence': 'chance',
  'research.summary': 'research',
  'research-company': 'research',
}

const WHAT: Record<DailyKind, string> = { drafts: '5 drafts', chance: '24 role checks', research: '1 research subject' }

export class FreeCapError extends Error {
  constructor(readonly kind: DailyKind) {
    super(`Free models allow ${WHAT[kind]} a day. Add credit or choose another way to run.`)
    this.name = 'FreeCapError'
  }
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
