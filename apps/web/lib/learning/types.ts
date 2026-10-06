// What Cello has learned about a person, one mem0 memory per learning (agents-v3 5.3).
//
// The memory's text is the statement the person reads. Everything else lives in its
// metadata. `params` are chosen by code from the closed table in effects.ts and are read
// only by the code that applies an effect: they never reach a prompt, a screen or a model.

import { z } from 'zod'
import type { MemoryItem } from '../memory/types'

export const LEARNING_KINDS = ['taste', 'outcome', 'timing', 'resume', 'rejection', 'recruiter', 'writing', 'type', 'preference', 'earlier'] as const
export type LearningKind = (typeof LEARNING_KINDS)[number]

/** What a learning changes, by code only (blueprint 9). */
export const LEARNING_EFFECTS = [
  'rank.want',
  'rank.type',
  'type.synonym',
  'rank.fresh',
  'prepare.order',
  'resume.version',
  'chance.gap',
  'draft.style',
  'answer.ask',
  'search.propose',
  'nudge.rule',
  'none',
] as const
export type LearningEffect = (typeof LEARNING_EFFECTS)[number]

/** `active` acts, `proposed` waits for Keep, `off` is kept in the list and acts on nothing. */
export type LearningStatus = 'active' | 'proposed' | 'off'

const evidence = z.object({ table: z.string(), id: z.string() })

export const LearningMetaSchema = z.object({
  /** One memory per key, e.g. 'taste:blend', 'pass:relocation', 'earlier:<row id>'. */
  key: z.string().min(1).max(120),
  kind: z.enum(LEARNING_KINDS),
  effect: z.enum(LEARNING_EFFECTS),
  params: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  status: z.enum(['active', 'proposed', 'off']),
  /** code: counted by code. model: a read by a model step. person: the person's own words. */
  origin: z.enum(['code', 'model', 'person']),
  step: z.string().optional(),
  model: z.string().optional(),
  rung: z.string().optional(),
  /** A read's verbatim quote from its source, checked by code before it is stored. */
  quote: z.string().optional(),
  evidence: z.array(evidence).max(50).default([]),
  n: z.number().int().default(0),
  updated_at: z.string(),
})
export type LearningMeta = z.infer<typeof LearningMetaSchema>

export interface Learning extends LearningMeta {
  id: string
  /** The sentence the person reads. Code builds it for counts. */
  statement: string
}

/** The mem0 metadata tag that marks a memory as a learning (other memories live in the same collection). */
export const LEARNING_SCOPE = 'learning'

/** A learning from a stored memory, or null when the memory is not one (or its metadata is malformed). */
export function toLearning(item: MemoryItem): Learning | null {
  if (item.metadata?.scope !== LEARNING_SCOPE) return null
  const parsed = LearningMetaSchema.safeParse(item.metadata)
  return parsed.success ? { ...parsed.data, id: item.id, statement: item.memory } : null
}
