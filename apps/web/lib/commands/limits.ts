// Limits per door (blueprint 5.1, the table under the registry). A command names
// a bucket; the door it came through decides the number. Chat is O, MCP is M,
// A2A is A, routines are S. A door with no entry for a bucket is not limited
// here: its own command or its own setting limits it. A limit of 0 means the
// door may not use that bucket at all, and runCommand refuses before counting.
//
// These are the numbers for a paid key, a credited free key or a model on this
// computer. A free key without credit uses lower caps (blueprint 11.3), applied
// by lib/models/caps.ts when the picked rung is R3.

import type { Door } from '@/lib/harness/types'

export interface Limit {
  limit: number
  windowSeconds: number
}

const TEN_MINUTES = 600
const DAY = 86_400

const BUCKETS = {
  /** Draft, revise, research and chance work, per 10 minutes. */
  heavy: { windowSeconds: TEN_MINUTES, perDoor: { chat: 4, assistant: 0, agent: 2 } },
  /** Drafts and revisions a day. The assistant's 10 are drafts saved. */
  drafts: { windowSeconds: DAY, perDoor: { chat: 20, assistant: 10, agent: 0 } },
  /** Research subjects a day. */
  research: { windowSeconds: DAY, perDoor: { chat: 8, assistant: 0, agent: 4, routine: 0 } },
  /** Roles whose chance is checked a day. The person's own door shares 60. */
  chance: { windowSeconds: DAY, perDoor: { session: 60, chat: 60, assistant: 0, agent: 0 } },
  /** Applications started a day. A rule's own setting limits R. */
  starts: { windowSeconds: DAY, perDoor: { chat: 10, assistant: 0, agent: 0 } },
  /** People lookups a day. */
  people: { windowSeconds: DAY, perDoor: { chat: 10, assistant: 0, agent: 0 } },
  /** Confirm cards Chat may put in front of the person. */
  confirm: { windowSeconds: DAY, perDoor: { chat: 10, assistant: 0, agent: 0 } },
  /** The search box and the web search tool: 12 a minute for the person. */
  search: { windowSeconds: 60, perDoor: { session: 12 } },
} as const satisfies Record<string, { windowSeconds: number; perDoor: Partial<Record<Door, number>> }>

export type Bucket = keyof typeof BUCKETS

export const BUCKET_NAMES = Object.keys(BUCKETS) as Bucket[]

/** The limit for this door in this bucket, or null when the door is not limited here. */
export function limitFor(bucket: string, door: Door): Limit | null {
  const spec = (BUCKETS as Record<string, { windowSeconds: number; perDoor: Partial<Record<Door, number>> }>)[bucket]
  if (!spec) throw new Error(`Unknown limit bucket "${bucket}"`)
  const limit = spec.perDoor[door]
  return limit === undefined ? null : { limit, windowSeconds: spec.windowSeconds }
}
