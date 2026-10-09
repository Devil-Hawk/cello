// What a Chat command hands back about the things it found, in one shape. The loop turns each thing into a result
// the answer check reads (an `about` can only name a thing a tool returned, and a number or date in a part must be
// in that thing's text), so the check never rests on what a model said about a role. Every field comes from a stored
// row; the strings are the posting's own words, so they are untrusted text.

import { z } from 'zod'
import { codeText, untrustedText } from '@/lib/commands/text'

export const ThingSchema = z.object({
  kind: z.enum(['role', 'company', 'made', 'chat', 'person']),
  id: codeText(100),
  title: untrustedText(200),
  company: untrustedText(120).nullable(),
  place: untrustedText(160).nullable(),
  /** The pay as the posting states it; null when it states none. */
  pay: untrustedText(120).nullable(),
  chance: z.enum(['strong', 'possible', 'stretch']).nullable(),
  /** yyyy-mm-dd */
  posted: codeText(10).nullable(),
  /** More lines about the thing: why it was kept, what it lacks. */
  notes: z.array(untrustedText(4000)).max(12),
  /** Set on a thing recalled from an earlier chat: the chat and turn it came from. */
  recalled: z.object({ chat_id: codeText(100), turn_id: codeText(100) }).optional(),
})
export type Thing = z.infer<typeof ThingSchema>

/** The text a part may be checked against: every fact the thing carries, as sentences. */
export function thingText(t: Thing): string {
  return [
    `${{ role: 'Role', company: 'Company', made: 'Made', chat: 'Chat', person: 'Person' }[t.kind]}: ${t.title}`,
    t.company && `Company: ${t.company}`,
    t.place && `Place: ${t.place}`,
    t.chance && `Chance: ${t.chance}`,
    t.pay && `Pay as stated: ${t.pay}`,
    t.posted && `Posted: ${t.posted}`,
    ...t.notes,
  ]
    .filter(Boolean)
    .join('. ')
}

/** A made thing (a draft, a comparison) as a thing: its title, and its text in `notes` for the answer check. */
export const madeThing = (id: string, title: string, notes: string[]): Thing => ({ kind: 'made', id, title, company: null, place: null, pay: null, chance: null, posted: null, notes })
