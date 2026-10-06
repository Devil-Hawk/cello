// What Your search may change in profiles.preferences.pipeline, and how a change merges into what is stored.
// set_autonomy() replaces the whole object, so every change starts from the stored one and touches only the keys
// it names: Send for me's token, the pause mark and anything a later package added are never dropped.

import { z } from 'zod'

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const perDay = z.number().int().min(1).max(10)

export const SEND_AGREED_VERSION = 'send-for-me-1'

export const PatchSchema = z.strictObject({
  /** Pick today's roles at, 05:00 to 10:00. */
  pickAt: hhmm.refine((t) => t >= '05:00' && t <= '10:00', 'Pick time is between 05:00 and 10:00.').optional(),
  quietFrom: hhmm.optional(),
  quietTo: hhmm.optional(),
  /** Applications a week the person aims for; null clears it. */
  weeklyPace: z.number().int().min(1).max(100).nullable().optional(),
  /** Prepare Strong picks each morning, within perDay. */
  prepareStrong: z.boolean().optional(),
  perDay: perDay.optional(),
  followUps: z.boolean().optional(),
  summary: z.boolean().optional(),
  resumeApproval: z.boolean().optional(),
  /** Send for me, from the extension's own browser. `agreed` is the person reading its sentence. */
  send: z.strictObject({ on: z.boolean(), perDay: perDay.optional(), agreed: z.boolean().optional() }).optional(),
})
export type Patch = z.infer<typeof PatchSchema>

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})

/** The stored object with the patch merged in. `tokenId` is the extension token Send for me binds to. */
export function applyPatch(stored: unknown, p: Patch, tokenId: string | null, now = new Date()): Obj {
  const out: Obj = { ...obj(stored) }
  const morning: Obj = { ...obj(out.morning) }
  if (p.pickAt !== undefined) morning.pickAt = p.pickAt
  if (p.quietFrom !== undefined) morning.quietFrom = p.quietFrom
  if (p.quietTo !== undefined) morning.quietTo = p.quietTo
  if (Object.keys(morning).length) out.morning = morning

  if (p.weeklyPace === null) delete out.weeklyPace
  else if (p.weeklyPace !== undefined) out.weeklyPace = p.weeklyPace

  if (p.prepareStrong !== undefined || p.perDay !== undefined) {
    const want: Obj = { ...obj(out.want) }
    if (p.prepareStrong !== undefined) {
      want.mode = p.prepareStrong ? 'rule' : 'me'
      if (p.prepareStrong) want.chance = ['strong']
    }
    if (p.perDay !== undefined) want.maxPerDay = p.perDay
    out.want = want
  }
  if (p.followUps !== undefined) out.followUps = { ...obj(out.followUps), on: p.followUps }
  if (p.summary !== undefined) out.summary = p.summary
  if (p.resumeApproval !== undefined) out.resumeApproval = p.resumeApproval

  if (p.send) {
    const send: Obj = { ...obj(out.send) }
    if (p.send.on) {
      if (!p.send.agreed) throw new Error('Read the sentence and agree before turning Send for me on.')
      if (!tokenId) throw new Error('Connect your extension first. Send for me runs from your own browser.')
      Object.assign(send, { mode: 'auto', tokenId, agreedAt: now.toISOString(), agreedVersion: SEND_AGREED_VERSION })
    } else send.mode = 'me'
    if (p.send.perDay !== undefined) send.maxPerDay = p.send.perDay
    out.send = send
  }
  return out
}
