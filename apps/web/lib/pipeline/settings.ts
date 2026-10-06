// What the person decided about how much Cello does on its own: profiles.preferences.pipeline. This
// file only reads it. Writing stays with K10's set_autonomy() (autonomy.update), which a trigger
// enforces, so no client turns Send for me on by writing the column. A value that is missing or
// invalid reads as its default, so a bad stored value never turns something on.

import { z } from 'zod'

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const perDay = z.number().int().min(1).max(10)

const WantSchema = z.object({
  /** Who decides what Cello prepares: the person (Apply), or the person's rule as well. */
  mode: z.enum(['me', 'rule']).catch('me'),
  chance: z.array(z.enum(['strong', 'possible'])).min(1).catch(['strong']),
  watchedOnly: z.boolean().catch(true),
  maxPerDay: perDay.catch(3),
})

const SendSchema = z.object({
  /** Send for me. Off for everyone, locked off for demos. */
  mode: z.enum(['me', 'auto']).catch('me'),
  maxPerDay: perDay.catch(3),
  /** The one extension token that may send. */
  tokenId: z.string().uuid().optional().catch(undefined),
  agreedAt: z.string().optional().catch(undefined),
  agreedVersion: z.string().optional().catch(undefined),
})

const SettingsSchema = z.object({
  want: WantSchema.catch(WantSchema.parse({})),
  resumeApproval: z.boolean().catch(true),
  send: SendSchema.catch(SendSchema.parse({})),
  cover: z.enum(['when_asked', 'always', 'never']).catch('when_asked'),
  findContacts: z.boolean().catch(false),
  followUps: z.object({ afterDays: z.number().int().min(3).max(21).catch(7), on: z.boolean().catch(true) }).catch({ afterDays: 7, on: true }),
  summary: z.boolean().catch(false),
  morning: z
    .object({ pickAt: hhmm.catch('06:00'), summaryAt: hhmm.catch('08:00'), quietFrom: hhmm.catch('21:00'), quietTo: hhmm.catch('08:00') })
    .catch({ pickAt: '06:00', summaryAt: '08:00', quietFrom: '21:00', quietTo: '08:00' }),
  /** Set by Pause. Nothing is prepared or sent while it is. */
  pausedAt: z.string().nullable().catch(null),
})

export type PipelineSettings = z.infer<typeof SettingsSchema>

/** The settings of a profile's `preferences`, with a default for anything missing or invalid. */
export function readPipelineSettings(preferences: unknown): PipelineSettings {
  const p = (preferences as { pipeline?: Record<string, unknown> } | null | undefined)?.pipeline
  const o = p && typeof p === 'object' && !Array.isArray(p) ? p : {}
  // the stored key is paused_at, the setting is pausedAt
  return SettingsSchema.parse({ ...o, pausedAt: o.paused_at ?? null })
}

export const isPaused = (s: PipelineSettings): boolean => s.pausedAt !== null
