// What recall hands back, as the things and results the rest of Chat reads (commands, the loop, the turn). Each
// keeps the chat and turn it came from, so the answer that uses it can show where it came from.

import type { TurnResult } from './answer'
import type { RecallHit } from './recall'
import { thingText, type Thing } from './things'

/** A thing a tool returned as a result the answer check reads: what it is about, and the text its facts are checked against. */
export function resultOf(t: Thing): TurnResult {
  return { object: { kind: t.kind, ref: t.id }, text: thingText(t), ...(t.recalled ? { recalled: t.recalled } : {}) }
}

/** A recall hit as a thing, with its source: the made thing for a made hit, the chat for the rest. */
export function recalledThing(h: RecallHit): Thing[] {
  const source = h.link.source ?? (h.chat ? { chat_id: h.chat.id, turn_id: h.turnId ?? '' } : undefined)
  if (!source) return []
  const base = { company: null, place: null, pay: null, chance: null, posted: null, recalled: source } as const
  if (h.kind === 'made' && h.made) return [{ ...base, kind: 'made', id: h.made.id, title: h.chat ? `${h.text.split('\n')[0].slice(0, 120)} (from your chat "${h.chat.title}")` : h.text.slice(0, 160), notes: [h.text] }]
  return h.chat ? [{ ...base, kind: 'chat', id: h.chat.id, title: h.chat.title || 'Earlier chat', notes: [h.text] }] : []
}
